import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { limits } from './contract.js';
import type { ChangeMap, Entry, FileSymbol, Flow, Step } from './contract.js';
import type { DiffFile } from './diff.js';

/*
 * Static flow tracing for TypeScript projects. A module is `src/<name>/index.ts`
 * (its public Interface) plus everything else under `src/<name>/`. Starting from
 * each changed function inside a module, callers are followed with TypeScript
 * references, bridging three gaps a plain reference search cannot cross:
 *   - the module Interface (a caller outside the module),
 *   - a local HTTP hop: a route guarded by `… === '/api/…'` and the client code
 *     that sends that path (or a command object with the guarded `kind`),
 *   - a JSX prop callback: `<Child onSubmit={…}>` runs where Child calls `onSubmit`.
 * Paths stop at callbacks that start work (`useInput`, `useEffect`, `createServer`).
 * Dynamic dispatch, event emitters and other languages are not followed.
 */

const ENTRY_CALLEES = new Set(['useInput', 'useEffect', 'createServer']);
// Comparisons a person triggers: an Ink key, a typed command, a command kind, a DOM key.
const TRIGGER_SUBJECT =
  /^(input(\.toLowerCase\(\))?|key\.(return|tab|escape|upArrow|downArrow|leftArrow|rightArrow)|name|command\.kind|event\.key)$/;
const MAX_DEPTH = 14;
const BELOW_DEPTH = 3;

type Analysis = Pick<
  ChangeMap,
  'analysis' | 'interfaces' | 'flows' | 'otherChanges'
> & {
  symbols: Map<string, FileSymbol[]>;
  truncated: boolean;
};
type CallbackEntry = Readonly<
  | { kind: 'callback'; label: string }
  | {
      kind: 'jsx';
      label: string;
      tag: ts.JsxTagNameExpression;
      attribute: string;
    }
>;
type Unit = Readonly<{
  id: string;
  file: string;
  name: string;
  node: ts.SignatureDeclaration;
  nameNode: ts.Node | undefined;
  entry: CallbackEntry | undefined;
  startLine: number;
  endLine: number;
}>;
type Tag = Readonly<{ subject: string; value: string }>;
type Guard = Readonly<{ paths: readonly string[]; tags: readonly Tag[] }>;
/** One function on a path. `via` labels the edge down to the previous (callee) hop. */
type Hop = Readonly<{ unit: Unit; guard: Guard; via: string | undefined }>;
const NO_GUARD: Guard = { paths: [], tags: [] };

const filesOnly = (reason: string): Analysis => ({
  analysis: { kind: 'files-only', reason },
  symbols: new Map(),
  interfaces: [],
  flows: [],
  otherChanges: [],
  truncated: false,
});
const isTest = (file: string) =>
  /(^|\/)(test|tests|__tests__)\//.test(file) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
const isFunctionLike = (node: ts.Node): node is ts.SignatureDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node);

function nameNodeOf(node: ts.Node): ts.Node | undefined {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
    node.name
  )
    return node.name;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
      return parent.name;
    if (ts.isPropertyAssignment(parent)) return parent.name;
  }
  return undefined;
}

function entryOf(node: ts.Node, sf: ts.SourceFile): CallbackEntry | undefined {
  if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node)))
    return undefined;
  const parent = node.parent;
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.some((arg) => arg === node)
  ) {
    const callee = parent.expression.getText(sf);
    return ENTRY_CALLEES.has(callee)
      ? { kind: 'callback', label: callee }
      : undefined;
  }
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
    const element = parent.parent.parent.parent;
    if (!ts.isJsxOpeningLikeElement(element)) return undefined;
    const attribute = parent.parent.name.getText(sf);
    return {
      kind: 'jsx',
      label: `<${element.tagName.getText(sf)}> ${attribute}`,
      tag: element.tagName,
      attribute,
    };
  }
  return undefined;
}

function comparisons(expression: ts.Expression): Tag[] {
  const found: Tag[] = [];
  const sf = expression.getSourceFile();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      if (ts.isStringLiteralLike(node.right))
        found.push({ subject: node.left.getText(sf), value: node.right.text });
      else if (ts.isStringLiteralLike(node.left))
        found.push({ subject: node.right.getText(sf), value: node.left.text });
      return;
    }
    // Ink reports special keys as booleans: `if (key.return)`.
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(sf) === 'key'
    )
      found.push({ subject: `key.${node.name.text}`, value: node.name.text });
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found.filter((tag) => !/\.method$/.test(tag.subject));
}
const returns = (statement: ts.Statement) =>
  ts.isReturnStatement(statement) ||
  (ts.isBlock(statement) && statement.statements.some(ts.isReturnStatement));

/** String comparisons that must hold for `reference` to run inside `stop`. */
function guardBetween(reference: ts.Node, stop: ts.Node): Guard {
  const positive: Tag[][] = [];
  const negative = new Set<string>();
  const negate = (tags: Tag[]) =>
    tags.forEach((tag) => negative.add(tag.value));
  let child = reference;
  for (
    let node = reference.parent;
    node && node !== stop;
    child = node, node = node.parent
  ) {
    if (ts.isIfStatement(node)) {
      if (child === node.thenStatement)
        positive.push(comparisons(node.expression));
      else if (child === node.elseStatement)
        negate(comparisons(node.expression));
    } else if (ts.isConditionalExpression(node)) {
      if (child === node.whenTrue) positive.push(comparisons(node.condition));
      else if (child === node.whenFalse) negate(comparisons(node.condition));
    } else if (ts.isBlock(node)) {
      // `if (x === 'a') return …;` before this statement means x is not 'a' here.
      for (const statement of node.statements) {
        if (statement === child) break;
        if (
          ts.isIfStatement(statement) &&
          !statement.elseStatement &&
          returns(statement.thenStatement)
        )
          negate(comparisons(statement.expression));
      }
    }
  }
  let paths: string[] | undefined;
  for (const set of positive.reverse()) {
    const api = set
      .map((tag) => tag.value)
      .filter((value) => value.startsWith('/api/'));
    if (api.length)
      paths = paths ? paths.filter((value) => api.includes(value)) : api;
  }
  const tags = positive
    .flat()
    .filter(
      (tag) => !tag.value.startsWith('/api/') && !negative.has(tag.value),
    );
  return {
    paths: (paths ?? []).filter((value) => !negative.has(value)),
    tags: tags.filter(
      (tag, i) => tags.findIndex((other) => other.value === tag.value) === i,
    ),
  };
}

/* ---------- Interface comparison: exported names and members, base vs now ---------- */
function exportedShapes(text: string): Map<string, string> {
  const sf = ts.createSourceFile(
    'index.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const shapes = new Map<string, string>();
  const textOf = (node: ts.Node) => node.getText(sf).replace(/\s+/g, ' ');
  const withDoc = (node: ts.Node) =>
    `${ts
      .getJSDocCommentsAndTags(node)
      .map((doc) => doc.getText(sf))
      .join(' ')} ${textOf(node)}`.replace(/\s+/g, ' ');
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
  const members = (owner: string, type: ts.Node | undefined) => {
    let literal = type;
    while (
      literal &&
      ts.isTypeReferenceNode(literal) &&
      literal.typeArguments?.length === 1
    )
      literal = literal.typeArguments[0];
    const list =
      literal && ts.isTypeLiteralNode(literal) ? literal.members : undefined;
    for (const member of list ?? [])
      if (member.name)
        shapes.set(`${owner}.${member.name.getText(sf)}`, withDoc(member));
  };
  for (const statement of sf.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const from = statement.moduleSpecifier
        ? ` from ${textOf(statement.moduleSpecifier)}`
        : '';
      for (const element of statement.exportClause.elements)
        shapes.set(
          element.name.text,
          `${statement.isTypeOnly || element.isTypeOnly ? 'type ' : ''}${textOf(element)}${from}`,
        );
    } else if (exported(statement)) {
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          shapes.set(declaration.name.getText(sf), withDoc(statement));
      else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name
      )
        shapes.set(statement.name.text, withDoc(statement));
      else if (ts.isInterfaceDeclaration(statement)) {
        const heritage = statement.heritageClauses?.map(textOf).join(' ') ?? '';
        shapes.set(
          statement.name.text,
          `interface ${statement.name.text} ${heritage}`,
        );
        for (const member of statement.members)
          if (member.name)
            shapes.set(
              `${statement.name.text}.${member.name.getText(sf)}`,
              withDoc(member),
            );
      } else if (ts.isTypeAliasDeclaration(statement)) {
        shapes.set(statement.name.text, withDoc(statement));
        members(statement.name.text, statement.type);
      }
    }
  }
  return shapes;
}

/**
 * Functions, Interface changes and flows for a TypeScript checkout. Reads source
 * files only; the TypeScript compiler never executes project code.
 */
export async function analyze(
  root: string,
  files: readonly DiffFile[],
  readBase: (path: string) => Promise<string | undefined>,
): Promise<Analysis> {
  const configPath = join(root, 'tsconfig.json');
  if (!ts.sys.fileExists(configPath))
    return filesOnly('No tsconfig.json at the project root');
  let configError: string | undefined;
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        configError = ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          ' ',
        );
      },
    },
  );
  if (!config)
    return filesOnly(
      `tsconfig.json could not be read: ${configError ?? 'unknown error'}`.slice(
        0,
        400,
      ),
    );
  const inside = config.fileNames.filter(
    (file) => !relative(root, file).startsWith('..'),
  );
  if (inside.length === 0)
    return filesOnly(
      'tsconfig.json includes no TypeScript files in this checkout',
    );
  if (inside.length > limits.programFiles)
    return filesOnly(
      `More than ${limits.programFiles} TypeScript files; only files and hunks are shown`,
    );

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => inside,
    getScriptVersion: () => '1',
    getScriptSnapshot: (file) =>
      ts.sys.fileExists(file)
        ? ts.ScriptSnapshot.fromString(readFileSync(file, 'utf8'))
        : undefined,
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({ ...config.options, noEmit: true }),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = service.getProgram();
  if (!program) return filesOnly('TypeScript could not build this project');
  const checker = program.getTypeChecker();
  const rel = (file: string) => relative(root, file).split(sep).join('/');
  const lineOf = (sf: ts.SourceFile, pos: number) =>
    sf.getLineAndCharacterOfPosition(pos).line + 1;
  const sources = program
    .getSourceFiles()
    .filter(
      (sf) => !rel(sf.fileName).startsWith('..') && !sf.isDeclarationFile,
    );
  const hasSrc = sources.some((sf) => rel(sf.fileName).startsWith('src/'));
  const isProduct = (file: string) =>
    !isTest(file) && (!hasSrc || file.startsWith('src/'));
  const modules = new Map<string, string>();
  for (const sf of sources) {
    const match = /^src\/([^/]+)\/index\.tsx?$/.exec(rel(sf.fileName));
    if (match?.[1]) modules.set(match[1], rel(sf.fileName));
  }
  const moduleOf = (file: string) => {
    const name = /^src\/([^/]+)\//.exec(file)?.[1];
    return name && modules.has(name) ? name : undefined;
  };
  let truncated = false;

  /* ---------- Units ---------- */
  const units = new Map<ts.Node, Unit>();
  const unitOf = (node: ts.SignatureDeclaration): Unit => {
    const existing = units.get(node);
    if (existing) return existing;
    const sf = node.getSourceFile();
    const nameNode = nameNodeOf(node);
    const entry = entryOf(node, sf);
    const own = nameNode?.getText(sf) ?? entry?.label ?? '(anonymous)';
    let outer: string | undefined;
    for (let parent = node.parent; parent; parent = parent.parent) {
      const parentName = isFunctionLike(parent)
        ? nameNodeOf(parent)?.getText(sf)
        : undefined;
      if (parentName) outer = parentName;
    }
    const unit: Unit = {
      id: `${rel(sf.fileName)}:${node.getStart(sf)}`,
      file: rel(sf.fileName),
      name: outer && outer !== own ? `${outer} › ${own}` : own,
      node,
      nameNode,
      entry,
      startLine: lineOf(sf, node.getStart(sf)),
      endLine: lineOf(sf, node.getEnd()),
    };
    units.set(node, unit);
    return unit;
  };
  /** Innermost function that is named or starts work; anonymous helpers belong to their owner. */
  const owningUnit = (node: ts.Node): Unit | undefined => {
    const sf = node.getSourceFile();
    for (
      let current: ts.Node | undefined = node;
      current;
      current = current.parent
    )
      if (
        isFunctionLike(current) &&
        (nameNodeOf(current) || entryOf(current, sf))
      )
        return unitOf(current);
    return undefined;
  };
  const nodeAt = (sf: ts.SourceFile, pos: number): ts.Node => {
    let found: ts.Node = sf;
    const visit = (node: ts.Node): void => {
      if (pos >= node.getStart(sf) && pos < node.getEnd()) {
        found = node;
        ts.forEachChild(node, visit);
      }
    };
    ts.forEachChild(sf, visit);
    return found;
  };

  /* ---------- Changed symbols per file, and changed functions ---------- */
  const symbols = new Map<string, FileSymbol[]>();
  const changes = new Map<
    string,
    { unit: Unit; plus: number; minus: number }
  >();
  for (const file of files) {
    const sf = program.getSourceFile(join(root, file.path));
    if (!sf || file.status === 'deleted') continue;
    type Declaration = {
      name: string;
      kind: FileSymbol['kind'];
      start: number;
      end: number;
      unit?: Unit;
    };
    const declarations: Declaration[] = [];
    const describe = (
      node: ts.Node,
    ): { name: string; kind: FileSymbol['kind']; unit?: Unit } | undefined => {
      if (isFunctionLike(node) && (nameNodeOf(node) || entryOf(node, sf))) {
        const unit = unitOf(node);
        const kind = unit.entry
          ? 'callback'
          : ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node.parent)
            ? 'method'
            : 'function';
        return { name: unit.name.split(' › ').at(-1) ?? unit.name, kind, unit };
      }
      if (ts.isClassDeclaration(node) && node.name)
        return { name: node.name.text, kind: 'class' };
      if (ts.isInterfaceDeclaration(node))
        return { name: node.name.text, kind: 'interface' };
      if (ts.isTypeAliasDeclaration(node))
        return { name: node.name.text, kind: 'type' };
      if (ts.isMethodSignature(node) || ts.isPropertySignature(node))
        return { name: node.name.getText(sf), kind: 'method' };
      if (
        ts.isVariableDeclaration(node) &&
        ts.isVariableStatement(node.parent.parent) &&
        ts.isSourceFile(node.parent.parent.parent)
      )
        return { name: node.name.getText(sf), kind: 'const' };
      if (ts.isExportDeclaration(node))
        return { name: 'export', kind: 'export' };
      return undefined;
    };
    const visit = (node: ts.Node, outer: string | undefined): void => {
      const found = describe(node);
      if (found)
        declarations.push({
          name:
            outer && outer !== found.name
              ? `${outer} › ${found.name}`
              : found.name,
          kind: found.kind,
          start: lineOf(sf, node.getStart(sf, true)),
          end: lineOf(sf, node.getEnd()),
          ...(found.unit ? { unit: found.unit } : {}),
        });
      ts.forEachChild(node, (child) => visit(child, outer ?? found?.name));
    };
    visit(sf, undefined);
    const owner = (line: number) =>
      declarations
        .filter((d) => d.start <= line && line <= d.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    const found = new Map<string, FileSymbol>();
    const lastLine = sf.getLineStarts().length;
    for (const [field, list] of [
      ['plus', file.lines.plus],
      ['minus', file.lines.minus],
    ] as const)
      for (const line of list) {
        const declaration = owner(Math.min(line, lastLine));
        if (!declaration) continue;
        const key = `${declaration.name}:${declaration.start}`;
        const symbol = found.get(key) ?? {
          name: declaration.name,
          kind: declaration.kind,
          line: declaration.start,
          endLine: declaration.end,
          plus: 0,
          minus: 0,
        };
        symbol[field]++;
        found.set(key, symbol);
        // Flows count changes on the innermost function, not on types or constants.
        const unitOwner = declarations
          .filter((d) => d.unit && d.start <= line && line <= d.end)
          .sort((a, b) => a.end - a.start - (b.end - b.start))[0]?.unit;
        if (unitOwner) {
          const change = changes.get(unitOwner.id) ?? {
            unit: unitOwner,
            plus: 0,
            minus: 0,
          };
          change[field]++;
          changes.set(unitOwner.id, change);
        }
      }
    symbols.set(
      file.path,
      [...found.values()].sort((a, b) => a.line - b.line).slice(0, 500),
    );
  }

  /* ---------- Interface changes ---------- */
  const interfaces: ChangeMap['interfaces'] = [];
  for (const [module, file] of modules) {
    if (!files.some((changed) => changed.path === file)) continue;
    const before = exportedShapes((await readBase(file)) ?? '');
    const after = exportedShapes(readFileSync(join(root, file), 'utf8'));
    const added = [...after.keys()].filter((name) => !before.has(name));
    const removed = [...before.keys()].filter((name) => !after.has(name));
    const changed = [...after.keys()].filter(
      (name) => before.has(name) && before.get(name) !== after.get(name),
    );
    if (added.length || removed.length || changed.length)
      interfaces.push({
        module,
        file,
        added: added.slice(0, 200),
        removed: removed.slice(0, 200),
        changed: changed.slice(0, 200),
      });
  }

  /* ---------- Callers ---------- */
  let lookups = 0;
  const callerCache = new Map<string, Hop[]>();
  const callers = (unit: Unit): Hop[] => {
    const cached = callerCache.get(unit.id);
    if (cached) return cached;
    if (++lookups > limits.referenceLookups) {
      truncated = true;
      return [];
    }
    const found: Hop[] = [];
    const seen = new Set<string>();
    const sf = unit.node.getSourceFile();
    const references = unit.nameNode
      ? (service.findReferences(sf.fileName, unit.nameNode.getStart(sf)) ?? [])
      : [];
    for (const group of references)
      for (const reference of group.references) {
        if (reference.isDefinition) continue;
        const refFile = program.getSourceFile(reference.fileName);
        if (!refFile || !isProduct(rel(refFile.fileName))) continue;
        const node = nodeAt(refFile, reference.textSpan.start);
        // Imports, re-exports and Interface signatures declare; they do not call.
        if (
          ts.findAncestor(
            node,
            (n) =>
              ts.isImportDeclaration(n) ||
              ts.isExportDeclaration(n) ||
              ts.isInterfaceDeclaration(n) ||
              ts.isTypeAliasDeclaration(n),
          ) ||
          // Rendering a component is not a user action; flows start inside it.
          (ts.isJsxOpeningLikeElement(node.parent) &&
            node.parent.tagName === node) ||
          ts.isJsxClosingElement(node.parent)
        )
          continue;
        const owner = owningUnit(node);
        if (!owner || owner.id === unit.id) continue;
        const guard = guardBetween(node, owner.node);
        const calleeModule = moduleOf(unit.file);
        const via =
          calleeModule && moduleOf(owner.file) !== calleeModule
            ? `${calleeModule} Interface`
            : undefined;
        const key = `${owner.id}|${guard.paths.join()}|${guard.tags.map((tag) => tag.value).join()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ unit: owner, guard, via });
      }
    callerCache.set(unit.id, found);
    return found;
  };

  const senderFiles = sources.filter(
    (sf) => isProduct(rel(sf.fileName)) && !moduleOf(rel(sf.fileName)),
  );
  const kindOf = (guard: Guard) =>
    guard.tags
      .filter((tag) => /\.kind$/.test(tag.subject))
      .map((tag) => tag.value);
  let kindDispatched: Set<string> | undefined;
  /** Endpoints whose branches compare `….kind`; their senders are told apart by kind only. */
  const dispatchedByKind = (path: string): boolean => {
    if (!kindDispatched) {
      const paths = new Set<string>();
      for (const sf of senderFiles) {
        const visit = (node: ts.Node): void => {
          if (
            ts.isIfStatement(node) &&
            comparisons(node.expression).some((tag) =>
              /\.kind$/.test(tag.subject),
            )
          ) {
            const owner = owningUnit(node);
            if (owner)
              guardBetween(node.thenStatement, owner.node).paths.forEach(
                (value) => paths.add(value),
              );
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
      kindDispatched = paths;
    }
    return kindDispatched.has(path);
  };
  const compared = (literal: ts.Node) =>
    ts.isBinaryExpression(literal.parent) &&
    [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
    ].includes(literal.parent.operatorToken.kind);
  /** The local HTTP hop: a route guarded by `/api/…` is called by client code that sends it. */
  const httpCallers = (guard: Guard): Hop[] => {
    const [path] = guard.paths;
    if (guard.paths.length !== 1 || !path) return [];
    // A branch selected some other way (`'field' in command`) has no static sender.
    const kinds = kindOf(guard);
    if (kinds.length === 0 && dispatchedByKind(path)) return [];
    const found: Hop[] = [];
    for (const sf of senderFiles) {
      const visit = (node: ts.Node): void => {
        if (
          (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) &&
          !compared(node)
        ) {
          // A command object passed to a call; schemas (`z.…`) and state setters (`setMode`) are not sends.
          const call = ts.isPropertyAssignment(node.parent)
            ? node.parent.parent.parent
            : undefined;
          const byKind =
            kinds.includes(node.text) &&
            ts.isPropertyAssignment(node.parent) &&
            node.parent.name.getText(sf) === 'kind' &&
            call !== undefined &&
            ts.isCallExpression(call) &&
            !/^(z\.|set[A-Z])/.test(call.expression.getText(sf));
          const byPath =
            kinds.length === 0 &&
            (node.text === path || node.text.startsWith(`${path}?`));
          const owner = byKind || byPath ? owningUnit(node) : undefined;
          if (owner)
            found.push({
              unit: owner,
              guard: guardBetween(node, owner.node),
              via: `HTTP ${path}${byKind ? ` · ${node.text}` : ''}`,
            });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return found;
  };
  /** `<Child onSubmit={…}>`: the callback runs where Child calls its `onSubmit` prop. */
  const propCallers = (
    entry: Extract<CallbackEntry, { kind: 'jsx' }>,
  ): Hop[] => {
    let symbol = checker.getSymbolAtLocation(entry.tag);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = checker.getAliasedSymbol(symbol);
    const component = symbol?.declarations?.find(isFunctionLike);
    if (!component) return [];
    const found: Hop[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : undefined;
        const owner = name === entry.attribute ? owningUnit(node) : undefined;
        if (owner)
          found.push({
            unit: owner,
            guard: guardBetween(node, owner.node),
            via: `prop ${entry.attribute}`,
          });
      }
      ts.forEachChild(node, visit);
    };
    visit(component);
    return found;
  };
  const next = (hop: Hop): Hop[] => {
    if (hop.guard.paths.length) return httpCallers(hop.guard);
    if (hop.unit.entry?.kind === 'jsx') return propCallers(hop.unit.entry);
    if (hop.unit.entry) return [];
    return callers(hop.unit);
  };

  /* ---------- Shortest path from each module change to each entry ---------- */
  const operationOf = (path: readonly Hop[]) =>
    path.find((hop) => hop.via?.startsWith('HTTP '))?.via;
  const seeds = [...changes.values()].filter(
    (change) =>
      moduleOf(change.unit.file) &&
      change.unit.file !== modules.get(moduleOf(change.unit.file) ?? ''),
  );
  if (seeds.length > limits.seeds) truncated = true;
  const paths: Hop[][] = [];
  for (const seed of seeds.slice(0, limits.seeds)) {
    // Breadth-first: the first path to reach a function under one guard is the shortest.
    const visited = new Set<string>();
    let queue: Hop[][] = [
      [{ unit: seed.unit, guard: NO_GUARD, via: undefined }],
    ];
    while (queue.length) {
      const following: Hop[][] = [];
      for (const path of queue) {
        const last = path.at(-1);
        if (!last) continue;
        const callersHere = path.length > MAX_DEPTH ? [] : next(last);
        if (!callersHere.length) paths.push(path);
        for (const caller of callersHere) {
          const guard = [
            ...caller.guard.paths,
            ...caller.guard.tags.map((tag) => tag.value),
          ].join();
          const key = `${caller.unit.id}|${guard}|${operationOf([...path, caller]) ?? ''}`;
          if (
            visited.has(key) ||
            path.some((hop) => hop.unit.id === caller.unit.id)
          )
            continue;
          visited.add(key);
          following.push([...path, caller]);
        }
      }
      queue = following;
    }
  }

  /* ---------- Flows: grouped by the operation that reaches a module ---------- */
  const tagsOf = (guard: Guard) =>
    guard.tags
      .filter((tag) => TRIGGER_SUBJECT.test(tag.subject))
      .map((tag) => tag.value);
  const stepOf = (hop: Hop, withTags = false): Step => ({
    name: hop.unit.name,
    file: hop.unit.file,
    line: hop.unit.startLine,
    changed: changes.has(hop.unit.id),
    tags: withTags ? tagsOf(hop.guard).slice(0, 16) : [],
  });
  const entryKind = (unit: Unit): Entry['kind'] => {
    if (unit.entry?.kind === 'callback')
      return unit.entry.label === 'useInput'
        ? 'key'
        : unit.entry.label === 'useEffect'
          ? 'effect'
          : 'server';
    if (unit.entry?.kind === 'jsx') return 'ui-event';
    if (unit.file.endsWith('.tsx') && /(^|› )[A-Z]\w*$/.test(unit.name))
      return 'component';
    if (/(^|› )main$/.test(unit.name)) return 'process-start';
    return 'no-static-caller';
  };
  // Short functions called from several places read as plumbing; members of a returned
  // object implement an Interface, however short, so they stay.
  const isHelper = (unit: Unit) => {
    const holder = ts.findAncestor(
      unit.node.parent,
      (node) => isFunctionLike(node) || ts.isObjectLiteralExpression(node),
    );
    const inObject =
      holder !== undefined && ts.isObjectLiteralExpression(holder);
    return (
      unit.endLine - unit.startLine < 12 &&
      callers(unit).length >= 2 &&
      !inObject
    );
  };
  type Tree = Map<string, { step: Step; gap: boolean; children: Tree }>;
  type Draft = {
    kind: Flow['kind'];
    operation: string;
    triggers: Map<string, { entry: Entry; chain: Step[] }>;
    server: Map<string, Step>;
    members: Map<string, { module: string; step: Step; tree: Tree }>;
    helpers: Set<string>;
  };
  const drafts = new Map<string, Draft>();
  const onFlows = new Set<string>();
  for (const path of paths) {
    // The topmost Interface crossing is where the caller enters the module.
    let crossing = -1;
    path.forEach((hop, i) => {
      if (hop.via?.endsWith(' Interface')) crossing = i;
    });
    const member = path[crossing - 1];
    const crossed = path[crossing];
    const top = path.at(-1);
    if (crossing < 0 || !member || !crossed || !top) continue;
    path.forEach((hop) => onFlows.add(hop.unit.id));
    const httpIndex = path.findIndex((hop) => hop.via?.startsWith('HTTP '));
    const [unresolvedPath] = top.guard.paths;
    const kind: Flow['kind'] =
      httpIndex >= 0 ? 'http' : unresolvedPath ? 'unresolved' : 'direct';
    const operation =
      httpIndex >= 0
        ? (path[httpIndex]?.via ?? '')
        : unresolvedPath
          ? `HTTP ${unresolvedPath} · sender not found statically`
          : `direct call · ${top.unit.file}`;
    const draft = drafts.get(operation) ?? {
      kind,
      operation,
      triggers: new Map(),
      server: new Map(),
      members: new Map(),
      helpers: new Set(),
    };
    drafts.set(operation, draft);
    const client = path.slice(httpIndex >= 0 ? httpIndex : crossing).reverse();
    const chain = client.map((hop, i) => stepOf(hop, i === 0));
    // The same chain reached under different keys is one trigger listing every key.
    const triggerKey = chain
      .map((step) => `${step.file}:${step.line}`)
      .join('>');
    const existing = draft.triggers.get(triggerKey);
    const [first] = existing?.chain ?? [];
    if (existing && first && chain[0])
      first.tags = [...new Set([...first.tags, ...chain[0].tags])].slice(0, 16);
    else
      draft.triggers.set(triggerKey, {
        entry: { kind: entryKind(top.unit), label: top.unit.name },
        chain,
      });
    if (httpIndex >= 0)
      for (const hop of path.slice(crossing, httpIndex))
        draft.server.set(hop.unit.id, stepOf(hop));
    const module = (crossed.via ?? '').replace(/ Interface$/, '');
    const memberKey = `${module}|${member.unit.id}`;
    const entry = draft.members.get(memberKey) ?? {
      module,
      step: stepOf(member),
      tree: new Map(),
    };
    draft.members.set(memberKey, entry);
    // Only changed functions are drawn below the Interface; unchanged links become a gap.
    let tree = entry.tree;
    let gap = false;
    for (const hop of path.slice(0, crossing - 1).reverse()) {
      if (isHelper(hop.unit)) {
        draft.helpers.add(hop.unit.name);
        break;
      }
      if (!changes.has(hop.unit.id)) {
        gap = true;
        continue;
      }
      const key = `${gap ? '…' : ''}${hop.unit.id}`;
      const node = tree.get(key) ?? {
        step: stepOf(hop),
        gap,
        children: new Map(),
      };
      tree.set(key, node);
      tree = node.children;
      gap = false;
    }
  }
  const size = (tree: Tree): number =>
    [...tree.values()].reduce((n, node) => n + 1 + size(node.children), 0);
  const flatten = (tree: Tree, depth = 1): Flow['members'][number]['below'] =>
    [...tree.values()].flatMap((node) => [
      {
        step: node.step,
        depth,
        gap: node.gap,
        hidden: depth >= BELOW_DEPTH ? size(node.children) : 0,
      },
      ...(depth < BELOW_DEPTH ? flatten(node.children, depth + 1) : []),
    ]);
  const toFlow = (draft: Draft): Flow => {
    const triggers = [...draft.triggers.values()].sort(
      (a, b) => a.chain.length - b.chain.length,
    );
    return {
      kind: draft.kind,
      operation: draft.operation.slice(0, 400),
      triggers: triggers.slice(0, limits.triggers),
      moreTriggers: Math.max(0, triggers.length - limits.triggers),
      server: [...draft.server.values()].slice(0, 32),
      members: [...draft.members.values()].slice(0, 32).map((member) => ({
        module: member.module,
        step: member.step,
        below: flatten(member.tree).slice(0, 200),
      })),
      helpers: [...draft.helpers].slice(0, 200),
    };
  };
  // Command kinds handled by the same server code are one flow: `… · new-session · start`.
  const merged = new Map<string, Flow>();
  for (const draft of drafts.values()) {
    const flow = toFlow(draft);
    const [route] = flow.operation.split(' · ');
    const shape = JSON.stringify([flow.kind, route, flow.server, flow.members]);
    const same = merged.get(shape);
    if (!same) {
      merged.set(shape, flow);
      continue;
    }
    const kinds = flow.operation.split(' · ').slice(1).join(' · ');
    same.operation = `${same.operation} · ${kinds}`.slice(0, 400);
    for (const trigger of flow.triggers)
      if (same.triggers.length < limits.triggers) same.triggers.push(trigger);
      else same.moreTriggers++;
    same.helpers = [...new Set([...same.helpers, ...flow.helpers])].slice(
      0,
      200,
    );
  }
  const order: Record<Flow['kind'], number> = {
    http: 0,
    unresolved: 1,
    direct: 2,
  };
  const flows = [...merged.values()].sort(
    (a, b) =>
      order[a.kind] - order[b.kind] || a.operation.localeCompare(b.operation),
  );
  if (flows.length > limits.flows) truncated = true;

  const otherChanges = [...changes.values()]
    .filter(
      (change) => !onFlows.has(change.unit.id) && isProduct(change.unit.file),
    )
    .map((change) => ({
      file: change.unit.file,
      name: change.unit.name,
      line: change.unit.startLine,
    }));
  return {
    analysis: {
      kind: 'typescript',
      interfaceModules: [...modules.keys()].sort().slice(0, 64),
    },
    symbols,
    interfaces,
    flows: flows.slice(0, limits.flows),
    otherChanges: otherChanges.slice(0, limits.otherChanges),
    truncated: truncated || otherChanges.length > limits.otherChanges,
  };
}

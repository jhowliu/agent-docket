import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { render } from 'ink-testing-library';
import { z } from 'zod';
import { changeMapSchema, describeChange } from '../src/delivery/index.js';
import type { ChangeMap } from '../src/delivery/index.js';
import type { Launch } from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import { WorkbenchApp } from '../src/app/tui-app.js';

const errorBody = z.object({ error: z.string() });
const git = (directory: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args],
    {
      encoding: 'utf8',
    },
  ).trim();
async function write(root: string, files: Readonly<Record<string, string>>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('Change map condition timed out');
}

/** A module with a public Interface, a route that uses it, a client that sends it and a key that starts it. */
const project = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
    },
    include: ['src/**/*.ts'],
  }),
  'src/store/index.ts': [
    'export interface Store {',
    '  save(name: string): string;',
    '}',
    "export { createStore } from './internal/store.js';",
    '',
  ].join('\n'),
  'src/store/internal/store.ts': [
    "import type { Store } from '../index.js';",
    'function normalize(name: string) {',
    '  return name.trim();',
    '}',
    'export function createStore(): Store {',
    '  return {',
    '    save(name) {',
    '      return normalize(name);',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n'),
  'src/app/server.ts': [
    "import { createStore } from '../store/index.js';",
    'const store = createStore();',
    'export function route(url: URL): string {',
    "  if (url.pathname === '/api/save') return store.save(url.searchParams.get('name') ?? '');",
    "  return '';",
    '}',
    '',
  ].join('\n'),
  'src/app/client.ts': [
    'export function save(send: (path: string) => string, name: string) {',
    "  return send('/api/save?' + new URLSearchParams({ name }));",
    '}',
    '',
  ].join('\n'),
  'src/app/keys.ts': [
    "import { save } from './client.js';",
    'declare function useInput(handler: (input: string) => void): void;',
    'export function screen(send: (path: string) => string) {',
    '  useInput((input) => {',
    "    if (input === 's') save(send, 'draft');",
    '  });',
    '}',
    '',
  ].join('\n'),
  'README.md': '# Store\n',
  '.gitignore': 'node_modules/\nlaunch-observed.json\n',
};
async function repository(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-change-map-'));
  await write(root, files);
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Workbench Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Initial project');
  return { root, base: git(root, 'rev-parse', 'HEAD') };
}
/** Edits below the Interface, a documented Interface member, a new export and an untracked file. */
async function change(root: string) {
  await write(root, {
    'src/store/internal/store.ts': project[
      'src/store/internal/store.ts'
    ].replace('return name.trim();', 'return name.trim().toLowerCase();'),
    'src/store/index.ts': project['src/store/index.ts']
      .replace(
        '  save(name',
        '  /** Names are stored in lower case. */\n  save(name',
      )
      .concat('export const storeVersion = 2;\n'),
    'src/app/extra.ts': 'export function banner() {\n  return "store";\n}\n',
    'README.md': '# Store\n\nSaves names.\n',
  });
}

test('a Change map traces a key press over HTTP and the module Interface down to the changed function', async (t) => {
  const { root, base } = await repository(project);
  t.after(() => rm(root, { recursive: true, force: true }));
  await change(root);
  const map = await describeChange({ directory: root, base });
  assert.deepEqual(changeMapSchema.parse(map), map);
  assert.equal(map.base, base);
  assert.deepEqual(map.truncated, []);
  assert.deepEqual(map.analysis, {
    kind: 'typescript',
    interfaceModules: ['store'],
  });

  const files = new Map(map.files.map((file) => [file.path, file]));
  assert.equal(
    files.get('src/app/extra.ts')?.status,
    'added',
    'untracked files are part of the working tree',
  );
  assert.equal(files.get('README.md')?.status, 'modified');
  assert.deepEqual(files.get('README.md')?.symbols, []);
  const internal = files.get('src/store/internal/store.ts');
  assert.ok(internal?.diff?.includes('+  return name.trim().toLowerCase();'));
  assert.deepEqual(
    internal?.symbols.map((symbol) => [symbol.name, symbol.plus, symbol.minus]),
    [['normalize', 1, 1]],
  );

  assert.deepEqual(map.interfaces, [
    {
      module: 'store',
      file: 'src/store/index.ts',
      added: ['storeVersion'],
      removed: [],
      changed: ['Store.save'],
    },
  ]);

  assert.equal(map.flows.length, 1);
  const [flow] = map.flows;
  assert.equal(flow?.kind, 'http');
  assert.equal(flow?.operation, 'HTTP /api/save');
  const trigger = flow?.triggers[0];
  assert.equal(trigger?.entry.kind, 'key');
  assert.deepEqual(
    trigger?.chain.map((step) => [step.name, step.tags]),
    [
      ['screen › useInput', ['s']],
      ['save', []],
    ],
  );
  assert.deepEqual(
    flow?.server.map((step) => step.name),
    ['route'],
  );
  assert.equal(flow?.members.length, 1);
  assert.equal(flow?.members[0]?.module, 'store');
  assert.equal(flow?.members[0]?.step.name, 'createStore › save');
  assert.deepEqual(
    flow?.members[0]?.below.map((item) => [
      item.step.name,
      item.step.changed,
      item.depth,
    ]),
    [['normalize', true, 1]],
  );
  assert.deepEqual(
    map.otherChanges.map((item) => item.name),
    ['banner'],
  );
});

test('a checkout without a root tsconfig gets files and hunks only', async (t) => {
  const { root, base } = await repository({
    'tool.py': 'print("a")\n',
    'notes.md': 'one\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, { 'tool.py': 'print("b")\n', 'new.txt': 'two\n' });
  const map = await describeChange({ directory: root, base });
  assert.deepEqual(map.analysis, {
    kind: 'files-only',
    reason: 'No tsconfig.json at the project root',
  });
  assert.deepEqual(
    map.files.map((file) => [file.path, file.status, file.plus, file.minus]),
    [
      ['new.txt', 'added', 1, 0],
      ['tool.py', 'modified', 1, 1],
    ],
  );
  assert.deepEqual([map.flows, map.interfaces, map.otherChanges], [[], [], []]);
});

test('oversized diffs are left out with a truncation marker while the rest of the map stays complete', async (t) => {
  const { root, base } = await repository(project);
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, {
    'data/large.txt': `${'x'.repeat(99)}\n`.repeat(3000),
    'README.md': '# Changed\n',
  });
  const map = await describeChange({ directory: root, base });
  const large = map.files.find((file) => file.path === 'data/large.txt');
  assert.equal(large?.diff, null);
  assert.equal(large?.plus, 3000);
  assert.ok(map.files.find((file) => file.path === 'README.md')?.diff);
  assert.deepEqual(map.truncated, ['diff']);
});

test('a Change map only reads the top of a checkout at a known commit', async (t) => {
  const { root, base } = await repository(project);
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    describeChange({ directory: 'relative/path', base }),
    /absolute/,
  );
  await assert.rejects(
    describeChange({ directory: root, base: 'HEAD; rm -rf /' }),
    /commit hash/,
  );
  await assert.rejects(
    describeChange({ directory: root, base: 'f'.repeat(40) }),
    /not a commit/,
  );
  await assert.rejects(
    describeChange({ directory: join(root, 'src'), base }),
    /top of its checkout/,
  );
  await assert.rejects(
    describeChange({ directory: join(root, 'missing'), base }),
    /unavailable/,
  );
  assert.equal(
    git(root, 'status', '--porcelain'),
    '',
    'reading never writes to the checkout',
  );
});

test('the service serves a Run’s Change map from its own worktree and the TUI opens it with m', async (t) => {
  const { root } = await repository(project);
  const runs = await mkdtemp(join(tmpdir(), 'workbench-change-map-runs-'));
  const launch = {
    provider: 'codex',
    source: { kind: 'directory', path: root },
    worker: {
      transport: 'local',
      workspaceRoot: runs,
      adapter: {
        file: process.execPath,
        args: [resolve('fixtures/local-agent.mjs')],
      },
    },
  } satisfies Launch;
  const origin = 'http://127.0.0.1:4179';
  const app = createWebWorkbench(origin, { launch });
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  const opened: string[] = [];
  let ui: ReturnType<typeof render> | undefined;
  t.after(async () => {
    ui?.unmount();
    ui?.cleanup();
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(runs, { recursive: true, force: true });
  });
  const page = await (await app.fetch(new Request(`${origin}/changes`))).text();
  const token = page.match(/name="workbench-token" content="([a-f0-9]+)"/)?.[1];
  assert.ok(token, 'the Change map page receives the session token');
  const changes = (
    query: string,
    headers: Record<string, string> = { 'x-workbench-token': token, origin },
  ) => app.fetch(new Request(`${origin}/api/changes?${query}`, { headers }));

  await client.connect();
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  let state = await client.poll();
  await until(async () => {
    state = await client.poll();
    return state.runs[0]?.state.kind === 'idle';
  });
  assert.equal(state.features?.changeMap, true);
  const run = state.runs[0];
  assert.ok(run?.worktree);
  await change(run.worktree.path);

  assert.equal((await changes(`runId=${run.id}`, {})).status, 403);
  assert.equal(
    (
      await changes(`runId=${run.id}`, {
        'x-workbench-token': token,
        origin: 'http://evil.test',
      })
    ).status,
    403,
  );
  assert.equal((await changes('runId=..%2Fetc')).status, 400);
  assert.equal(
    (await changes('runId=run-00000000-0000-4000-8000-000000000000')).status,
    404,
  );
  const [first, second] = await Promise.all([
    changes(`runId=${run.id}`),
    changes(`runId=${run.id}`),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const map: ChangeMap = changeMapSchema.parse(await first.json());
  assert.equal(map.base, run.worktree.baseRevision);
  assert.ok(map.files.some((file) => file.path === 'src/app/extra.ts'));
  assert.equal(map.flows[0]?.operation, 'HTTP /api/save');
  assert.equal(
    git(root, 'status', '--porcelain'),
    '',
    'the source checkout is never read or changed',
  );

  const url = client.changeMapUrl(run.id);
  assert.equal(url, `${origin}/changes?run=${run.id}`);
  ui = render(
    <WorkbenchApp
      client={client}
      initial={state}
      pollInterval={25}
      openUrl={(target) => opened.push(target)}
    />,
  );
  await until(() => !!ui?.lastFrame()?.includes('Idle'));
  ui.stdin.write('m');
  await until(() => opened.length === 1);
  assert.deepEqual(opened, [url]);
  await until(() => !!ui?.lastFrame()?.includes('Change map:'));

  // A finished turn points at the map; the Diff tab says it only lists reported edits.
  await client.command({ kind: 'prompt', runId: run.id, text: 'reply:done' });
  await until(
    () => !!ui?.lastFrame()?.includes('Turn finished · m see what changed'),
  );
  // The Diff tab reads the worktree itself: none of these edits were reported by the agent.
  ui.stdin.write('2');
  await until(
    () => !!ui?.lastFrame()?.includes('+  return name.trim().toLowerCase();'),
  );
  ui.stdin.write('g');
  await until(() => !!ui?.lastFrame()?.includes('Worktree vs'));
  assert.ok(ui.lastFrame()?.includes('README.md · +2 −0'), ui.lastFrame());

  const quick = await changes(`runId=${run.id}&files=only`);
  assert.equal(quick.status, 200);
  const files = changeMapSchema.parse(await quick.json());
  assert.deepEqual(files.analysis, {
    kind: 'files-only',
    reason: 'Analysis was not requested',
  });
  assert.deepEqual(
    [files.flows, files.files.flatMap((file) => file.symbols)],
    [[], []],
  );
  assert.equal(files.files.length, map.files.length);
  assert.equal((await changes(`runId=${run.id}&files=all`)).status, 400);

  // Once the worktree is committed and collected, the map points to the branch instead.
  await client.command({ kind: 'cancel', runId: run.id });
  await client.command({
    kind: 'commit-workspace',
    runId: run.id,
    message: 'Keep store edits',
  });
  await until(
    async () =>
      (await client.poll()).runs[0]?.worktree?.status.kind === 'removed',
  );
  const removed = await changes(`runId=${run.id}`);
  assert.equal(removed.status, 409);
  assert.match(
    errorBody.parse(await removed.json()).error,
    new RegExp(run.worktree.branch),
  );
});

test('a Run without a local worktree has no Change map', async (t) => {
  const origin = 'http://127.0.0.1:4178';
  const app = createWebWorkbench(origin);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  t.after(() => app.close());
  const page = await (await app.fetch(new Request(`${origin}/changes`))).text();
  const token = page.match(/name="workbench-token" content="([a-f0-9]+)"/)?.[1];
  assert.ok(token);
  await client.connect();
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  const response = await app.fetch(
    new Request(`${origin}/api/changes?runId=${started.runId}`, {
      headers: { 'x-workbench-token': token },
    }),
  );
  assert.equal(response.status, 409);
  assert.match(
    errorBody.parse(await response.json()).error,
    /local Git worktree/,
  );
  const opened: string[] = [];
  const state = await client.poll();
  const ui = render(
    <WorkbenchApp
      client={client}
      initial={state}
      pollInterval={25}
      openUrl={(target) => opened.push(target)}
    />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  ui.stdin.write('m');
  await until(() => !!ui.lastFrame()?.includes('local Git worktree'));
  assert.deepEqual(opened, []);
});

test('the Diff tab follows the selected Run and drops a late reply for the previous one', async (t) => {
  const { root } = await repository(project);
  const runs = await mkdtemp(join(tmpdir(), 'workbench-change-map-runs-'));
  const launch = {
    provider: 'codex',
    source: { kind: 'directory', path: root },
    worker: {
      transport: 'local',
      workspaceRoot: runs,
      adapter: {
        file: process.execPath,
        args: [resolve('fixtures/local-agent.mjs')],
      },
    },
  } satisfies Launch;
  const origin = 'http://127.0.0.1:4174';
  const app = createWebWorkbench(origin, { launch });
  // Hold the first Run's diff reply until the selection has moved on.
  let held: string | undefined;
  let release = () => {};
  const client = createWorkbenchClient(origin, async (request) => {
    const url = new URL(request.url);
    if (
      url.pathname === '/api/changes' &&
      url.searchParams.get('runId') === held
    )
      await new Promise<void>((done) => {
        release = done;
      });
    return app.fetch(request);
  });
  let ui: ReturnType<typeof render> | undefined;
  t.after(async () => {
    release();
    ui?.unmount();
    ui?.cleanup();
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(runs, { recursive: true, force: true });
  });
  await client.connect();
  await client.command({ kind: 'start' });
  await client.command({ kind: 'start' });
  let state = await client.poll();
  await until(async () => {
    state = await client.poll();
    return (
      state.runs.length === 2 &&
      state.runs.every((run) => run.state.kind === 'idle')
    );
  });
  const [first, second] = state.runs;
  assert.ok(first?.worktree && second?.worktree);
  await write(first.worktree.path, { 'only-first.txt': 'first\n' });
  await write(second.worktree.path, { 'only-second.txt': 'second\n' });
  held = first.id;
  ui = render(
    <WorkbenchApp client={client} initial={state} pollInterval={25} />,
  );
  await until(() => !!ui?.lastFrame()?.includes('Run 2'));
  ui.stdin.write('2');
  await until(() => !!ui?.lastFrame()?.includes('Reading worktree changes'));
  ui.stdin.write('j');
  await until(() => !!ui?.lastFrame()?.includes('only-second.txt'));
  release();
  await new Promise((done) => setTimeout(done, 300));
  const frame = ui.lastFrame() ?? '';
  assert.ok(frame.includes('only-second.txt'), frame);
  assert.ok(
    !frame.includes('only-first.txt'),
    'a late reply for the previous Run never replaces the current one',
  );
});

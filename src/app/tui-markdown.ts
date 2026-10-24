import stringWidth from 'string-width';
import { terminalText } from './tui-input.js';

/** A run of text in one style; the view maps it to Ink Text props. */
export type Span = Readonly<{
  text: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
}>;
type Style = Omit<Span, 'text'>;
type Align = 'left' | 'right' | 'center';

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text: string) =>
  Array.from(segments.segment(text), (part) => part.segment);
const widthOf = (spans: readonly Span[]) =>
  spans.reduce((total, span) => total + stringWidth(span.text), 0);
const sameStyle = (a: Span, b: Span) =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.dim === b.dim &&
  a.underline === b.underline &&
  a.strike === b.strike &&
  a.code === b.code;

/** The spans' text without styles. */
export const plainText = (spans: readonly Span[]) =>
  spans.map((span) => span.text).join('');

/**
 * Inline Markdown as styled spans: `**bold**`, `*italic*`, `~~strike~~`,
 * `` `code` ``, `[text](url)` and backslash escapes. Underscores are left
 * alone, since replies are full of snake_case names. Unclosed markers stay
 * as written.
 */
export function inlineSpans(text: string, style: Style = {}): Span[] {
  const spans: Span[] = [];
  let plain = '';
  const flush = () => {
    if (plain) spans.push({ ...style, text: plain });
    plain = '';
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    const rest = '\\`*~['.includes(char) ? text.slice(index) : '';
    let match: RegExpExecArray | null = null;
    if (rest && (match = /^\\([\\`*_{}[\]()#+\-.!|~>])/.exec(rest))) {
      plain += match[1];
    } else if (rest && (match = /^(`+)(.+?)\1(?!`)/.exec(rest))) {
      flush();
      spans.push({
        ...style,
        text: (match[2] ?? '').replace(/^ (.+) $/, '$1'),
        code: true,
      });
    } else if (rest && (match = /^\*\*(?=\S)(.*?\S)\*\*/.exec(rest))) {
      flush();
      spans.push(...inlineSpans(match[1] ?? '', { ...style, bold: true }));
    } else if (rest && (match = /^~~(?=\S)(.*?\S)~~/.exec(rest))) {
      flush();
      spans.push(...inlineSpans(match[1] ?? '', { ...style, strike: true }));
    } else if (
      rest &&
      (match = /^\*(?=[^\s*])(.*?[^\s*])\*(?!\*)/.exec(rest))
    ) {
      flush();
      spans.push(...inlineSpans(match[1] ?? '', { ...style, italic: true }));
    } else if (
      rest &&
      (match = /^\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/.exec(rest))
    ) {
      flush();
      const [, label = '', url = ''] = match;
      spans.push(...inlineSpans(label, { ...style, underline: true }));
      if (label !== url) spans.push({ ...style, text: ` (${url})`, dim: true });
    }
    if (match) index += match[0].length;
    else {
      plain += char;
      index += 1;
    }
  }
  flush();
  return spans;
}

/** Inline Markdown reduced to its words, for one-line previews. */
export const inlineText = (text: string) => plainText(inlineSpans(text));

/** Spaces, one wide grapheme (CJK breaks anywhere), or a run of narrow ones. */
function tokens(text: string): string[] {
  const result: string[] = [];
  let current = '';
  let kind: 'space' | 'word' | null = null;
  for (const grapheme of graphemes(text)) {
    const next = /^\s+$/.test(grapheme)
      ? 'space'
      : stringWidth(grapheme) > 1
        ? 'wide'
        : 'word';
    if (next === 'wide') {
      if (current) result.push(current);
      result.push(grapheme);
      current = '';
      kind = null;
    } else if (next === kind) current += grapheme;
    else {
      if (current) result.push(current);
      current = grapheme;
      kind = next;
    }
  }
  if (current) result.push(current);
  return result;
}

/**
 * Word-wraps spans to `width` cells. `first` prefixes the first line and
 * `rest` the others, so list items and quotes hang under their text.
 */
function wrap(
  spans: readonly Span[],
  width: number,
  first: readonly Span[] = [],
  rest: readonly Span[] = first,
): Span[][] {
  const lines: Span[][] = [];
  let line: Span[] = [...first];
  let used = widthOf(first);
  let fresh = true;
  let space: Span | null = null;
  const append = (span: Span) => {
    const last = line.at(-1);
    if (last && sameStyle(last, span))
      line[line.length - 1] = { ...last, text: last.text + span.text };
    else line.push(span);
    used += stringWidth(span.text);
    fresh = false;
  };
  const next = () => {
    lines.push(line);
    line = [...rest];
    used = widthOf(rest);
    fresh = true;
    space = null;
  };
  const room = () => Math.max(1, width - widthOf(rest));
  for (const span of spans)
    for (const token of tokens(span.text)) {
      if (/^\s+$/.test(token)) {
        if (!fresh) space = { ...span, text: token };
        continue;
      }
      const tokenWidth = stringWidth(token);
      const gap: Span | null = space;
      const gapWidth = gap ? stringWidth(gap.text) : 0;
      if (used + gapWidth + tokenWidth <= width) {
        if (gap) append(gap);
        space = null;
        append({ ...span, text: token });
      } else if (tokenWidth <= room()) {
        next();
        append({ ...span, text: token });
      } else {
        // Longer than a whole line, like a URL: break it by graphemes.
        if (!fresh) next();
        for (const grapheme of graphemes(token)) {
          if (used + stringWidth(grapheme) > width && !fresh) next();
          append({ ...span, text: grapheme });
        }
      }
    }
  if (!fresh || !lines.length) lines.push(line);
  return lines;
}

/** Splits a code line at `width` cells without reflowing it. */
function hardWrap(text: string, width: number): string[] {
  const parts: string[] = [];
  let part = '';
  for (const grapheme of graphemes(text)) {
    if (part && stringWidth(part + grapheme) > width) {
      parts.push(part);
      part = '';
    }
    part += grapheme;
  }
  return [...parts, part];
}

const cellsOf = (row: string) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
const isDivider = (row: string | undefined) =>
  row !== undefined && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(row);

/** A GFM table aligned in columns, or row by row when the pane is too narrow. */
function table(
  rows: readonly string[],
  aligns: readonly Align[],
  width: number,
): Span[][] {
  const cells = rows.map((row, index) =>
    cellsOf(row).map((cell) =>
      inlineSpans(cell, index === 0 ? { bold: true } : {}),
    ),
  );
  const columns = Math.max(...cells.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(1, ...cells.map((row) => widthOf(row[column] ?? []))),
  );
  const divider: Span = { text: ' │ ', dim: true };
  const total = widths.reduce((sum, cell) => sum + cell, 0) + 3 * columns - 3;
  const lines: Span[][] = [];
  if (total <= width) {
    for (const [index, row] of cells.entries()) {
      const line: Span[] = [];
      for (let column = 0; column < columns; column++) {
        const cell = row[column] ?? [];
        const pad = (widths[column] ?? 0) - widthOf(cell);
        const align = aligns[column] ?? 'left';
        const before =
          align === 'right' ? pad : align === 'center' ? pad >> 1 : 0;
        if (column) line.push(divider);
        if (before) line.push({ text: ' '.repeat(before) });
        line.push(...cell);
        if (pad - before && column < columns - 1)
          line.push({ text: ' '.repeat(pad - before) });
      }
      lines.push(line);
      if (index === 0)
        lines.push([
          {
            text: widths.map((cell) => '─'.repeat(cell)).join('─┼─'),
            dim: true,
          },
        ]);
    }
    return lines;
  }
  // Too wide: each row wraps on its own, its cells still apart.
  for (const [index, row] of cells.entries()) {
    lines.push(
      ...wrap(
        row.flatMap((cell, column) => (column ? [divider, ...cell] : cell)),
        width,
        [],
        [{ text: '  ' }],
      ),
    );
    if (index === 0)
      lines.push([{ text: '─'.repeat(Math.min(width, 40)), dim: true }]);
  }
  return lines;
}

/**
 * An agent's Markdown reply as terminal lines `width` cells wide: headings,
 * emphasis, inline and fenced code, lists, quotes, rules, links and tables.
 * Only the markup changes; the words and the agent's line breaks stay.
 */
export function markdownLines(source: string, width: number): Span[][] {
  const rows = terminalText(source)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .split('\n');
  const lines: Span[][] = [];
  let fence: string | null = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] ?? '';
    if (fence !== null) {
      if (row.trim().startsWith(fence)) fence = null;
      else
        // Indented on the code block's faint background, unlike a quote's bar.
        for (const part of hardWrap(row, Math.max(1, width - 2)))
          lines.push([{ text: '  ' }, { text: part || ' ', code: true }]);
      continue;
    }
    const opening = /^\s*(`{3,}|~{3,})/.exec(row);
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(row);
    const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(row);
    const quote = /^\s{0,3}>\s?(.*)$/.exec(row);
    if (opening) fence = opening[1] ?? '```';
    else if (!row.trim()) lines.push([]);
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(row))
      lines.push([{ text: '─'.repeat(width), dim: true }]);
    else if (heading)
      lines.push(...wrap(inlineSpans(heading[2] ?? '', { bold: true }), width));
    else if (row.includes('|') && isDivider(rows[index + 1])) {
      const aligns = cellsOf(rows[index + 1] ?? '').map(
        (cell): Align =>
          cell.startsWith(':') && cell.endsWith(':')
            ? 'center'
            : cell.endsWith(':')
              ? 'right'
              : 'left',
      );
      const body = [row];
      index += 2;
      while (index < rows.length && rows[index]?.includes('|'))
        body.push(rows[index++] ?? '');
      index -= 1;
      lines.push(...table(body, aligns, width));
    } else if (quote) {
      const bar: Span = { text: '│ ', dim: true };
      lines.push(
        ...wrap(inlineSpans(quote[1] ?? '', { dim: true }), width, [bar]),
      );
    } else if (item) {
      const [, indent = '', marker = '', text = ''] = item;
      const bullet = /^[-*+]$/.test(marker) ? '•' : marker;
      const lead = ' '.repeat(Math.min(indent.length, 8));
      lines.push(
        ...wrap(
          inlineSpans(text),
          width,
          [{ text: `${lead}${bullet} ` }],
          [{ text: ' '.repeat(stringWidth(`${lead}${bullet} `)) }],
        ),
      );
    } else {
      // The agent's own indentation stays, and wrapped lines keep it.
      const lead = /^\s*/.exec(row)?.[0] ?? '';
      const prefix = lead ? [{ text: lead.slice(0, width >> 1) }] : [];
      lines.push(...wrap(inlineSpans(row.trimStart()), width, prefix));
    }
  }
  return lines;
}

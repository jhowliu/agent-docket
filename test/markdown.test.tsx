import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {
  inlineSpans,
  inlineText,
  markdownLines,
  plainText,
} from '../src/app/tui-markdown.js';

const text = (source: string, width = 60) =>
  markdownLines(source, width).map(plainText);

test('inline Markdown becomes styles; unclosed markers and snake_case stay as written', () => {
  assert.deepEqual(inlineSpans('a **b *c* d** `d` ~~e~~ [f](https://g)'), [
    { text: 'a ' },
    { text: 'b ', bold: true },
    { text: 'c', bold: true, italic: true },
    { text: ' d', bold: true },
    { text: ' ' },
    { text: 'd', code: true },
    { text: ' ' },
    { text: 'e', strike: true },
    { text: ' ' },
    { text: 'f', underline: true },
    { text: ' (https://g)', dim: true },
  ]);
  // CJK bold closes after punctuation, as the author meant.
  assert.deepEqual(inlineSpans('**先確認爆率。**不足就補'), [
    { text: '先確認爆率。', bold: true },
    { text: '不足就補' },
  ]);
  assert.equal(
    inlineText('2 * 3 * 4, **open, my_var_name'),
    '2 * 3 * 4, **open, my_var_name',
  );
  assert.equal(inlineText('\\*literal\\*'), '*literal*');
});

test('blocks render without their markup and keep the words and line breaks', () => {
  const lines = text(
    [
      '### 我建議的提升順序',
      '',
      '1. **先確認**打目標怪時',
      '- item',
      '  - nested',
      '> quoted',
      '---',
      '```ts',
      'const  spaced = 1;',
      '```',
      'Done.',
    ].join('\n'),
    40,
  );
  assert.deepEqual(lines, [
    '我建議的提升順序',
    '',
    '1. 先確認打目標怪時',
    '• item',
    '  • nested',
    '│ quoted',
    '─'.repeat(40),
    '  const  spaced = 1;',
    'Done.',
  ]);
  const [heading] = markdownLines('## Title', 40);
  assert.deepEqual(heading, [{ text: 'Title', bold: true }]);
});

test('wrapped lines fit the width, hang under list text and keep code unreflowed', () => {
  const width = 24;
  const lines = text(
    `- ${'爆率穩定後總STR湊下一個整十'.repeat(3)}\n\`\`\`\n${'x'.repeat(30)}\n\`\`\``,
    width,
  );
  for (const line of lines) assert.ok(stringWidth(line) <= width, line);
  assert.match(lines[0] ?? '', /^• /);
  assert.match(lines[1] ?? '', /^ {2}\S/);
  assert.deepEqual(lines.slice(-2), [
    '  ' + 'x'.repeat(22),
    '  ' + 'x'.repeat(8),
  ]);
});

test('tables align their columns, or go row by row when the pane is narrow', () => {
  const source = [
    '| 武器 | ATK | 取得來源 |',
    '|---|---:|---|',
    '| 拳刃 `[3]` | 125 | 土撥鼠 |',
    '| 卡塔勒拳刃 | 148 | 沙漠之狼 |',
  ].join('\n');
  assert.deepEqual(text(source, 60), [
    '武器       │ ATK │ 取得來源',
    '───────────┼─────┼─────────',
    '拳刃 [3]   │ 125 │ 土撥鼠',
    '卡塔勒拳刃 │ 148 │ 沙漠之狼',
  ]);
  const [header] = markdownLines(source, 60);
  assert.equal(header?.[0]?.bold, true);
  const narrow = text(source, 16);
  for (const line of narrow) assert.ok(stringWidth(line) <= 16, line);
  assert.ok(narrow.join('\n').includes('沙漠之狼'), narrow.join('\n'));
});

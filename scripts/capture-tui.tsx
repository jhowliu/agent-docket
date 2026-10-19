import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { renderToString } from 'ink';
import stringWidth from 'string-width';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import { WorkbenchScreen } from '../src/app/tui-view.js';
import { PromptInput } from '../src/app/tui-input.js';

const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
function colorize(ansi: string): string {
  const colors: Readonly<Record<number, string>> = {
    30: '#10151c',
    31: '#f09aa3',
    32: '#93c7a3',
    33: '#efbd72',
    36: '#78d4df',
    37: '#d9e2ed',
    90: '#9aaabd',
  };
  let color = '#d9e2ed',
    bold = false,
    dim = false,
    inverse = false;
  let html = '';
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const expression = /\u001b\[([\d;]*)m/g;
  let cursor = 0;
  const append = (text: string) => {
    if (!text) return;
    const cells = Array.from(
      segments.segment(stripVTControlCharacters(text)),
      ({ segment }) =>
        segment === '\n'
          ? '\n'
          : `<span style="display:inline-block;width:${stringWidth(segment) * 8.5}px">${escape(segment)}</span>`,
    ).join('');
    html += `<span style="color:${inverse ? '#10151c' : dim ? '#9aaabd' : color};background:${inverse ? color : 'transparent'};font-weight:${bold ? 700 : 400}">${cells}</span>`;
  };
  for (const match of ansi.matchAll(expression)) {
    append(ansi.slice(cursor, match.index));
    for (const code of (match[1] || '0').split(';').map(Number)) {
      if (code === 0) {
        color = '#d9e2ed';
        bold = dim = inverse = false;
      } else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 7) inverse = true;
      else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 27) inverse = false;
      else if (code === 39) color = '#d9e2ed';
      else if (colors[code]) color = colors[code];
    }
    cursor = match.index + match[0].length;
  }
  append(ansi.slice(cursor));
  return html;
}
const origin = 'http://127.0.0.1:4177';
const app = createWebWorkbench(origin);
try {
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const one = await client.command({ kind: 'start' });
  const two = await client.command({ kind: 'start' });
  const three = await client.command({ kind: 'start' });
  if (!('runId' in one && 'runId' in two && 'runId' in three))
    throw new Error('Missing Run');
  await client.command({ kind: 'prompt', runId: one.runId, text: 'fix' });
  await client.command({ kind: 'prompt', runId: two.runId, text: 'fix' });
  const deadline = Date.now() + 6000;
  let state = await client.poll();
  while (
    state.attention.filter((item) => item.status === 'pending').length < 2
  ) {
    if (Date.now() > deadline)
      throw new Error('Fixture did not request permissions');
    await new Promise((done) => setTimeout(done, 20));
    state = await client.poll();
  }
  const decision = state.attention.find(
    (item) => item.runId === one.runId && item.status === 'pending',
  );
  const allow = decision?.choices.find(
    (choice) => choice.kind === 'allow-once',
  );
  if (!decision || !allow) throw new Error('Missing fixture decision');
  await client.command({ kind: 'answer', id: decision.id, choiceId: allow.id });
  while (
    !state.attention.some(
      (item) => item.id === decision.id && item.status === 'delivered',
    ) ||
    state.runs.find((run) => run.id === one.runId)?.state.kind !== 'idle'
  ) {
    if (Date.now() > deadline)
      throw new Error('Fixture response not delivered');
    await new Promise((done) => setTimeout(done, 20));
    state = await client.poll();
  }
  const directory = resolve('.impeccable/review/tui');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'browser-state.json'), JSON.stringify({ ...state, reset: true }));
  for (const [columns = 80, rows = 24] of [
    [120, 36],
    [80, 24],
    [60, 20],
  ]) {
    const composing = columns === 60;
    const selectedId = composing ? three.runId : two.runId;
    const output = renderToString(
      <WorkbenchScreen
        state={state}
        selectedId={selectedId}
        filter="active"
        view="timeline"
        offset={0}
        request={state.attention.find(
          (item) => item.runId === selectedId && item.status === 'pending',
        )}
        armed
        connected
        busy={false}
        note={composing ? 'Last message accepted' : 'Last response accepted'}
        project={composing}
        options={false}
        help={false}
        details={columns === 80}
        mode={composing ? 'reply' : 'normal'}
        columns={columns}
        rows={rows}
        input={
          composing ? (
            <PromptInput
              id="capture"
              active
              value="reply:sample draft jkar"
              width={columns - 3}
              onChange={() => {}}
              onSubmit={() => {}}
              onEscape={() => {}}
            />
          ) : undefined
        }
      />,
      { columns },
    );
    const name = `${columns}x${rows}`;
    await writeFile(resolve(directory, name + '.ansi'), output);
    await writeFile(
      resolve(directory, name + '.txt'),
      stripVTControlCharacters(output),
    );
    await writeFile(
      resolve(directory, name + '.html'),
      `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>Ink capture ${name}</title><style>body{margin:0;padding:24px;background:#10151c;color:#d9e2ed}pre{margin:0;font:14px/20px Menlo,Monaco,monospace;white-space:pre}p{font:12px/20px monospace;color:#9aaabd;margin:20px 0 0}</style><pre>${colorize(output)}</pre><p>Ink output · trusted ACP fixture · ${columns}×${rows} · rendered capture, not an OS terminal screenshot</p></html>`,
    );
  }
  console.log('Ink frames saved to ' + directory);
} finally {
  await app.close();
}

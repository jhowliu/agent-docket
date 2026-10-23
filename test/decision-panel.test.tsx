import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { renderToString } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { createAttention } from '../src/attention/index.js';
import { createExecution } from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import { WorkbenchApp } from '../src/app/tui-app.js';
import { WorkbenchScreen, workbenchMainWidth } from '../src/app/tui-view.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';

async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('Decision condition timed out');
}

test('a command approval names the command line, unwrapping an encoded bash -lc', async (t) => {
  const attention = createAttention();
  const execution = createExecution({ attention });
  t.after(() => execution.close());
  const run = await execution.start({ provider: 'fixture' });
  const turn = execution.prompt(run.id, 'command-permission');
  await until(() =>
    attention.list(run.id).some((item) => item.status === 'pending'),
  );
  const [item] = attention.list(run.id);
  assert.ok(item?.kind === 'permission');
  assert.equal(item.title, 'Run command');
  assert.equal(item.subject, 'npm test -- --watch=false');
  const allow = item.choices.find((choice) => choice.kind === 'allow-once');
  assert.ok(allow);
  attention.answer(item.id, allow.id);
  await turn;
});

test('the decision shows what it acts on, its keys and the Run state in the footer', async (t) => {
  const origin = 'http://127.0.0.1:4173';
  const app = createWebWorkbench(origin);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  t.after(() => app.close());
  await client.connect();
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  let state = await client.poll();
  await until(async () => {
    state = await client.poll();
    return state.runs[0]?.state.kind === 'idle';
  });
  const ui = render(
    <WorkbenchApp client={client} initial={state} pollInterval={25} />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  // With no recent action, the footer describes the selected Run.
  await until(() => !!ui.lastFrame()?.includes('Idle · i message · n new Run'));
  await client.command({
    kind: 'prompt',
    runId: started.runId,
    text: 'command-permission',
  });
  await until(() => !!ui.lastFrame()?.includes('APPROVAL 1/1'));
  const frame = ui.lastFrame() ?? '';
  for (const text of [
    ' APPROVAL 1/1  Run command',
    '  npm test -- --watch=false',
    ' a  Yes, proceed    r  No, and tell Codex what to do differently',
    'd full details · Tab next request',
    'The agent is waiting for your approval',
  ])
    assert.ok(frame.includes(text), `${text}\n${frame}`);
  ui.stdin.write('a');
  await until(async () =>
    (await client.poll()).events.some(
      (event) =>
        event.type === 'agent.message' && event.text === 'Command allowed.',
    ),
  );
  await until(() => !ui.lastFrame()?.includes('APPROVAL 1/1'));
});

test('short terminals keep the decision to two rows without losing the subject or keys', () => {
  const runId = 'run-compact';
  const state: WorkbenchState = {
    instanceId: 'compact',
    runs: [
      {
        id: runId,
        provider: 'codex',
        label: 'codex / run-1',
        state: { kind: 'running' },
        environment: { kind: 'local', location: '/tmp/run' },
        capabilities: null,
      },
    ],
    attention: [
      {
        id: 'attn-compact',
        kind: 'permission',
        runId,
        title: 'Run command',
        detail: '{}',
        subject: 'npm test -- --watch=false',
        status: 'pending',
        createdAt: '2026-10-22T00:00:00Z',
        choices: [
          { id: 'yes', label: 'Yes, proceed', kind: 'allow-once' },
          { id: 'no', label: 'No', kind: 'reject-once' },
        ],
      },
    ],
    events: [],
    cursor: 0,
    reset: true,
    source: '/tmp/source',
  };
  const request = state.attention[0];
  for (const [columns, rows, compact] of [
    [60, 20, true],
    [80, 24, false],
  ] as const) {
    const lines = stripVTControlCharacters(
      renderToString(
        <WorkbenchScreen
          state={state}
          selectedId={runId}
          filter="active"
          view="timeline"
          offset={0}
          request={request}
          armed
          connected
          busy={false}
          note="Codex is working · x stop · 1 Live"
          project={false}
          options={false}
          help={false}
          details={false}
          mode="normal"
          columns={columns}
          rows={rows}
        />,
        { columns },
      ),
    ).split('\n');
    assert.ok(lines.length <= rows, `${columns}×${rows} overflows`);
    assert.ok(lines.every((line) => stringWidth(line) <= columns));
    const at = lines.findIndex((line) => line.includes('APPROVAL 1/1'));
    // The decision sits in the main column, right of Project at 80+ columns.
    const block = lines
      .slice(at, at + (compact ? 2 : 4))
      .map((line) => line.slice(columns - workbenchMainWidth(columns)))
      .join('\n');
    if (compact) {
      assert.match(block, /APPROVAL 1\/1 {2}Run command · npm test/);
      assert.match(block, /a {2}Yes, proceed {4}r {2}No · d full details/);
    } else {
      assert.match(block, /\n {2}npm test -- --watch=false\n/);
      assert.match(block, /\nd full details · Tab next request$/);
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'ink';
import { createAttention } from '../src/attention/index.js';
import { createExecution } from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import { WorkbenchScreen, workbenchMainWidth } from '../src/app/tui-view.js';
import type { RunEvent } from '../src/execution/index.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';

test('progress instructions preserve provider slash-command dispatch', async (t) => {
  const attention = createAttention();
  const execution = createExecution({ attention });
  t.after(() => execution.close());
  attention.subscribe((item) => {
    if (item.status !== 'pending' || item.kind !== 'permission') return;
    const reject = item.choices.find((choice) => choice.kind === 'reject-once');
    if (reject) attention.answer(item.id, reject.id);
  });
  const run = await execution.start({ provider: 'fixture' });
  await execution.prompt(run.id, '/mcp');
  const reply = execution
    .events()
    .flatMap((event) => (event.type === 'agent.message' ? [event.text] : []))
    .join('');
  assert.equal(reply, 'workbench_progress: report_progress, request_user');
  assert.equal(attention.list().length, 0);
  assert.ok(
    !execution.events().some((event) => event.type === 'agent.progress'),
  );
});

test('an agent discovers and calls its Run-bound progress tool; its wording enters the journal unchanged', async (t) => {
  const execution = createExecution({ attention: createAttention() });
  t.after(() => execution.close());
  const run = await execution.start({ provider: 'fixture' });
  const summary =
    'The next step depends on an undocumented theme override. I have not changed files or verified a fix.';
  await execution.prompt(run.id, 'progress:' + summary);
  const journal = execution.events();
  const reports = journal.filter((event) => event.type === 'agent.progress');
  assert.deepEqual(
    reports.map((event) => event.summary),
    [summary],
  );
  assert.equal(reports[0]?.runId, run.id);
  assert.ok(
    (reports[0]?.sequence ?? Infinity) <
      (journal.find((event) => event.type === 'turn.end')?.sequence ?? 0),
  );
  assert.equal(execution.snapshot(run.id).state.kind, 'idle');
  assert.ok(
    journal.some(
      (event) =>
        event.type === 'agent.message' &&
        event.text.includes('Full conversation'),
    ),
  );
});

test('progress accepts 50 words and rejects excessive, empty and terminal-control input without guessing its meaning', async (t) => {
  const execution = createExecution({ attention: createAttention() });
  t.after(() => execution.close());
  const run = await execution.start({ provider: 'fixture' });
  const accepted = Array(50).fill('word').join(' ');
  for (const summary of [
    accepted,
    accepted + ' extra',
    '   ',
    'Hello\u001b[31m',
  ])
    await execution.prompt(run.id, 'progress:' + summary);
  assert.deepEqual(
    execution
      .events()
      .filter((event) => event.type === 'agent.progress')
      .map((event) => event.summary),
    [accepted],
  );
  assert.equal(
    execution
      .events()
      .filter(
        (event) =>
          event.type === 'agent.message' && event.text.includes('rejected'),
      ).length,
    3,
  );
});

test('concurrent progress reports keep their own Run identity and apply journal redaction', async (t) => {
  const execution = createExecution({ attention: createAttention() });
  t.after(() => execution.close());
  const one = await execution.start({ provider: 'fixture' });
  const two = await execution.start({ provider: 'fixture' });
  await Promise.all([
    execution.prompt(one.id, 'progress:Project one is ready for inspection.'),
    execution.prompt(
      two.id,
      'progress:Project two received sk-abcdefghijklmnopqrstuv and is checking configuration.',
    ),
  ]);
  const reports = execution
    .events()
    .filter((event) => event.type === 'agent.progress');
  assert.deepEqual(
    reports
      .filter((event) => event.runId === one.id)
      .map((event) => event.summary),
    ['Project one is ready for inspection.'],
  );
  assert.deepEqual(
    reports
      .filter((event) => event.runId === two.id)
      .map((event) => event.summary),
    ['Project two received [redacted] and is checking configuration.'],
  );
});

test('cancelling a reporting Run closes its tool process and prevents late progress', async (t) => {
  const execution = createExecution({ attention: createAttention() });
  t.after(() => execution.close());
  const run = await execution.start({ provider: 'fixture' });
  const prompt = execution.prompt(run.id, 'progress-wait');
  const deadline = Date.now() + 6000;
  while (!execution.events().some((event) => event.type === 'agent.progress')) {
    if (Date.now() > deadline)
      throw new Error('Progress report did not arrive');
    await new Promise((done) => setTimeout(done, 10));
  }
  await execution.cancel(run.id);
  await prompt;
  assert.equal(execution.snapshot(run.id).state.kind, 'cancelled');
  const journal = execution.events();
  const cancelling = journal.find(
    (event) => event.type === 'run.state' && event.state.kind === 'cancelling',
  );
  assert.ok(cancelling);
  assert.ok(
    !journal.some(
      (event) =>
        event.type === 'agent.progress' && event.sequence > cancelling.sequence,
    ),
  );
});

test('progress survives the public workbench polling and reattachment path', async (t) => {
  const origin = 'http://127.0.0.1:4177';
  const app = createWebWorkbench(origin);
  t.after(() => app.close());
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  await client.command({
    kind: 'prompt',
    runId: started.runId,
    text: 'progress:Located the relevant theme setting. The final explanation follows in the conversation.',
  });
  let state = await client.poll();
  const deadline = Date.now() + 6000;
  while (!state.events.some((event) => event.type === 'agent.progress')) {
    if (Date.now() > deadline)
      throw new Error('Polled progress report did not arrive');
    await new Promise((done) => setTimeout(done, 10));
    state = await client.poll();
  }
  assert.equal(
    state.events.filter((event) => event.type === 'agent.progress').length,
    1,
  );
  const attached = createWorkbenchClient(origin, (request) =>
    app.fetch(request),
  );
  const again = await attached.connect();
  assert.deepEqual(
    again.events.filter((event) => event.type === 'agent.progress'),
    state.events.filter((event) => event.type === 'agent.progress'),
  );
});

test('Timeline wraps the full brief report at 60/80/120 columns while ordinary conversation stays in Live', () => {
  const summary =
    'Located the theme settings and checked how they reach the page. The current implementation uses a shared stylesheet with an optional saved preference. I am tracing the preference initialization before proposing changes. No files have been modified; the next update will describe the observed initialization behavior.';
  assert.ok(summary.split(/\s+/u).length <= 50);
  const runId = 'run-progress-display';
  const events: RunEvent[] = (
    [
      {
        type: 'agent.message',
        text: 'Ordinary conversation should stay in Live.',
      },
      { type: 'agent.progress', summary },
    ] as const
  ).map((event, index) => ({
    ...event,
    runId,
    sequence: index + 1,
    at: '2026-10-19T07:51:00Z',
  }));
  const state: WorkbenchState = {
    runs: [
      {
        id: runId,
        provider: 'fixture',
        label: 'Progress replay',
        state: { kind: 'running' },
        environment: {
          kind: 'trusted-fixture-directory',
          location: '/fixture',
        },
        capabilities: null,
      },
    ],
    attention: [],
    events,
    cursor: 2,
    reset: true,
    source: '/fixture',
  };
  for (const [columns, rows] of [
    [60, 20],
    [80, 24],
    [120, 36],
  ] as const) {
    const output = renderToString(
      <WorkbenchScreen
        state={state}
        selectedId={runId}
        filter="active"
        view="timeline"
        offset={0}
        request={undefined}
        armed={false}
        connected
        busy={false}
        note="Replay"
        project={false}
        options={false}
        help={false}
        details={false}
        mode="normal"
        columns={columns}
        rows={rows}
      />,
      { columns },
    );
    // Read down the main column; Project entries occupy the adjacent column.
    const main = output
      .split('\n')
      .map((line) => line.slice(0, workbenchMainWidth(columns)))
      .join('\n');
    const reading = main.replace(/[│\s]/gu, '');
    assert.ok(reading.includes(summary.replace(/\s/gu, '')), output);
    assert.ok(output.includes('Progress'), output);
    assert.ok(!output.includes('Ordinary conversation'), output);
    assert.ok(!main.includes('…'), output);
  }
});

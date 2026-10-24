import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'ink';
import { createAttention } from '../src/attention/index.js';
import { createExecution } from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';
import type { RunId } from '../src/execution/index.js';
import { WorkbenchScreen } from '../src/app/tui-view.js';
import { timelineEntries } from '../src/app/tui-timeline.js';

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('Turn outcome condition timed out');
}
const origin = 'http://127.0.0.1:4177';
const blocker = {
  kind: 'action',
  title: 'Enable access to PR #16',
  steps: ['git fetch origin pull/16/head:pr-16', 'Reply here'],
} as const;

test('report_progress finished reaches the journal as the agent’s claim; ordinary progress does not carry it', async (t) => {
  const execution = createExecution({ attention: createAttention() });
  t.after(() => execution.close());
  const run = await execution.start({ provider: 'fixture' });
  await execution.prompt(run.id, 'progress:Reading the PR description.');
  await execution.prompt(run.id, 'done:Reviewed PR #16; two issues noted.');
  const reports = execution
    .events()
    .filter((event) => event.type === 'agent.progress');
  assert.deepEqual(
    reports.map((event) => [event.summary, 'finished' in event]),
    [
      ['Reading the PR description.', false],
      ['Reviewed PR #16; two issues noted.', true],
    ],
  );
  assert.equal(execution.snapshot(run.id).state.kind, 'idle');
});

test('each turn ends as the agent declared it: blocked stays blocked after Done until a reply, finished and silent turns read differently', async (t) => {
  const app = createWebWorkbench(origin);
  const client: WorkbenchClient = createWorkbenchClient(origin, (request) =>
    app.fetch(request),
  );
  t.after(() => app.close());
  await client.connect();
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  const runId: RunId = started.runId;
  const turns = (state: WorkbenchState) =>
    state.events.filter(
      (event) => event.type === 'turn.end' && event.runId === runId,
    ).length;
  let state = await client.poll();
  const turn = async (text: string) => {
    const before = turns(await client.poll());
    await client.command({ kind: 'prompt', runId, text });
    await until(async () => {
      state = await client.poll();
      return (
        turns(state) > before &&
        state.runs.find((run) => run.id === runId)?.state.kind === 'idle'
      );
    });
  };
  const screen = () =>
    renderToString(
      <WorkbenchScreen
        state={state}
        selectedId={runId}
        filter="active"
        view="timeline"
        offset={0}
        request={undefined}
        armed
        connected
        busy={false}
        note=""
        options={false}
        help={false}
        details={false}
        mode="normal"
        columns={140}
        rows={40}
      />,
      { columns: 140 },
    );
  const rows = () =>
    timelineEntries(
      state.events.filter((event) => event.runId === runId),
      state.attention,
    );
  const last = (label: string) =>
    rows()
      .filter((entry) => entry.label === label)
      .at(-1);

  // Blocked: the request and its steps, then the turn's own result row.
  await until(async () => {
    state = await client.poll();
    return state.runs[0]?.state.kind === 'idle';
  });
  await turn(`needs:${JSON.stringify(blocker)}`);
  let output = screen();
  assert.match(output, /Run 1 · [^│\n]* Blocked /, output);
  assert.match(output, /Needs you · Enable access to PR #16/, output);
  assert.match(output, /1\. git fetch origin pull\/16\/head:pr-16/, output);
  assert.equal(last('Blocked')?.color, 'yellow');
  assert.match(last('Blocked')?.detail ?? '', /^Enable access to PR #16/);

  // Done tells the agent nothing: the Run stays blocked until a reply.
  const request = state.attention.find(
    (item) => item.kind === 'agent-request' && item.status === 'pending',
  );
  assert.ok(request);
  await client.command({ kind: 'complete-request', id: request.id });
  await until(async () => {
    state = await client.poll();
    return rows().some((entry) => entry.label === 'Marked done');
  });
  output = screen();
  assert.match(output, /Blocked · reply to continue/, output);
  assert.equal(last('Marked done')?.color, 'yellow');
  assert.match(last('Marked done')?.detail ?? '', /^reply to continue/);

  // A reply resolves it; a turn that declares nothing shows its reply's end.
  await turn('reply:fetched into pr-16');
  output = screen();
  assert.equal(last('Marked done')?.color, 'gray');
  assert.doesNotMatch(output, /reply to continue/, output);
  assert.match(output, /Run 1 · [^│\n]* Idle /, output);
  assert.equal(last('Turn ended')?.color, 'gray');
  assert.deepEqual(last('Turn ended')?.notes, [
    'Answer received: fetched into pr-16',
  ]);

  // Finished is the agent's claim, green, and never more than that.
  await turn('done:Reviewed PR #16; two issues noted.');
  output = screen();
  assert.match(output, /Finished · Reviewed PR #16; two issues noted\./);
  assert.match(output, /Run 1 · [^│\n]* Finished /, output);
  assert.equal(last('Finished')?.color, 'green');
  assert.doesNotMatch(output, /verified|passed|accepted/i, output);
  // Whatever it declared, the turn's reply is a key away and its end shows.
  assert.match(last('Finished')?.detail ?? '', /Space reply · 1 line$/);
  assert.deepEqual(last('Finished')?.notes, [
    'Progress report submitted. Full conversation remains here.',
  ]);

  // A question reads as one.
  await turn(
    `needs:${JSON.stringify({ kind: 'question', title: 'Use the NPC price or the market price?', steps: [] })}`,
  );
  output = screen();
  assert.match(output, /Run 1 · [^│\n]* Question /, output);
  assert.equal(last('Question')?.color, 'yellow');
  assert.match(
    last('Question')?.detail ?? '',
    /^Use the NPC price or the market price\?/,
  );
});

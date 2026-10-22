import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { z } from 'zod';
import {
  attentionItemSchema,
  createAttention,
} from '../src/attention/index.js';
import type { AttentionItem } from '../src/attention/index.js';
import { createExecution } from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import { WorkbenchApp } from '../src/app/tui-app.js';

const runId = 'run-agent-request';
const restart = {
  kind: 'action',
  title: 'Restart ro-panel with --write',
  steps: [
    'Quit the panel with q',
    'cargo run --manifest-path ro-panel/Cargo.toml -- --write',
  ],
} as const;
const agentRequests = (items: readonly AttentionItem[]) =>
  items.filter((item) => item.kind === 'agent-request');
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('Agent request condition timed out');
}

test('agent requests outlive a turn, end with their Run and are only marked done', () => {
  const attention = createAttention();
  const seen: string[] = [];
  attention.subscribe((item) => seen.push(`${item.kind}:${item.status}`));
  const id = attention.ask({
    runId,
    request: 'action',
    title: restart.title,
    steps: restart.steps,
  });
  const permission = attention.request({
    runId,
    title: 'Run command',
    detail: 'npm test',
    choices: [{ id: 'allow', label: 'Yes', kind: 'allow-once' }],
  });

  // A turn ending expires approvals, never the person's open requests.
  attention.invalidate(runId, 'Prompt turn ended');
  const items = new Map(attention.list(runId).map((item) => [item.id, item]));
  assert.equal(items.get(id)?.status, 'pending');
  assert.equal(items.get(permission.id)?.status, 'stale');

  assert.throws(
    () => attention.answer(id, 'allow'),
    /Only permission requests/,
  );
  assert.throws(() => attention.complete(permission.id), /Only agent requests/);
  assert.equal(attention.complete(id), 'done');
  assert.equal(attention.complete(id), 'already-done');

  const open = attention.ask({
    runId,
    request: 'question',
    title: 'Which account?',
    steps: [],
  });
  attention.invalidate(runId, 'Run cancelled', { includeRequests: true });
  const after = new Map(attention.list(runId).map((item) => [item.id, item]));
  assert.equal(after.get(id)?.status, 'done', 'a finished request stays done');
  assert.deepEqual(
    {
      status: after.get(open)?.status,
      reason:
        after.get(open)?.status === 'stale'
          ? (after.get(open) as { reason: string }).reason
          : '',
    },
    { status: 'stale', reason: 'Run cancelled' },
  );
  assert.equal(attention.complete(open), 'stale');
  assert.deepEqual(seen, [
    'agent-request:pending',
    'permission:pending',
    'permission:stale',
    'agent-request:done',
    'agent-request:pending',
    'agent-request:stale',
  ]);

  for (let i = 0; i < 20; i++)
    attention.ask({
      runId: 'run-busy',
      request: 'action',
      title: `Step ${i}`,
      steps: [],
    });
  assert.throws(
    () =>
      attention.ask({
        runId: 'run-busy',
        request: 'action',
        title: 'One more',
        steps: [],
      }),
    /20 open agent requests/,
  );
  assert.throws(
    () => attention.ask({ runId, request: 'action', title: '  ', steps: [] }),
    /needs a title/,
  );
  attention.close();
});

test('items from older daemons without a kind still parse as permission requests', () => {
  const legacy = {
    id: 'attn-old',
    runId,
    title: 'Run command',
    detail: 'npm test',
    createdAt: '2026-10-21T00:00:00Z',
    status: 'pending',
    choices: [{ id: 'allow', label: 'Yes', kind: 'allow-once' }],
  };
  assert.equal(attentionItemSchema.parse(legacy).kind, 'permission');
  const request = {
    id: 'attn-new',
    runId,
    title: restart.title,
    createdAt: legacy.createdAt,
    kind: 'agent-request',
    request: 'action',
    steps: restart.steps,
    status: 'done',
  };
  assert.deepEqual(attentionItemSchema.parse(request), request);
  assert.equal(
    attentionItemSchema.safeParse({ ...request, steps: Array(9).fill('x') })
      .success,
    false,
  );
});

test('the request_user tool records bounded requests for the active turn and they expire with the Run', async (t) => {
  const attention = createAttention();
  const execution = createExecution({ attention });
  t.after(() => execution.close());
  const run = await execution.start({ provider: 'fixture' });
  await execution.prompt(run.id, `needs:${JSON.stringify(restart)}`);
  const [request] = agentRequests(attention.list(run.id));
  assert.deepEqual(
    request && {
      kind: request.kind,
      request: request.request,
      title: request.title,
      steps: request.steps,
      status: request.status,
    },
    {
      kind: 'agent-request',
      request: 'action',
      title: restart.title,
      steps: [...restart.steps],
      status: 'pending',
    },
    'the request survives the end of the turn that made it',
  );
  assert.ok(
    execution
      .events()
      .some((event) => event.type === 'attention' && event.id === request?.id),
  );

  // Invalid shapes are refused to the agent and never reach the inbox.
  await execution.prompt(
    run.id,
    `needs:${JSON.stringify({ ...restart, title: 'x'.repeat(121) })}`,
  );
  await execution.prompt(
    run.id,
    `needs:${JSON.stringify({ ...restart, steps: Array(9).fill('step') })}`,
  );
  await execution.prompt(
    run.id,
    `needs:${JSON.stringify({ ...restart, title: 'Bell \u0007' })}`,
  );
  assert.equal(agentRequests(attention.list(run.id)).length, 1);
  const rejected = execution
    .events()
    .filter(
      (event) =>
        event.type === 'agent.message' &&
        event.text.startsWith('Request rejected'),
    );
  assert.equal(rejected.length, 3);

  // At most five per turn, so a looping agent cannot flood the inbox.
  await execution.prompt(
    run.id,
    `needs:${JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ kind: 'question', title: `Question ${i}`, steps: [] })))}`,
  );
  await until(() => agentRequests(attention.list(run.id)).length === 6);
  assert.ok(
    execution
      .events()
      .some(
        (event) =>
          event.type === 'agent.message' &&
          event.text.includes(
            'recorded, recorded, recorded, recorded, recorded, rejected',
          ),
      ),
  );

  await execution.cancel(run.id);
  assert.ok(
    agentRequests(attention.list(run.id)).every(
      (item) => item.status === 'stale',
    ),
  );
});

test('the TUI shows what the agent needs, marks it done with y and notes replies on the Timeline', async (t) => {
  const origin = 'http://127.0.0.1:4176';
  const app = createWebWorkbench(origin);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  t.after(() => app.close());
  const page = await (await app.fetch(new Request(origin))).text();
  const token = page.match(/name="workbench-token" content="([a-f0-9]+)"/)?.[1];
  assert.ok(token);
  const complete = (
    id: string,
    headers: Record<string, string> = {
      'x-workbench-token': token,
      origin,
      'content-type': 'application/json',
    },
  ) =>
    app.fetch(
      new Request(`${origin}/api/commands`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'complete-request', id }),
      }),
    );
  const errorBody = z.object({ error: z.string() });

  await client.connect();
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  await until(async () => (await client.poll()).runs[0]?.state.kind === 'idle');
  await client.command({
    kind: 'prompt',
    runId: started.runId,
    text: `needs:${JSON.stringify(restart)}`,
  });
  let state = await client.poll();
  await until(async () => {
    state = await client.poll();
    return (
      agentRequests(state.attention).length === 1 &&
      state.runs[0]?.state.kind === 'idle'
    );
  });
  const request = agentRequests(state.attention)[0];
  assert.ok(request);

  const ui = render(
    <WorkbenchApp client={client} initial={state} pollInterval={25} />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  await until(
    () =>
      !!ui
        .lastFrame()
        ?.includes('Needs you 1/1 · Restart ro-panel with --write'),
  );
  const frame = ui.lastFrame() ?? '';
  assert.ok(frame.includes('1. Quit the panel with q'), frame);
  assert.ok(frame.includes('y done · i reply'), frame);
  assert.ok(
    frame.includes('Needs you (1)'),
    'the roster does not call it an approval',
  );
  assert.ok(!frame.includes('Awaiting approval'), frame);
  assert.ok(
    frame.includes('replied · 1 Live'),
    'the Timeline says the agent replied',
  );

  ui.stdin.write('a');
  await until(
    () =>
      !!ui
        .lastFrame()
        ?.includes('a/r answer approvals · y marks this request done'),
  );
  assert.equal(
    agentRequests((await client.poll()).attention)[0]?.status,
    'pending',
  );

  assert.equal((await complete(request.id, {})).status, 403);
  assert.equal(
    (await complete('attn-00000000-0000-4000-8000-000000000000')).status,
    404,
  );

  ui.stdin.write('y');
  await until(
    () => !!ui.lastFrame()?.includes('Marked done · the agent was not told'),
  );
  await until(
    async () =>
      agentRequests((await client.poll()).attention)[0]?.status === 'done',
  );
  await until(() => !ui.lastFrame()?.includes('Needs you 1/1'));
  const repeated = await complete(request.id);
  assert.equal(repeated.status, 409);
  assert.equal(
    errorBody.parse(await repeated.json()).error,
    'Already marked done',
  );
  assert.ok(
    !(await client.poll()).events.some(
      (event) => event.type === 'turn.start' && event.text.includes('done'),
    ),
    'marking done sends nothing to the agent',
  );
});

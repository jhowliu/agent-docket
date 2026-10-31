import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';

const origin = 'http://127.0.0.1:4177';
async function waitFor(
  client: WorkbenchClient,
  predicate: (state: WorkbenchState) => boolean,
) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const state = await client.poll();
    if (predicate(state)) return state;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Roadmap workbench condition timed out');
}

test('Roadmap commands share the real client path, preserve native prompts and supply the current spec', async (t) => {
  const app = createWebWorkbench(origin);
  t.after(() => app.close());
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  await client.command({
    kind: 'work.create',
    expectedRevision: 0,
    runId: started.runId,
    title: 'Login',
    phaseTitle: 'Validation',
    taskTitle: 'Boundary handling',
    spec: '保留需求原文：到期瞬間應拒絕 token。',
  });
  const work = (await client.poll()).work;
  assert.equal(work?.kind, 'ready');
  assert.ok(work.plan);
  const taskId = work.plan.phases[0]?.tasks[0]?.id;
  assert.ok(taskId);
  await client.command({
    kind: 'work.confirm',
    expectedRevision: work.plan.revision,
    taskId,
  });
  await client.command({
    kind: 'prompt',
    runId: started.runId,
    text: 'task-context',
  });
  let state = await waitFor(
    client,
    (state) => state.runs[0]?.state.kind === 'idle',
  );
  const output = state.events
    .flatMap((event) => (event.type === 'agent.message' ? [event.text] : []))
    .join('');
  assert.match(output, /Workbench Task context/);
  assert.match(output, /保留需求原文：到期瞬間應拒絕 token。/);
  assert.match(output, /confirmed by the user/);
  assert.equal(state.work?.plan?.phases[0]?.tasks[0]?.stage, 'development');
  await client.command({ kind: 'prompt', runId: started.runId, text: '/mcp' });
  state = await waitFor(
    client,
    (state) => state.runs[0]?.state.kind === 'idle',
  );
  assert.ok(
    state.events.some(
      (event) =>
        event.type === 'agent.message' &&
        event.text === 'workbench_progress: report_progress, request_user',
    ),
  );
  assert.equal(state.attention.length, 0);
  assert.equal(state.work?.plan?.phases[0]?.tasks[0]?.stage, 'development');
  const revision = state.work?.plan?.revision;
  assert.ok(revision);
  await client.command({
    kind: 'work.detach',
    expectedRevision: revision,
    runId: started.runId,
  });
  const cursor = state.cursor;
  await client.command({
    kind: 'prompt',
    runId: started.runId,
    text: 'task-context',
  });
  state = await waitFor(
    client,
    (state) => state.runs[0]?.state.kind === 'idle',
  );
  assert.ok(
    !state.events.some(
      (event) =>
        event.sequence > cursor &&
        event.type === 'agent.message' &&
        event.text.includes('Workbench Task context'),
    ),
  );
});

test('project plans survive a new daemon without restoring Runs, permissions or bindings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-roadmap-'));
  let app = createWebWorkbench(origin, { planDirectory: directory });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  await client.command({
    kind: 'work.create',
    expectedRevision: 0,
    runId: started.runId,
    title: 'Plan',
    phaseTitle: 'First',
    taskTitle: 'Task one',
    spec: 'Acceptance conditions',
  });
  await client.command({ kind: 'prompt', runId: started.runId, text: 'fix' });
  const pending = await waitFor(client, (state) =>
    state.attention.some((item) => item.status === 'pending'),
  );
  const plan = pending.work?.plan;
  assert.ok(plan);
  await app.close();
  app = createWebWorkbench(origin, { planDirectory: directory });
  const restarted = await client.poll();
  assert.deepEqual(restarted.work?.plan, plan);
  assert.deepEqual(restarted.work?.bindings, []);
  assert.deepEqual(restarted.runs, []);
  assert.deepEqual(restarted.events, []);
  assert.deepEqual(restarted.attention, []);
  await assert.rejects(
    client.command({
      kind: 'work.attach',
      expectedRevision: plan.revision,
      runId: started.runId,
      taskId: plan.phases[0]?.tasks[0]?.id ?? '',
    }),
    /Unknown Run/,
  );
  const file = (await readdir(directory))[0];
  assert.ok(file);
  assert.doesNotMatch(
    await readFile(join(directory, file), 'utf8'),
    /run-|attn-|"events"|"bindings"/,
  );
  const next = await client.command({ kind: 'start' });
  assert.ok('runId' in next);
  const taskId = plan.phases[0]?.tasks[0]?.id;
  assert.ok(taskId);
  await client.command({
    kind: 'work.attach',
    expectedRevision: plan.revision,
    runId: next.runId,
    taskId,
  });
  assert.equal((await client.poll()).work?.bindings[0]?.runId, next.runId);
});

test('the work transport rejects stale/malformed actions and exposes its browser module through the allowlist', async (t) => {
  const app = createWebWorkbench(origin);
  t.after(() => app.close());
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  await client.command({
    kind: 'work.create',
    expectedRevision: 0,
    title: 'Plan',
    phaseTitle: 'First',
    taskTitle: 'Task',
    spec: '',
  });
  const state = await client.poll();
  await assert.rejects(
    client.command({
      kind: 'work.add-phase',
      expectedRevision: 0,
      title: 'Stale',
      goal: '',
    }),
    /Roadmap changed/,
  );
  assert.deepEqual((await client.poll()).work, state.work);
  assert.equal(
    (await app.fetch(new Request(origin + '/runtime-work.js'))).status,
    200,
  );
  const unauthenticated = await app.fetch(
    new Request(origin + '/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'work.focus',
        expectedRevision: 1,
        phaseId: state.work?.plan?.activePhaseId,
      }),
    }),
  );
  assert.equal(unauthenticated.status, 403);
});

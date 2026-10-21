import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWork } from '../src/work/index.js';
import type { Work, WorkPlan } from '../src/work/index.js';
import type { RunId, RunSnapshot } from '../src/execution/index.js';

const runId: RunId = 'run-current';
const run: RunSnapshot = {
  id: runId,
  provider: 'fixture',
  label: 'current execution',
  state: { kind: 'idle' },
  environment: { kind: 'trusted-fixture-directory', location: '/unused' },
  capabilities: null,
};
const execution = {
  snapshot(id: RunId) {
    if (id !== runId) throw new Error('Unknown Run');
    return structuredClone(run);
  },
  submit() {},
};
async function planOf(work: Work): Promise<WorkPlan> {
  const state = await work.snapshot();
  assert.equal(state.kind, 'ready');
  assert.ok(state.plan);
  return state.plan;
}
const create = (
  work: Work,
  spec = 'Reject tokens at the exact expiry boundary.',
) =>
  work.apply({
    kind: 'work.create',
    expectedRevision: 0,
    runId,
    title: 'Authentication',
    phaseTitle: 'Token validation',
    taskTitle: 'Fix boundary',
    spec,
  });

test('Roadmap is opt-in and a current Run can return to direct work without changing its Task', async (t) => {
  const work = createWork({ execution, projectKey: 'project-one' });
  t.after(() => work.close());
  assert.deepEqual(await work.snapshot(), {
    kind: 'ready',
    persistence: 'memory',
    plan: null,
    bindings: [],
  });
  await create(work);
  const plan = await planOf(work);
  const task = plan.phases[0]?.tasks[0];
  assert.ok(task);
  assert.equal(task.stage, 'clarification');
  assert.equal(task.spec.confirmed, false);
  assert.deepEqual((await work.snapshot()).bindings, [
    { runId, taskId: task.id },
  ]);
  await work.apply({
    kind: 'work.detach',
    expectedRevision: plan.revision,
    runId,
  });
  assert.deepEqual((await work.snapshot()).bindings, []);
  assert.deepEqual((await planOf(work)).phases[0]?.tasks[0], task);
  assert.equal(execution.snapshot(runId).state.kind, 'idle');
});

test('requirements confirmation and later edits are versioned; stage tracking cannot manufacture evidence', async (t) => {
  const work = createWork({ execution, projectKey: 'project-one' });
  t.after(() => work.close());
  await create(work, '');
  let plan = await planOf(work);
  const taskId = plan.phases[0]?.tasks[0]?.id;
  assert.ok(taskId);
  await assert.rejects(
    work.apply({
      kind: 'work.confirm',
      expectedRevision: plan.revision,
      taskId,
    }),
    /requirements/,
  );
  await assert.rejects(
    work.apply({
      kind: 'work.stage',
      expectedRevision: plan.revision,
      taskId,
      stage: 'human-review',
    }),
    /Confirm/,
  );
  assert.equal((await planOf(work)).revision, plan.revision);
  await work.apply({
    kind: 'work.spec',
    expectedRevision: plan.revision,
    taskId,
    text: 'Reject expiry <= now; keep refresh behavior.',
  });
  plan = await planOf(work);
  await work.apply({
    kind: 'work.confirm',
    expectedRevision: plan.revision,
    taskId,
  });
  plan = await planOf(work);
  assert.equal(plan.phases[0]?.tasks[0]?.stage, 'development');
  await work.apply({
    kind: 'work.stage',
    expectedRevision: plan.revision,
    taskId,
    stage: 'agent-review',
  });
  plan = await planOf(work);
  assert.equal(plan.phases[0]?.tasks[0]?.status, 'active');
  assert.doesNotMatch(JSON.stringify(plan), /"(?:verified|passed|accepted)"/);
  await work.apply({
    kind: 'work.spec',
    expectedRevision: plan.revision,
    taskId,
    text: 'Also handle tokens without an expiry.',
  });
  const changed = (await planOf(work)).phases[0]?.tasks[0];
  assert.equal(changed?.stage, 'clarification');
  assert.equal(changed?.spec.confirmed, false);
  assert.equal(changed?.spec.revision, 3);
  await assert.rejects(
    work.apply({
      kind: 'work.stage',
      expectedRevision: plan.revision,
      taskId,
      stage: 'human-review',
    }),
    /Roadmap changed/,
  );
});

test('inspecting or attaching another Phase does not move the active Phase', async (t) => {
  const work = createWork({ execution, projectKey: 'project-one' });
  t.after(() => work.close());
  await create(work);
  let plan = await planOf(work);
  const original = plan.activePhaseId;
  await work.apply({
    kind: 'work.add-phase',
    expectedRevision: plan.revision,
    title: 'Delivery',
    goal: 'Prepare a reviewed change',
  });
  plan = await planOf(work);
  const phase = plan.phases[1];
  assert.ok(phase);
  await work.apply({
    kind: 'work.add-task',
    expectedRevision: plan.revision,
    phaseId: phase.id,
    title: 'Prepare PR',
    spec: '',
  });
  plan = await planOf(work);
  const task = plan.phases[1]?.tasks[0];
  assert.ok(task);
  await work.apply({
    kind: 'work.attach',
    expectedRevision: plan.revision,
    runId,
    taskId: task.id,
  });
  assert.equal((await planOf(work)).activePhaseId, original);
  plan = await planOf(work);
  await work.apply({
    kind: 'work.focus',
    expectedRevision: plan.revision,
    phaseId: phase.id,
  });
  assert.equal((await planOf(work)).activePhaseId, phase.id);
});

test('only project planning state survives restart; old Runs cannot be reattached', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'work-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = createWork({ execution, projectKey: 'project-one', directory });
  await create(first);
  const before = await planOf(first);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const content = await readFile(join(directory, files[0] ?? ''), 'utf8');
  assert.doesNotMatch(
    content,
    /run-current|current execution|capabilities|environment|events|bindings/,
  );
  await first.close();
  const restarted = createWork({
    directory,
    projectKey: 'project-one',
    execution: {
      snapshot() {
        throw new Error('Unknown Run');
      },
      submit() {},
    },
  });
  t.after(() => restarted.close());
  assert.deepEqual(await planOf(restarted), before);
  assert.deepEqual((await restarted.snapshot()).bindings, []);
  const task = before.phases[0]?.tasks[0];
  assert.ok(task);
  await assert.rejects(
    restarted.apply({
      kind: 'work.attach',
      expectedRevision: before.revision,
      runId,
      taskId: task.id,
    }),
    /Unknown Run/,
  );
  const otherProject = createWork({
    execution,
    directory,
    projectKey: 'project-two',
  });
  t.after(() => otherProject.close());
  assert.equal((await otherProject.snapshot()).plan, null);
});

test('concurrent writers and stale clients cannot overwrite project plans', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'work-plan-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const one = createWork({ execution, projectKey: 'project-one', directory });
  const two = createWork({ execution, projectKey: 'project-one', directory });
  t.after(async () => {
    await one.close();
    await two.close();
  });
  await create(one);
  const revision = (await planOf(one)).revision;
  const results = await Promise.allSettled([
    one.apply({
      kind: 'work.add-phase',
      expectedRevision: revision,
      title: 'One',
      goal: '',
    }),
    two.apply({
      kind: 'work.add-phase',
      expectedRevision: revision,
      title: 'Two',
      goal: '',
    }),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  let plan = await planOf(two);
  assert.equal(plan.revision, revision + 1);
  assert.equal(plan.phases.length, 2);
  await two.apply({
    kind: 'work.add-phase',
    expectedRevision: plan.revision,
    title: 'Next',
    goal: '',
  });
  plan = await planOf(one);
  assert.equal(plan.phases.length, 3);
  assert.equal(
    (await readdir(directory)).filter((file) => file.endsWith('.lock')).length,
    0,
  );
});

test('invalid plans and another writer lock are preserved instead of silently replaced', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'work-plan-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const work = createWork({ execution, projectKey: 'project-one', directory });
  t.after(() => work.close());
  await create(work);
  const plan = await planOf(work);
  const file = join(directory, (await readdir(directory))[0] ?? '');
  await writeFile(file + '.lock', 'another writer');
  await assert.rejects(
    work.apply({
      kind: 'work.add-phase',
      expectedRevision: plan.revision,
      title: 'Do not overwrite',
      goal: '',
    }),
    /another writer/,
  );
  assert.equal(await readFile(file + '.lock', 'utf8'), 'another writer');
  await rm(file + '.lock');
  await writeFile(file, '{broken');
  assert.equal((await work.snapshot()).kind, 'unavailable');
  await assert.rejects(
    work.apply({
      kind: 'work.add-phase',
      expectedRevision: plan.revision,
      title: 'Still preserve',
      goal: '',
    }),
  );
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('plan limits reject the mutation without corrupting the previous revision', async (t) => {
  const work = createWork({ execution, projectKey: 'project-one' });
  t.after(() => work.close());
  await create(work);
  for (let index = 1; index < 8; index++) {
    const plan = await planOf(work);
    await work.apply({
      kind: 'work.add-phase',
      expectedRevision: plan.revision,
      title: 'Phase ' + (index + 1),
      goal: '',
    });
  }
  const before = await planOf(work);
  await assert.rejects(
    work.apply({
      kind: 'work.add-phase',
      expectedRevision: before.revision,
      title: 'Overflow',
      goal: '',
    }),
  );
  assert.deepEqual(await planOf(work), before);
});

test('mode/spec edits and input acceptance are ordered without leaking old Task context', async (t) => {
  const inputs: { text: string; context: string | undefined }[] = [];
  const work = createWork({
    projectKey: 'ordered-input',
    execution: {
      ...execution,
      submit(_id, text, context) {
        inputs.push({ text, context });
      },
    },
  });
  t.after(() => work.close());
  await create(work);
  let plan = await planOf(work);
  const taskId = plan.phases[0]?.tasks[0]?.id;
  assert.ok(taskId);
  await Promise.all([
    work.apply({ kind: 'work.detach', expectedRevision: plan.revision, runId }),
    work.submit(runId, '/mcp'),
  ]);
  assert.deepEqual(inputs[0], { text: '/mcp', context: undefined });
  plan = await planOf(work);
  await work.apply({
    kind: 'work.attach',
    expectedRevision: plan.revision,
    runId,
    taskId,
  });
  plan = await planOf(work);
  await Promise.all([
    work.apply({
      kind: 'work.spec',
      expectedRevision: plan.revision,
      taskId,
      text: 'Newest accepted planning input.',
    }),
    work.submit(runId, 'continue'),
  ]);
  assert.match(inputs[1]?.context ?? '', /Newest accepted planning input/);
  assert.doesNotMatch(
    inputs[1]?.context ?? '',
    /Reject tokens at the exact expiry/,
  );
  await work.close();
  await assert.rejects(work.submit(runId, 'late'), /closed/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { render } from 'ink-testing-library';
import type { LocalWorker, RunId } from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';
import { WorkbenchApp } from '../src/app/tui-app.js';

const origin = 'http://127.0.0.1:4177';
const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
async function until(check: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('Task flow condition timed out');
}

/** A Git project, a worktree Run on it tracking a confirmed Task, and its check. */
async function tracked(
  t: test.TestContext,
  check: string,
  adapterArgs: readonly string[] = [],
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'workbench-flow-')),
  );
  const repo = join(directory, 'shop');
  execFileSync('mkdir', [repo]);
  await writeFile(
    join(repo, 'token.mjs'),
    await readFile('fixtures/project/token.mjs'),
  );
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Flow Test');
  git(repo, 'config', 'user.email', 'flow@example.invalid');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Initial project');
  const app = createWebWorkbench(origin, {
    localWorker: {
      transport: 'local',
      workspaceRoot: join(directory, 'runs'),
      adapter: {
        file: process.execPath,
        args: [resolve('fixtures/agent.mjs'), ...adapterArgs],
      },
    } satisfies LocalWorker,
    planDirectory: join(directory, 'plans'),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const project = await client.project(repo);
  const started = await client.command({
    kind: 'new-session',
    presetId: 'codex-local',
    project: { path: repo, base: { branch: 'main', revision: project.head } },
  });
  assert.ok('runId' in started);
  const runId: RunId = started.runId;
  await until(async () => (await client.poll()).runs[0]?.state.kind === 'idle');
  const projectId = (await client.poll()).projects?.find((item) =>
    item.runIds.includes(runId),
  )?.id;
  assert.ok(projectId);
  await client.command({ kind: 'set-check', projectId, command: check });
  await client.command({
    kind: 'project-work',
    projectId,
    command: {
      kind: 'work.create',
      expectedRevision: 0,
      runId,
      title: 'Tokens',
      phaseTitle: 'Expiry',
      taskTitle: 'Boundary',
      spec: 'Reject expired tokens.',
    },
  });
  const task = async (state?: WorkbenchState) => {
    const work = (state ?? (await client.poll())).projects?.find(
      (item) => item.id === projectId,
    )?.work;
    assert.ok(work?.kind === 'ready' && work.plan);
    const found = work.plan.phases[0]?.tasks[0];
    assert.ok(found);
    return { revision: work.plan.revision, task: found };
  };
  const { revision, task: created } = await task();
  await client.command({
    kind: 'project-work',
    projectId,
    command: {
      kind: 'work.confirm',
      expectedRevision: revision,
      taskId: created.id,
    },
  });
  return { app, client, runId, task };
}
const next = (state: WorkbenchState, runId: RunId) =>
  state.overview
    ?.flatMap((project) => project.runs)
    .find((run) => run.runId === runId)?.next;
const workbenchPrompts = (
  state: WorkbenchState,
  runId: RunId,
  prefix: string,
) =>
  state.events.flatMap((event) =>
    event.runId === runId &&
    event.type === 'turn.start' &&
    event.text.startsWith(prefix)
      ? [event.text]
      : [],
  );

test('a finished report on a confirmed Task runs its checks, a pass moves it to Human Review, and only passing checks can be accepted', async (t) => {
  const { client, runId, task } = await tracked(t, 'test -f token.mjs');
  assert.equal((await task()).task.stage, 'development');
  // Nothing has been checked yet, so Human Review cannot accept.
  await assert.rejects(
    client.command({ kind: 'accept', runId }),
    /Accept needs checks passing on the current code and requirements \(not checked yet\)/,
  );
  // An ordinary turn starts nothing.
  await client.command({ kind: 'prompt', runId, text: 'progress' });
  await until(async () =>
    (await client.poll()).events.some(
      (event) => event.runId === runId && event.type === 'turn.end',
    ),
  );
  await until(async () => (await client.poll()).runs[0]?.state.kind === 'idle');
  assert.equal(
    (await client.poll()).events.filter((event) => event.type === 'check.start')
      .length,
    0,
  );

  await client.command({
    kind: 'prompt',
    runId,
    text: 'done:Rejected expired tokens at the boundary.',
  });
  await until(async () => (await task()).task.stage === 'human-review');
  let state = await client.poll();
  assert.equal(
    state.events.filter((event) => event.type === 'check.start').length,
    1,
  );
  assert.equal(
    state.verifications?.find((item) => item.runId === runId)?.status,
    'passed',
  );
  assert.equal(next(state, runId), 'accept');
  assert.deepEqual(state.flows, []);

  // The TUI names Human Review and accepts with :accept.
  const ui = render(
    <WorkbenchApp client={client} initial={state} pollInterval={25} />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  const frame = () => ui.lastFrame() ?? '';
  const has = (text: string) =>
    until(() => frame().includes(text), 6000).catch(() => {
      throw new Error(`Expected ${text}\n${frame()}`);
    });
  await has('Human Review · checks passed · :accept or :changes');
  await has('review · codex');
  await has('review Run 1 · Boundary');
  const key = async (value: string) => {
    ui.stdin.write(value);
    await new Promise((done) => setTimeout(done, 40));
  };
  await key(':');
  await key('accept');
  await key('\r');
  await has('Task accepted · nothing was committed or pushed');
  assert.equal((await task()).task.status, 'accepted');
  state = await client.poll();
  assert.equal(next(state, runId), 'prompt');
  // Accepting twice changes nothing.
  const { revision } = await task();
  await client.command({ kind: 'accept', runId });
  assert.equal((await task()).revision, revision);

  // Requesting changes reopens the Task and hands the notes to the agent.
  await client.command({
    kind: 'request-changes',
    runId,
    text: 'Also reject tokens without an expiry.',
  });
  const reopened = (await task()).task;
  assert.equal(reopened.stage, 'development');
  assert.equal(reopened.status, 'active');
  await until(
    async () =>
      workbenchPrompts(
        await client.poll(),
        runId,
        'Workbench Human Review requested changes:\nAlso reject tokens without an expiry.',
      ).length === 1,
  );
  await assert.rejects(
    client.command({ kind: 'request-changes', runId, text: 'More.' }),
    /Request changes once the Task is in Human Review/,
  );
});

test('failed checks go back to the agent twice, then stop for the person until they prompt', async (t) => {
  const { client, runId, task } = await tracked(
    t,
    'echo expired token accepted; exit 3',
    ['--finish-feedback'],
  );
  await client.command({ kind: 'prompt', runId, text: 'done:Implemented.' });
  await until(
    async () =>
      (await client.poll()).flows?.some(
        (flow) => flow.runId === runId && flow.step === 'stopped',
      ) === true,
  );
  const state = await client.poll();
  assert.deepEqual(
    state.flows?.map(({ step, attempts, reason }) => ({
      step,
      attempts,
      reason,
    })),
    [
      {
        step: 'stopped',
        attempts: 2,
        reason: 'Checks still fail after 2 fixes: Exit 3',
      },
    ],
  );
  assert.equal(
    state.events.filter((event) => event.type === 'check.start').length,
    3,
  );
  const sent = workbenchPrompts(state, runId, 'Workbench checks failed');
  assert.equal(sent.length, 2);
  assert.match(sent[0] ?? '', /automatic fix 1 of 2/);
  assert.match(sent[1] ?? '', /automatic fix 2 of 2/);
  assert.match(
    sent[0] ?? '',
    /Result: Exit 3\nLast output:\nexpired token accepted\n/,
  );
  assert.equal(next(state, runId), 'checks');
  assert.equal((await task()).task.stage, 'development');
  await assert.rejects(
    client.command({ kind: 'accept', runId }),
    /Accept needs checks passing.*\(failed: Exit 3\)/,
  );

  // The person takes over: the flow clears and nothing is checked on its own.
  await client.command({ kind: 'prompt', runId, text: 'progress' });
  await until(async () => (await client.poll()).flows?.length === 0);
  await until(async () => (await client.poll()).runs[0]?.state.kind === 'idle');
  const after = await client.poll();
  assert.equal(
    after.events.filter((event) => event.type === 'check.start').length,
    3,
  );
  assert.equal(next(after, runId), 'prompt');
});

test('a Direct Run reporting finished runs no checks', async (t) => {
  const { client, runId } = await tracked(t, 'true');
  const state = await client.poll();
  const projectId = state.projects?.find((item) =>
    item.runIds.includes(runId),
  )?.id;
  const work = state.projects?.find((item) => item.id === projectId)?.work;
  assert.ok(projectId && work?.kind === 'ready' && work.plan);
  await client.command({
    kind: 'project-work',
    projectId,
    command: {
      kind: 'work.detach',
      expectedRevision: work.plan.revision,
      runId,
    },
  });
  await client.command({ kind: 'prompt', runId, text: 'done:Finished.' });
  await waitIdle(client, runId);
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(
    (await client.poll()).events.filter((event) => event.type === 'check.start')
      .length,
    0,
  );
});

async function waitIdle(client: WorkbenchClient, runId: RunId) {
  await until(async () => {
    const state = await client.poll();
    return (
      state.events.some(
        (event) => event.runId === runId && event.type === 'turn.end',
      ) && state.runs.find((run) => run.id === runId)?.state.kind === 'idle'
    );
  });
}

test('cancelling a tracked Run removes it from its project while the Task keeps its stage', async (t) => {
  const { client, runId, task } = await tracked(t, 'test -f token.mjs');
  await client.command({ kind: 'prompt', runId, text: 'done:Finished.' });
  await until(async () => (await task()).task.stage === 'human-review');
  const reply = await client.command({ kind: 'cancel', runId });
  assert.ok('result' in reply && reply.removed === true);
  const state = await client.poll();
  assert.deepEqual(state.runs, []);
  assert.deepEqual(
    state.projects?.flatMap((project) => project.runIds),
    [],
  );
  assert.deepEqual(
    state.overview?.flatMap((project) => project.runs),
    [],
  );
  assert.deepEqual(state.verifications, []);
  assert.deepEqual(state.flows, []);
  const { task: kept } = await task(state);
  assert.equal(kept.stage, 'human-review');
  await assert.rejects(
    client.command({ kind: 'accept', runId }),
    /Run has no project association/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

/** A Git project and a workbench whose Codex · local preset runs the fixture agent. */
async function gitProject(
  t: test.TestContext,
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
  const claudeTokenFile = join(directory, 'claude-token');
  await writeFile(claudeTokenFile, 'sk-ant-oat01-test-token-0123456789');
  const app = createWebWorkbench(origin, {
    localWorker: {
      transport: 'local',
      workspaceRoot: join(directory, 'runs'),
      claudeTokenFile,
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
  return { app, client, repo };
}

/** A Git project, a worktree Run on it tracking a confirmed Task, and its check. */
async function tracked(
  t: test.TestContext,
  check: string,
  adapterArgs: readonly string[] = [],
  presetId = 'codex-local',
) {
  const { app, client, repo } = await gitProject(t, adapterArgs);
  const project = await client.project(repo);
  const started = await client.command({
    kind: 'new-session',
    presetId,
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
  return { app, client, runId, task, repo };
}
const next = (state: WorkbenchState, runId: RunId) =>
  state.overview
    ?.flatMap((project) => project.runs)
    .find((run) => run.runId === runId)?.next;
/** Prompts a reviewer Run received. */
const reviewPrompts = (state: WorkbenchState, reviewer: RunId) =>
  state.events.flatMap((event) =>
    event.runId === reviewer && event.type === 'turn.start' ? [event.text] : [],
  );
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

test('a finished report on a confirmed Task runs its checks, an approving Agent Review moves it to Human Review, and only passing checks can be accepted', async (t) => {
  const { client, runId, task, repo } = await tracked(t, 'test -f token.mjs');
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
  // A reviewer Run reviewed the Candidate read-only with only its own tool,
  // then left with its checkout and no branch.
  assert.deepEqual(
    state.reviews?.map(({ runId: reviewed, status, reason }) => ({
      reviewed,
      status,
      reason,
    })),
    [
      {
        reviewed: runId,
        status: 'approved',
        reason: 'Meets the requirements.',
      },
    ],
  );
  const reviewer = state.reviews?.[0]?.reviewer;
  assert.ok(reviewer && reviewer !== runId);
  assert.deepEqual(
    state.runs.map((run) => run.id),
    [runId],
  );
  assert.match(
    reviewPrompts(state, reviewer)[0] ?? '',
    /^Workbench Agent Review of Candidate [a-f0-9]{7} for the Task "Boundary"\.\nRequirements \(revision 1\):\nReject expired tokens\.\n\nThis checkout is the change at HEAD \([a-f0-9]{40}\)\. See it with: git diff [a-f0-9]{40} HEAD\n/,
  );
  assert.ok(
    state.events.some(
      (event) =>
        event.runId === reviewer &&
        event.type === 'agent.message' &&
        event.text === 'Reviewing in read-only mode with submit_review.',
    ),
  );
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 2);
  assert.equal(
    git(repo, 'branch', '--list', 'workbench/*').split('\n').length,
    1,
  );

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
  await has(
    'Human Review · checks passed · review approved · :accept or :changes',
  );
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

test('the whole Task flow runs from the TUI: New Session, check, Roadmap, spec, confirm, a prompt, Agent Review and :accept', async (t) => {
  const { client, repo } = await gitProject(t);
  const ui = render(
    <WorkbenchApp
      client={client}
      initial={await client.poll()}
      projectPath={repo}
      pollInterval={20}
    />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  const has = (text: string, ms = 6000) =>
    until(() => (ui.lastFrame() ?? '').includes(text), ms).catch(() => {
      throw new Error(`Expected ${text}\n${ui.lastFrame()}`);
    });
  const lacks = (text: string) =>
    until(() => !(ui.lastFrame() ?? '').includes(text), 6000).catch(() => {
      throw new Error(`Expected no ${text}\n${ui.lastFrame()}`);
    });
  // Ink attaches a new key handler after each render: a key sent the moment
  // a frame appears reaches the previous one. Wait before and after each key.
  const key = async (value: string) => {
    await new Promise((done) => setTimeout(done, 40));
    ui.stdin.write(value);
    await new Promise((done) => setTimeout(done, 40));
  };
  const command = async (text: string) => {
    await key(':');
    await key(text);
    await key('\r');
  };

  await key('n');
  await has('New Session');
  await key('\r');
  await has('Enter create');
  await key('\r');
  await lacks('New Session');
  await until(async () => (await client.poll()).runs[0]?.state.kind === 'idle');
  const runId = (await client.poll()).runs[0]?.id;
  assert.ok(runId);

  await command('check test -f token.mjs');
  await until(async () =>
    Boolean(
      (await client.poll()).checks?.some(
        (check) => check.command === 'test -f token.mjs',
      ),
    ),
  );
  const task = async () => {
    const state = await client.poll();
    const work = state.projects?.find((project) =>
      project.runIds.includes(runId),
    )?.work;
    assert.ok(work?.kind === 'ready' && work.plan);
    const found = work.plan.phases[0]?.tasks[0];
    assert.ok(found);
    return found;
  };
  // Each command lands before the next, as a person reading the screen would.
  await command('roadmap Boundary');
  await has('Requirement clarification');
  await command('spec Reject expired tokens.');
  await until(
    async () => (await task()).spec.text === 'Reject expired tokens.',
  );
  await command('confirm');
  await until(async () => (await task()).stage === 'development');

  // Enter opens the reply line; the prompt is text, never a command.
  await key('\r');
  await has('Reply');
  await key('done:Rejected expired tokens at the boundary.');
  await key('\r');
  // The left column shows Human Review at once; the footer keeps the
  // prompt's receipt for a few seconds first.
  await has('review · codex', 15000);
  await has('review Run 1 · Boundary');
  const state = await client.poll();
  assert.equal(
    state.verifications?.find((item) => item.runId === runId)?.status,
    'passed',
  );
  const review = state.reviews?.find((item) => item.runId === runId);
  assert.equal(review?.status, 'approved');
  // The reviewer judged the requirement typed in the TUI, then left.
  assert.ok(review?.reviewer);
  assert.match(
    reviewPrompts(state, review.reviewer)[0] ?? '',
    /Requirements \(revision \d+\):\nReject expired tokens\./,
  );
  assert.deepEqual(
    state.runs.map((run) => run.id),
    [runId],
  );

  await command('accept');
  await has('Task accepted · nothing was committed or pushed');
  assert.equal((await task()).status, 'accepted');
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 2);
});

test('a Claude Run is reviewed by Claude in default mode with edit tools denied', async (t) => {
  const { client, runId, task } = await tracked(
    t,
    'test -f token.mjs',
    [],
    'claude-local',
  );
  await client.command({
    kind: 'prompt',
    runId,
    text: 'done:Rejected expired tokens at the boundary.',
  });
  await until(async () => (await task()).task.stage === 'human-review');
  const state = await client.poll();
  assert.equal(state.runs[0]?.provider, 'claude');
  const reviewer = state.reviews?.[0]?.reviewer;
  assert.ok(reviewer);
  assert.equal(state.reviews?.[0]?.status, 'approved');
  assert.ok(
    state.events.some(
      (event) =>
        event.runId === reviewer &&
        event.type === 'agent.message' &&
        event.text ===
          'Reviewing in default mode (denied: Edit, Write, NotebookEdit) with submit_review.',
    ),
  );
});

test(':reviewer claude makes Claude review a Codex Run, saved for the project until :reviewer same', async (t) => {
  const { client, runId, task, repo } = await tracked(t, 'test -f token.mjs');
  const ui = render(
    <WorkbenchApp
      client={client}
      initial={await client.poll()}
      pollInterval={20}
    />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  const has = (text: string) =>
    until(() => (ui.lastFrame() ?? '').includes(text), 6000).catch(() => {
      throw new Error(`Expected ${text}\n${ui.lastFrame()}`);
    });
  const command = async (text: string) => {
    for (const key of [':', text, '\r']) {
      await new Promise((done) => setTimeout(done, 40));
      ui.stdin.write(key);
    }
  };
  const saved = join(dirname(repo), 'plans', 'reviewers.json');
  await command('reviewer');
  await has("Agent Review: each Run's own agent · :reviewer codex|claude|same");
  await command('reviewer gemini');
  await has('Use :reviewer codex, :reviewer claude or :reviewer same');
  await command('reviewer claude');
  await has("Claude runs this project's next Agent Reviews");
  const [{ projectId } = { projectId: '' }] =
    (await client.poll()).reviewers ?? [];
  assert.deepEqual((await client.poll()).reviewers, [
    { projectId, provider: 'claude' },
  ]);
  assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')), {
    version: 1,
    reviewers: { [projectId]: 'claude' },
  });

  await client.command({
    kind: 'prompt',
    runId,
    text: 'done:Rejected expired tokens at the boundary.',
  });
  await until(async () => (await task()).task.stage === 'human-review');
  const state = await client.poll();
  assert.equal(state.runs.find((run) => run.id === runId)?.provider, 'codex');
  const reviewer = state.reviews?.[0]?.reviewer;
  assert.ok(reviewer);
  assert.equal(state.reviews?.[0]?.status, 'approved');
  // Claude's private settings, not Codex's read-only mode.
  assert.ok(
    state.events.some(
      (event) =>
        event.runId === reviewer &&
        event.type === 'agent.message' &&
        event.text ===
          'Reviewing in default mode (denied: Edit, Write, NotebookEdit) with submit_review.',
    ),
  );

  await command('reviewer same');
  await has("Each Run's own agent runs this project's Agent Reviews");
  assert.deepEqual((await client.poll()).reviewers, []);
  assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')), {
    version: 1,
    reviewers: {},
  });
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

test('review findings go back to the agent, and its fix is checked and reviewed again', async (t) => {
  const { client, runId, task } = await tracked(t, 'test -f token.mjs', [
    '--finish-feedback',
    '--review=changes-once',
  ]);
  await client.command({ kind: 'prompt', runId, text: 'done:Implemented.' });
  await until(async () => (await task()).task.stage === 'human-review');
  const state = await client.poll();
  const sent = workbenchPrompts(
    state,
    runId,
    'Workbench Agent Review requested changes',
  );
  assert.equal(sent.length, 1);
  assert.match(
    sent[0] ?? '',
    /^Workbench Agent Review requested changes on Candidate [a-f0-9]{7} \(automatic fix 1 of 2\)\.\nSummary: Expired tokens at the exact boundary are accepted\.\nFindings:\n- token\.mjs:1: Use <= so a token expiring now is rejected\.\n/,
  );
  // Checked and reviewed twice: before and after the fix.
  assert.equal(
    state.events.filter((event) => event.type === 'check.start').length,
    2,
  );
  assert.equal(
    state.events.filter(
      (event) =>
        event.type === 'turn.start' &&
        event.text.startsWith('Workbench Agent Review of '),
    ).length,
    2,
  );
  assert.equal(state.reviews?.[0]?.status, 'approved');
  assert.equal(next(state, runId), 'accept');
  assert.deepEqual(
    state.runs.map((run) => run.id),
    [runId],
  );
});

test('a review that keeps requesting changes stops after two fixes, and the person can still accept on passing checks', async (t) => {
  const { client, runId, task } = await tracked(t, 'test -f token.mjs', [
    '--finish-feedback',
    '--review=changes',
  ]);
  await client.command({ kind: 'prompt', runId, text: 'done:Implemented.' });
  await until(
    async () =>
      (await client.poll()).flows?.some(
        (flow) => flow.runId === runId && flow.step === 'stopped',
      ) === true,
  );
  const state = await client.poll();
  assert.deepEqual(
    state.flows?.map(({ step, attempts, reason, cause }) => ({
      step,
      attempts,
      reason,
      cause,
    })),
    [
      {
        step: 'stopped',
        attempts: 2,
        reason:
          'Agent Review still requests changes after 2 fixes: Expired tokens at the exact boundary are accepted.',
        cause: 'review',
      },
    ],
  );
  assert.equal(
    workbenchPrompts(state, runId, 'Workbench Agent Review requested changes')
      .length,
    2,
  );
  assert.equal(next(state, runId), 'checks');
  assert.equal((await task()).task.stage, 'development');
  assert.equal(state.reviews?.[0]?.status, 'changes');

  const ui = render(
    <WorkbenchApp client={client} initial={state} pollInterval={25} />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  await until(() =>
    (ui.lastFrame() ?? '').includes(
      'Agent Review needs you: Agent Review still requests changes',
    ),
  ).catch(() => {
    throw new Error(`Expected the stopped review\n${ui.lastFrame()}`);
  });
  // The review is advice: checks pass on the current code, so the person decides.
  await client.command({ kind: 'accept', runId });
  assert.equal((await task()).task.status, 'accepted');
});

test("the person's prompt or x on the reviewer stops a running review", async (t) => {
  const { client, runId, task } = await tracked(t, 'test -f token.mjs', [
    '--review=wait',
  ]);
  const reviewing = async () => {
    await until(
      async () =>
        (await client.poll()).flows?.some(
          (flow) => flow.runId === runId && flow.step === 'reviewing',
        ) === true,
    );
    const state = await client.poll();
    const reviewer = state.flows?.[0]?.reviewer;
    assert.ok(reviewer);
    await until(
      async () =>
        (await client.poll()).runs.find((run) => run.id === reviewer)?.state
          .kind === 'running',
    );
    return reviewer;
  };
  await client.command({ kind: 'prompt', runId, text: 'done:Implemented.' });
  const first = await reviewing();
  let state = await client.poll();
  const shown = state.runs.find((run) => run.id === first);
  assert.equal(shown?.label, 'Review · shop');
  assert.equal(shown?.review?.runId, runId);
  assert.equal(shown?.worktree, undefined);
  assert.ok(state.projects?.some((project) => project.runIds.includes(first)));
  assert.equal((await task()).task.stage, 'agent-review');

  // The person takes over: the review stops and its Run leaves.
  await client.command({ kind: 'prompt', runId, text: 'progress' });
  await until(
    async () =>
      !(await client.poll()).runs.some((run) => run.id === first) &&
      (await client.poll()).flows?.length === 0,
  );
  await waitIdle(client, runId);

  // x on the reviewer stops the flow for the person.
  await client.command({ kind: 'prompt', runId, text: 'done:Implemented.' });
  const second = await reviewing();
  assert.notEqual(second, first);
  const reply = await client.command({ kind: 'cancel', runId: second });
  assert.ok('result' in reply && reply.removed === true);
  await until(
    async () =>
      (await client.poll()).flows?.some(
        (flow) =>
          flow.runId === runId &&
          flow.step === 'stopped' &&
          flow.reason === 'Agent Review was cancelled',
      ) === true,
  );
  state = await client.poll();
  assert.equal(next(state, runId), 'checks');
  assert.deepEqual(
    state.runs.map((run) => run.id),
    [runId],
  );
});

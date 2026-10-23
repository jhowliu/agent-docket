import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import { createAttention } from '../src/attention/index.js';
import { createExecution } from '../src/execution/index.js';
import type { LocalWorker, RunId } from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import {
  createWorkbenchClient,
  WorkbenchError,
} from '../src/app/workbench-client.js';
import { WorkbenchApp } from '../src/app/tui-app.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';

const origin = 'http://127.0.0.1:4177';
const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
async function until(check: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('Verification condition timed out');
}
/** A Git project with an ignored file and a Node test script. */
async function setup(t: test.TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'workbench-verify-')),
  );
  const repo = join(directory, 'shop');
  execFileSync('mkdir', [repo]);
  await writeFile(
    join(repo, 'token.mjs'),
    await readFile('fixtures/project/token.mjs'),
  );
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test' } }),
  );
  await writeFile(join(repo, 'package-lock.json'), '{}');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Verify Test');
  git(repo, 'config', 'user.email', 'verify@example.invalid');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Initial project');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const localWorker = {
    transport: 'local',
    workspaceRoot: join(directory, 'runs'),
    adapter: { file: process.execPath, args: [resolve('fixtures/agent.mjs')] },
  } satisfies LocalWorker;
  return {
    directory,
    repo,
    localWorker,
    planDirectory: join(directory, 'plans'),
  };
}
const worktrees = (repo: string) =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length;

test('a Candidate freezes every non-ignored file without touching the worktree, and checks run on a clean copy of it', async (t) => {
  const { repo, localWorker } = await setup(t);
  const attention = createAttention();
  const execution = createExecution({ attention });
  t.after(() => execution.close());
  const launch = {
    provider: 'codex' as const,
    worker: localWorker,
    source: {
      kind: 'directory' as const,
      path: repo,
      base: { branch: 'main', revision: git(repo, 'rev-parse', 'HEAD') },
    },
  };
  const run = execution.launch(launch);
  const other = execution.launch(launch);
  await until(() =>
    [run.id, other.id].every(
      (id) => execution.snapshot(id).state.kind === 'idle',
    ),
  );
  const worktree = execution.snapshot(run.id).worktree;
  assert.ok(worktree);
  const cwd = worktree.path;
  await writeFile(join(cwd, 'untracked.txt'), 'new file');
  await writeFile(join(cwd, 'ignored.txt'), 'local only');
  await writeFile(join(cwd, 'token.mjs'), 'export const edited = true;\n');
  const before = {
    head: git(cwd, 'rev-parse', 'HEAD'),
    branch: git(cwd, 'symbolic-ref', 'HEAD'),
    status: git(cwd, 'status', '--porcelain'),
    staged: git(cwd, 'diff', '--cached', '--name-only'),
  };
  const candidate = await execution.createCandidate(run.id);
  assert.equal(candidate.parent, before.head);
  assert.notEqual(candidate.sha, before.head);
  assert.equal(
    git(repo, 'rev-parse', `refs/workbench/candidates/${run.id}`),
    candidate.sha,
  );
  assert.equal(git(repo, 'show', `${candidate.sha}:untracked.txt`), 'new file');
  assert.match(git(repo, 'show', `${candidate.sha}:token.mjs`), /edited/);
  assert.throws(() =>
    git(repo, 'cat-file', '-e', `${candidate.sha}:ignored.txt`),
  );
  // The worktree, its index and its branch are exactly as they were.
  assert.deepEqual(
    {
      head: git(cwd, 'rev-parse', 'HEAD'),
      branch: git(cwd, 'symbolic-ref', 'HEAD'),
      status: git(cwd, 'status', '--porcelain'),
      staged: git(cwd, 'diff', '--cached', '--name-only'),
    },
    before,
  );
  // Unchanged code is the same Candidate; the Run now knows its content.
  assert.equal((await execution.createCandidate(run.id)).sha, candidate.sha);
  assert.equal(execution.snapshot(run.id).worktree?.tree, candidate.tree);

  const result = await execution.startCheck(
    run.id,
    candidate,
    'test -f untracked.txt && test ! -e ignored.txt && sleep 30 & echo "pid:$!"; echo checked; exit 3',
  );
  assert.equal(result.outcome, 'exited');
  assert.equal(result.exitCode, 3);
  assert.match(result.output, /checked/);
  // A process the check left behind is stopped with its group.
  const pid = Number(/pid:(\d+)/.exec(result.output)?.[1]);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  // The temporary checkout is gone: only the source and the Runs remain.
  assert.equal(worktrees(repo), 3);
  const clean = await execution.startCheck(
    run.id,
    candidate,
    'test -f untracked.txt && test ! -e ignored.txt',
  );
  assert.equal(clean.exitCode, 0);

  assert.throws(
    () => execution.startCheck(other.id, candidate, 'true'),
    /another Run/,
  );
  assert.throws(
    () => execution.startCheck(run.id, candidate, '   '),
    /between 1 and 1000/,
  );
  const slow = execution.startCheck(run.id, candidate, 'sleep 20');
  assert.throws(
    () => execution.startCheck(run.id, candidate, 'true'),
    /already running/,
  );
  // Stopping the Run cancels its check and removes the checkout.
  await execution.cancel(run.id);
  assert.equal((await slow).outcome, 'cancelled');
  assert.equal(worktrees(repo), 3);
  const events = execution.events().filter((event) => event.runId === run.id);
  assert.deepEqual(
    events.flatMap((event) =>
      event.type === 'check.end' ? [[event.outcome, event.exitCode]] : [],
    ),
    [
      ['exited', 3],
      ['exited', 0],
      ['cancelled', null],
    ],
  );
});

test('the Run’s content identity is unknown during a turn and changes when the agent edits files', async (t) => {
  const { repo, localWorker } = await setup(t);
  const attention = createAttention();
  const execution = createExecution({ attention });
  t.after(() => execution.close());
  const run = execution.launch({
    provider: 'codex',
    worker: localWorker,
    source: {
      kind: 'directory',
      path: repo,
      base: { branch: 'main', revision: git(repo, 'rev-parse', 'HEAD') },
    },
  });
  await until(() => execution.snapshot(run.id).state.kind === 'idle');
  const candidate = await execution.createCandidate(run.id);
  execution.submit(run.id, 'fix');
  assert.equal(execution.snapshot(run.id).worktree?.tree, undefined);
  await until(() =>
    attention.list(run.id).some((item) => item.status === 'pending'),
  );
  const [item] = attention.list(run.id);
  assert.ok(item?.kind === 'permission');
  const allow = item.choices.find((choice) => choice.kind === 'allow-once');
  assert.ok(allow);
  attention.answer(item.id, allow.id);
  await until(() => execution.snapshot(run.id).worktree?.tree !== undefined);
  assert.notEqual(execution.snapshot(run.id).worktree?.tree, candidate.tree);
  // A fixture Run has no worktree to freeze.
  const fixture = await execution.start({ provider: 'fixture' });
  await assert.rejects(
    execution.createCandidate(fixture.id),
    /local Git worktree/,
  );
});

test('verify binds a check to the Run’s code and Task spec; edits or new requirements make it stale', async (t) => {
  const data = await setup(t);
  const app = createWebWorkbench(origin, data);
  t.after(() => app.close());
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const project = await client.project(data.repo);
  const started = await client.command({
    kind: 'new-session',
    presetId: 'codex-local',
    project: {
      path: data.repo,
      base: { branch: 'main', revision: project.head },
    },
  });
  assert.ok('runId' in started);
  const runId: RunId = started.runId;
  let state: WorkbenchState = await client.poll();
  await until(async () => {
    state = await client.poll();
    return state.runs[0]?.state.kind === 'idle';
  });
  assert.equal(state.features?.verify, true);
  const projectId = state.projects?.find((item) =>
    item.runIds.includes(runId),
  )?.id;
  assert.ok(projectId);
  // Without a check, verify proposes one from package.json and runs nothing.
  const missing = await client
    .command({ kind: 'verify', runId })
    .catch((error: unknown) => error);
  assert.ok(missing instanceof WorkbenchError);
  assert.equal(missing.suggestion, 'npm ci && npm test');
  assert.equal(
    (await client.poll()).events.filter((event) => event.type === 'check.start')
      .length,
    0,
  );
  await client.command({
    kind: 'set-check',
    projectId,
    command: 'test -f token.mjs',
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(data.planDirectory, 'checks.json'), 'utf8')),
    { version: 1, checks: { [projectId]: 'test -f token.mjs' } },
  );
  const status = async () =>
    (await client.poll()).verifications?.find((item) => item.runId === runId);
  await client.command({ kind: 'verify', runId });
  await until(async () => (await status())?.status === 'passed');
  const passed = await status();
  assert.match(passed?.reason ?? '', /^Exit 0 on [a-f0-9]{7}$/);

  // The agent edits token.mjs: the passing check no longer applies.
  await client.command({ kind: 'prompt', runId, text: 'fix' });
  await until(async () =>
    (await client.poll()).attention.some((item) => item.status === 'pending'),
  );
  const item = (await client.poll()).attention.find(
    (entry) => entry.status === 'pending',
  );
  assert.ok(item?.kind === 'permission');
  const allow = item.choices.find((choice) => choice.kind === 'allow-once');
  assert.ok(allow);
  await client.command({ kind: 'answer', id: item.id, choiceId: allow.id });
  await until(async () => (await status())?.status === 'stale');
  assert.match((await status())?.reason ?? '', /Code changed after checking/);

  // Bound to a Task: a new requirements revision makes it stale too.
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
  await client.command({ kind: 'verify', runId });
  await until(async () => (await status())?.status === 'passed');
  const plan = (await client.poll()).projects?.find(
    (item) => item.id === projectId,
  )?.work;
  assert.ok(plan?.kind === 'ready' && plan.plan);
  const task = plan.plan.phases[0]?.tasks[0];
  assert.ok(task);
  await client.command({
    kind: 'project-work',
    projectId,
    command: {
      kind: 'work.spec',
      expectedRevision: plan.plan.revision,
      taskId: task.id,
      text: 'Reject tokens at the exact expiry boundary.',
    },
  });
  await until(async () => (await status())?.status === 'stale');
  assert.equal((await status())?.reason, 'Requirements changed after checking');

  // A failing check is failed, with its exit code.
  await client.command({ kind: 'set-check', projectId, command: 'exit 4' });
  await client.command({ kind: 'verify', runId });
  await until(async () => (await status())?.status === 'failed');
  assert.equal((await status())?.reason, 'Exit 4');
  // Saved checks survive a daemon restart; Runs and verifications do not.
  await app.close();
  const again = createWebWorkbench(origin, data);
  t.after(() => again.close());
  const fresh = await createWorkbenchClient(origin, (request) =>
    again.fetch(request),
  ).connect();
  assert.deepEqual(fresh.checks, [{ projectId, command: 'exit 4' }]);
  assert.deepEqual(fresh.verifications, []);
});

test('Ink v proposes a check first, then shows the check passing and going stale after an edit', async (t) => {
  const data = await setup(t);
  const app = createWebWorkbench(origin, data);
  t.after(() => app.close());
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const project = await client.project(data.repo);
  const started = await client.command({
    kind: 'new-session',
    presetId: 'codex-local',
    project: {
      path: data.repo,
      base: { branch: 'main', revision: project.head },
    },
  });
  assert.ok('runId' in started);
  let state = await client.poll();
  await until(async () => {
    state = await client.poll();
    return state.runs[0]?.state.kind === 'idle';
  });
  const ui = render(
    <WorkbenchApp client={client} initial={state} pollInterval={20} />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  const plain = () => stripVTControlCharacters(ui.lastFrame() ?? '');
  // An action receipt holds the footer for 8 s before the Run's state returns.
  const frame = (text: string, present = true) =>
    until(() => plain().includes(text) === present, 12_000).catch(() => {
      throw new Error(`Expected ${present ? '' : 'no '}${text}\n${plain()}`);
    });
  await frame('Idle');
  ui.stdin.write('v');
  // The suggestion waits on the command line; nothing has run.
  await frame(': check npm ci && npm test');
  await frame('No check yet · Enter saves this one, then v');
  ui.stdin.write('\u001b');
  await frame(': check', false);
  // Esc kept the suggestion as a draft; replace it with a quick check.
  ui.stdin.write(':');
  await frame(': check npm ci && npm test');
  ui.stdin.write('\u0015');
  await frame(': check npm', false);
  ui.stdin.write('check test -f token.mjs');
  await new Promise((done) => setTimeout(done, 30));
  ui.stdin.write('\r');
  await frame('Check saved for this project');
  const key = async (value: string) => {
    ui.stdin.write(value);
    await new Promise((done) => setTimeout(done, 60));
  };
  await key('3');
  await key('v');
  await frame('Checks started');
  await frame('Checks passed on ');
  await client.command({ kind: 'prompt', runId: started.runId, text: 'fix' });
  await frame('APPROVAL 1/1');
  await key('\t');
  await key('a');
  await frame('Checks stale: Code changed after checking');
  await key('1');
  await frame('Checks passed · ');
});

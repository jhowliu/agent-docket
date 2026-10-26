import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { render } from 'ink-testing-library';
import { createAttention } from '../src/attention/index.js';
import { createExecution } from '../src/execution/index.js';
import type { Launch, RunId } from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import { WorkbenchApp } from '../src/app/tui-app.js';
import { visibleRuns } from '../src/app/tui-view.js';
import { commandSchema } from '../src/app/workbench-protocol.js';

const git = (directory: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args],
    { encoding: 'utf8' },
  ).trim();
async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'workbench-worktree-test-'));
  const source = join(base, 'project space 中文');
  await mkdir(source);
  await writeFile(
    join(source, 'token.mjs'),
    await readFile('fixtures/project/token.mjs'),
  );
  await writeFile(
    join(source, '.gitignore'),
    'launch-observed.json\nnode_modules/\n',
  );
  git(source, 'init', '--quiet');
  git(source, 'config', 'user.name', 'Workbench Test');
  git(source, 'config', 'user.email', 'test@example.invalid');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'Initial project');
  const launch = {
    provider: 'codex',
    source: { kind: 'directory', path: source },
    worker: {
      transport: 'local',
      workspaceRoot: join(base, 'runs'),
      adapter: {
        file: process.execPath,
        args: [resolve('fixtures/local-agent.mjs')],
      },
    },
  } satisfies Launch;
  return { base, source, launch };
}
/** A removed Run leaves the list; its worktree diagnostics stay in the journal. */
function gone(execution: ReturnType<typeof createExecution>, id: RunId) {
  assert.ok(!execution.list().some((run) => run.id === id));
  assert.throws(() => execution.snapshot(id), /Unknown Run/);
}
const AUTO_COMMIT = 'Save the work of a cancelled Run (Agent Workbench)';
/** Commits fail until `restore`, so a cancelled Run keeps its changes listed. */
function failCommits(base: string, source: string) {
  git(source, 'config', 'commit.gpgSign', 'true');
  git(source, 'config', 'gpg.program', join(base, 'missing-gpg'));
  return () => git(source, 'config', 'commit.gpgSign', 'false');
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('Worktree condition timed out');
}

test('clean close collects the checkout and ignored build output while preserving source edits and branches', async (t) => {
  const { base, source, launch } = await setup();
  const execution = createExecution({ attention: createAttention() });
  t.after(async () => {
    await execution.close();
    await rm(base, { recursive: true, force: true });
  });
  await writeFile(join(source, 'token.mjs'), '// source-only staged edit\n');
  git(source, 'add', 'token.mjs');
  await writeFile(
    join(source, 'not-committed.txt'),
    'source-only untracked file',
  );
  const before = git(source, 'status', '--porcelain');
  const run = await execution.start(launch);
  assert.ok(run.worktree);
  assert.doesNotMatch(
    await readFile(join(run.environment.location, 'token.mjs'), 'utf8'),
    /source-only/,
  );
  await assert.rejects(
    access(join(run.environment.location, 'not-committed.txt')),
  );
  await mkdir(join(run.environment.location, 'node_modules'));
  await writeFile(
    join(run.environment.location, 'node_modules', 'build-cache'),
    'generated',
  );
  await Promise.all([execution.cancel(run.id), execution.cancel(run.id)]);
  gone(execution, run.id);
  await assert.rejects(access(run.environment.location));
  assert.equal(git(source, 'status', '--porcelain'), before);
  assert.equal(
    git(source, 'rev-parse', run.worktree.branch),
    run.worktree.baseRevision,
  );
  assert.equal(
    git(source, 'worktree', 'list', '--porcelain').match(/^worktree /gm)
      ?.length,
    1,
  );
});

test('staged, unstaged, binary and untracked changes are committed to the Run branch on cancel even without provider diff events', async (t) => {
  const { base, source, launch } = await setup();
  const execution = createExecution({ attention: createAttention() });
  t.after(async () => {
    await execution.close();
    await rm(base, { recursive: true, force: true });
  });
  const run = await execution.start(launch);
  assert.ok(run.worktree);
  await assert.rejects(
    execution.commitWorkspace(run.id, 'Must not commit a running session'),
    /Close this Run/,
  );
  await writeFile(
    join(run.environment.location, 'token.mjs'),
    '// staged change\n',
  );
  git(run.environment.location, 'add', 'token.mjs');
  await writeFile(
    join(run.environment.location, '.gitignore'),
    'launch-observed.json\nnode_modules/\n*.tmp\n',
  );
  await writeFile(
    join(run.environment.location, 'new binary.bin'),
    Buffer.from([0, 1, 255]),
  );
  const [one, two] = await Promise.all([
    execution.cancel(run.id),
    execution.cancel(run.id),
  ]);
  assert.equal(one.worktree?.status.kind, 'removed');
  assert.equal(two.worktree?.status.kind, 'removed');
  gone(execution, run.id);
  assert.ok(
    execution
      .events()
      .some(
        (event) =>
          event.type === 'diagnostic' &&
          event.message.startsWith('Commit required: 3 changed paths'),
      ),
  );
  assert.equal(
    execution.events().some((event) => event.type === 'diff'),
    false,
  );
  await assert.rejects(access(run.environment.location));
  assert.equal(git(source, 'rev-parse', 'HEAD'), run.worktree.baseRevision);
  assert.equal(
    git(
      source,
      'rev-list',
      '--count',
      `${run.worktree.baseRevision}..${run.worktree.branch}`,
    ),
    '1',
  );
  assert.equal(
    git(source, 'log', '-1', '--format=%s', run.worktree.branch),
    AUTO_COMMIT,
  );
  assert.equal(
    git(source, 'show', `${run.worktree.branch}:token.mjs`),
    '// staged change',
  );
  assert.deepEqual(
    execFileSync('git', [
      '-C',
      source,
      'show',
      `${run.worktree.branch}:new binary.bin`,
    ]),
    Buffer.from([0, 1, 255]),
  );
  assert.equal(git(source, 'remote'), '');
});

test('cancelling commits what the worktree holds to the Run branch, and an external commit is kept as is', async (t) => {
  const { base, source, launch } = await setup();
  const execution = createExecution({ attention: createAttention() });
  t.after(async () => {
    await execution.close();
    await rm(base, { recursive: true, force: true });
  });
  const run = await execution.start(launch);
  assert.ok(run.worktree);
  await writeFile(
    join(run.environment.location, 'new.txt'),
    'saved on the branch\n',
  );
  const stopped = await execution.cancel(run.id);
  assert.deepEqual(stopped.worktree?.status, { kind: 'removed' });
  gone(execution, run.id);
  await assert.rejects(access(run.environment.location));
  assert.equal(
    git(source, 'show', `${run.worktree.branch}:new.txt`),
    'saved on the branch',
  );
  assert.equal(
    git(source, 'log', '-1', '--format=%s', run.worktree.branch),
    AUTO_COMMIT,
  );
  assert.equal(git(source, 'rev-parse', 'HEAD'), run.worktree.baseRevision);

  // Work the person already committed gets no extra commit.
  const second = await execution.start(launch);
  assert.ok(second.worktree);
  await writeFile(join(second.environment.location, 'own.txt'), 'mine\n');
  git(second.environment.location, 'add', 'own.txt');
  git(second.environment.location, 'commit', '-qm', 'Saved externally');
  await execution.cancel(second.id);
  gone(execution, second.id);
  assert.equal(
    git(source, 'log', '-1', '--format=%s', second.worktree.branch),
    'Saved externally',
  );
});

test('a failed automatic or manual commit keeps the Run and its files, and can be retried', async (t) => {
  const { base, source, launch } = await setup();
  const execution = createExecution({ attention: createAttention() });
  t.after(async () => {
    await execution.close();
    await rm(base, { recursive: true, force: true });
  });
  const run = await execution.start(launch);
  assert.ok(run.worktree);
  await writeFile(
    join(run.environment.location, 'new.txt'),
    'must survive failed commit',
  );
  const restore = failCommits(base, source);
  await execution.cancel(run.id);
  assert.equal(execution.snapshot(run.id).state.kind, 'cancelled');
  assert.equal((await execution.listDirectory(run.id)).kind, 'ready');
  assert.ok(
    execution
      .events()
      .some(
        (event) =>
          event.runId === run.id &&
          event.type === 'diagnostic' &&
          event.message.startsWith('Automatic commit failed:'),
      ),
  );
  await assert.rejects(
    execution.commitWorkspace(run.id, 'Failing signed commit'),
  );
  assert.equal(
    await readFile(join(run.environment.location, 'new.txt'), 'utf8'),
    'must survive failed commit',
  );
  assert.equal(
    execution.snapshot(run.id).worktree?.status.kind,
    'commit-required',
  );
  restore();
  const message = 'Save "quoted" changes $(literal)';
  const [one, two] = await Promise.all([
    execution.commitWorkspace(run.id, message),
    execution.commitWorkspace(run.id, message),
  ]);
  assert.equal(one.worktree?.status.kind, 'removed');
  assert.equal(two.worktree?.status.kind, 'removed');
  gone(execution, run.id);
  assert.equal(
    git(source, 'log', '-1', '--format=%s', run.worktree.branch),
    message,
  );
  assert.equal(git(source, 'status', '--porcelain'), '');
});

test('a locked worktree or one on another branch stays on disk untouched when its Run is removed; no force cleanup', async (t) => {
  const { base, source, launch } = await setup();
  const execution = createExecution({ attention: createAttention() });
  t.after(async () => {
    await execution.close();
    await rm(base, { recursive: true, force: true });
  });
  const run = await execution.start(launch);
  assert.ok(run.worktree);
  git(source, 'worktree', 'lock', run.environment.location);
  await writeFile(join(run.environment.location, 'kept.txt'), 'kept\n');
  const locked = await execution.cancel(run.id);
  assert.equal(locked.worktree?.status.kind, 'retained');
  gone(execution, run.id);
  await access(join(run.environment.location, 'kept.txt'));
  assert.match(git(source, 'worktree', 'list', '--porcelain'), /locked/);
  // Its changes were still committed to its branch before Git refused removal.
  assert.equal(
    git(source, 'log', '-1', '--format=%s', run.worktree.branch),
    AUTO_COMMIT,
  );

  const moved = await execution.start(launch);
  assert.ok(moved.worktree);
  git(moved.environment.location, 'checkout', '-qb', 'user-switched-branch');
  await writeFile(join(moved.environment.location, 'kept.txt'), 'kept\n');
  const away = await execution.cancel(moved.id);
  assert.match(
    away.worktree?.status.kind === 'retained'
      ? away.worktree.status.reason
      : '',
    /ownership or branch changed/,
  );
  gone(execution, moved.id);
  await access(join(moved.environment.location, 'kept.txt'));
  assert.equal(
    git(source, 'rev-parse', 'user-switched-branch'),
    moved.worktree.baseRevision,
  );
  assert.equal(
    git(source, 'rev-parse', moved.worktree.branch),
    moved.worktree.baseRevision,
  );
});

test('a local directory must be the Git root and have an initial commit', async (t) => {
  const { base, source, launch } = await setup();
  const execution = createExecution({ attention: createAttention() });
  t.after(async () => {
    await execution.close();
    await rm(base, { recursive: true, force: true });
  });
  const folder = join(source, 'subfolder');
  await mkdir(folder);
  await assert.rejects(
    execution.start({ ...launch, source: { kind: 'directory', path: folder } }),
    /Git project root/,
  );
  const empty = join(base, 'empty');
  await mkdir(empty);
  await assert.rejects(
    execution.start({ ...launch, source: { kind: 'directory', path: empty } }),
    /Git repository/,
  );
  git(empty, 'init', '--quiet');
  await assert.rejects(
    execution.start({ ...launch, source: { kind: 'directory', path: empty } }),
    /Commit the project once/,
  );
});

test('TUI x commits a dirty worktree to its branch and removes the Run; a failed commit leaves the commit action', async (t) => {
  const { base, source, launch } = await setup();
  const origin = 'http://127.0.0.1:4177';
  const app = createWebWorkbench(origin, { launch });
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  let state = await client.poll();
  await until(async () => {
    state = await client.poll();
    return state.runs[0]?.state.kind === 'idle';
  });
  const run = state.runs[0];
  assert.ok(run?.worktree);
  const ui = render(
    <WorkbenchApp client={client} initial={state} pollInterval={25} />,
  );
  t.after(async () => {
    ui.unmount();
    ui.cleanup();
    await app.close();
    await rm(base, { recursive: true, force: true });
  });
  await writeFile(
    join(run.environment.location, 'saved.txt'),
    'Saved through the real Ink input flow',
  );
  await until(() => !!ui.lastFrame()?.includes('Idle'));
  // The first commit fails, so the Run stays with its commit action.
  const restore = failCommits(base, source);
  ui.stdin.write('x');
  await until(async () =>
    (await client.poll()).events.some(
      (event) =>
        event.type === 'diagnostic' &&
        event.message.startsWith('Automatic commit failed:'),
    ),
  );
  state = await client.poll();
  assert.equal(state.runs[0]?.state.kind, 'cancelled');
  assert.equal(visibleRuns(state, 'active').length, 1);
  await until(
    () =>
      !!ui
        .lastFrame()
        ?.includes(
          'Commit required · c commit with a message · x commit and remove',
        ),
  );
  restore();
  ui.stdin.write('c');
  await until(() => !!ui.lastFrame()?.includes(': commit'));
  ui.stdin.write('Save session work');
  await until(() => !!ui.lastFrame()?.includes('Save session work'));
  ui.stdin.write('\r');
  await until(() => !!ui.lastFrame()?.includes('Saved workbench/'));
  assert.ok(
    ui.lastFrame()?.includes(run.worktree.branch),
    'Show the saved branch after the Run leaves the roster',
  );
  await until(() => !ui.lastFrame()?.includes('> Run 1'));
  state = await client.poll();
  assert.equal(state.runs.length, 0);
  assert.equal(
    git(source, 'show', `${run.worktree.branch}:saved.txt`),
    'Saved through the real Ink input flow',
  );
  assert.equal(
    git(source, 'log', '-1', '--format=%s', run.worktree.branch),
    'Save session work',
  );

  // Without a failure, x saves and removes at once.
  const again = await client.command({ kind: 'start' });
  assert.ok('runId' in again);
  await until(async () => {
    state = await client.poll();
    return state.runs[0]?.state.kind === 'idle';
  });
  const second = state.runs[0];
  assert.ok(second?.worktree);
  await writeFile(join(second.environment.location, 'quick.txt'), 'quick');
  await until(() => !!ui.lastFrame()?.includes('Idle'));
  ui.stdin.write('x');
  await until(
    () =>
      !!ui
        .lastFrame()
        ?.includes(`Run removed · its work is on ${second.worktree?.branch}`),
  );
  assert.equal((await client.poll()).runs.length, 0);
  assert.equal(
    git(source, 'show', `${second.worktree.branch}:quick.txt`),
    'quick',
  );
  assert.equal(
    commandSchema.safeParse({
      kind: 'commit-workspace',
      runId: run.id,
      message: 'Save',
      path: source,
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      kind: 'commit-workspace',
      runId: run.id,
      message: '',
    }).success,
    false,
  );
});

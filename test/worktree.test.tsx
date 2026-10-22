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
import type { Launch } from '../src/execution/index.js';
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
  assert.equal(execution.snapshot(run.id).worktree?.status.kind, 'removed');
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

test('staged, unstaged, binary and untracked changes require commit even without provider diff events; commit/close is idempotent', async (t) => {
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
  await execution.cancel(run.id);
  const stopped = execution.snapshot(run.id);
  assert.deepEqual(stopped.worktree?.status, {
    kind: 'commit-required',
    changes: 3,
  });
  assert.equal(
    execution.events().some((event) => event.type === 'diff'),
    false,
  );
  assert.equal((await execution.listDirectory(run.id)).kind, 'ready');
  const message = 'Save "quoted" changes $(literal)';
  const [one, two] = await Promise.all([
    execution.commitWorkspace(run.id, message),
    execution.commitWorkspace(run.id, message),
  ]);
  assert.equal(one.worktree?.status.kind, 'removed');
  assert.equal(two.worktree?.status.kind, 'removed');
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
    message,
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

test('external commit followed by close removes the worktree and preserves the unmerged commit', async (t) => {
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
  await execution.cancel(run.id);
  assert.equal(
    execution.snapshot(run.id).worktree?.status.kind,
    'commit-required',
  );
  git(run.environment.location, 'add', 'new.txt');
  git(run.environment.location, 'commit', '-qm', 'Saved externally');
  await execution.cancel(run.id);
  assert.equal(execution.snapshot(run.id).worktree?.status.kind, 'removed');
  assert.equal(
    git(source, 'show', `${run.worktree.branch}:new.txt`),
    'saved on the branch',
  );
});

test('commit failure retains files and can be retried without rewriting the source checkout', async (t) => {
  const { base, source, launch } = await setup();
  const execution = createExecution({ attention: createAttention() });
  t.after(async () => {
    await execution.close();
    await rm(base, { recursive: true, force: true });
  });
  const run = await execution.start(launch);
  await writeFile(
    join(run.environment.location, 'new.txt'),
    'must survive failed commit',
  );
  await execution.cancel(run.id);
  git(source, 'config', 'commit.gpgSign', 'true');
  git(source, 'config', 'gpg.program', join(base, 'missing-gpg'));
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
  git(source, 'config', 'commit.gpgSign', 'false');
  assert.equal(
    (await execution.commitWorkspace(run.id, 'Retry save')).worktree?.status
      .kind,
    'removed',
  );
  assert.equal(git(source, 'status', '--porcelain'), '');
});

test('worktree lock and unexpected branch retain the workspace until corrected; no force cleanup', async (t) => {
  const { base, source, launch } = await setup();
  const execution = createExecution({ attention: createAttention() });
  t.after(async () => {
    await execution.close();
    await rm(base, { recursive: true, force: true });
  });
  const run = await execution.start(launch);
  assert.ok(run.worktree);
  git(source, 'worktree', 'lock', run.environment.location);
  await execution.cancel(run.id);
  assert.equal(execution.snapshot(run.id).worktree?.status.kind, 'retained');
  await access(run.environment.location);
  git(source, 'worktree', 'unlock', run.environment.location);
  git(run.environment.location, 'checkout', '-qb', 'user-switched-branch');
  await execution.cancel(run.id);
  assert.equal(execution.snapshot(run.id).worktree?.status.kind, 'retained');
  await assert.rejects(
    execution.commitWorkspace(run.id, 'Do not commit another branch'),
    /ownership or branch changed/,
  );
  git(run.environment.location, 'checkout', '-q', run.worktree.branch);
  await execution.cancel(run.id);
  assert.deepEqual(execution.snapshot(run.id).worktree?.status, {
    kind: 'removed',
  });
  assert.equal(
    git(source, 'rev-parse', 'user-switched-branch'),
    run.worktree.baseRevision,
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

test('TUI closes dirty worktrees, shows a commit action, commits to the branch and removes the stopped Run', async (t) => {
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
  ui.stdin.write('x');
  await until(() => !!ui.lastFrame()?.includes('Commit required'));
  state = await client.poll();
  assert.equal(state.runs[0]?.state.kind, 'cancelled');
  assert.equal(visibleRuns(state, 'active').length, 1);
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
  assert.equal(state.runs[0]?.worktree?.status.kind, 'removed');
  assert.equal(visibleRuns(state, 'active').length, 0);
  assert.equal(
    git(source, 'show', `${run.worktree.branch}:saved.txt`),
    'Saved through the real Ink input flow',
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

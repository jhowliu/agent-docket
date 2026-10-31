import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { render } from 'ink-testing-library';
import {
  inspectLocalProject,
  initializeLocalProject,
  ProjectInitializationRequired,
} from '../src/execution/index.js';
import type { ProjectInitialization } from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import { WorkbenchApp } from '../src/app/tui-app.js';
import { stateSchema } from '../src/app/workbench-protocol.js';

const origin = 'http://127.0.0.1:4218';
const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
async function setup() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'workbench-init-')));
  const path = join(base, 'new project 中文');
  await mkdir(path);
  return {
    base,
    path,
    localWorker: {
      transport: 'local' as const,
      workspaceRoot: join(base, 'runs'),
      adapter: {
        file: process.execPath,
        args: [resolve('fixtures/agent.mjs')],
      },
    },
  };
}
async function required(path: string): Promise<ProjectInitialization> {
  try {
    await inspectLocalProject(path);
  } catch (error) {
    assert.ok(error instanceof ProjectInitializationRequired);
    return error.project;
  }
  throw new Error('Expected explicit Git initialization');
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('Initialization condition timed out');
}

test('read-only inspection offers initialization; explicit approval snapshots non-ignored files and starts a worktree from them', async (t) => {
  const data = await setup();
  const app = createWebWorkbench(origin, data);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  t.after(async () => {
    await app.close();
    await rm(data.base, { recursive: true, force: true });
  });
  await writeFile(join(data.path, '.gitignore'), 'ignored.txt\n');
  await writeFile(
    join(data.path, 'ignored.txt'),
    'Keep out of the initial snapshot',
  );
  await writeFile(join(data.path, 'existing.txt'), 'Existing project files');
  const initial = await client.connect();
  assert.equal(initial.features?.projectInitialization, true);
  let proposal: ProjectInitialization | undefined;
  await assert.rejects(client.project(data.path), (error: unknown) => {
    assert.ok(error instanceof ProjectInitializationRequired);
    proposal = error.project;
    assert.equal(proposal.state, 'not-git');
    assert.equal(proposal.path, data.path);
    return true;
  });
  await assert.rejects(access(join(data.path, '.git')));
  await assert.rejects(access(join(data.path, '.workbench-init.lock')));
  assert.ok(proposal);
  const project = await client.initializeProject(proposal);
  assert.equal(project.currentBranch, 'main');
  assert.equal(git(data.path, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(
    git(data.path, 'show', 'HEAD:existing.txt'),
    'Existing project files',
  );
  assert.equal(
    git(data.path, 'ls-files', 'ignored.txt', '.workbench-init.lock'),
    '',
  );
  assert.equal(git(data.path, 'status', '--porcelain'), '');
  assert.equal(
    await readFile(join(data.path, 'ignored.txt'), 'utf8'),
    'Keep out of the initial snapshot',
  );
  assert.deepEqual((await client.poll()).runs, []);
  const started = await client.command({
    kind: 'new-session',
    presetId: 'codex-local',
    project: {
      path: project.path,
      base: { branch: 'main', revision: project.head },
    },
  });
  assert.ok('runId' in started);
  await until(async () => (await client.poll()).runs[0]?.state.kind === 'idle');
  const run = (await client.poll()).runs[0];
  assert.ok(run?.worktree);
  assert.equal(
    await readFile(join(run.environment.location, 'existing.txt'), 'utf8'),
    'Existing project files',
  );
  await assert.rejects(access(join(run.environment.location, 'ignored.txt')));
  await client.command({ kind: 'cancel', runId: started.runId });
});

test('empty folders and unborn repositories get one initial commit; missing Git identity uses a per-commit Workbench identity', async (t) => {
  const data = await setup();
  t.after(() => rm(data.base, { recursive: true, force: true }));
  const empty = await initializeLocalProject(await required(data.path));
  assert.equal(git(empty.path, 'ls-files'), '');
  assert.equal(git(empty.path, 'rev-list', '--count', 'HEAD'), '1');
  const unborn = join(data.base, 'unborn');
  await mkdir(unborn);
  git(unborn, 'init', '-q', '-b', 'custom-start');
  git(unborn, 'config', 'user.name', '');
  git(unborn, 'config', 'user.email', '');
  const proposal = await required(unborn);
  assert.equal(proposal.state, 'no-commit');
  const project = await initializeLocalProject(proposal);
  assert.equal(project.currentBranch, 'custom-start');
  assert.equal(
    git(unborn, 'log', '-1', '--format=%an <%ae>'),
    'Agent Workbench <workbench@localhost>',
  );
  assert.equal(git(unborn, 'config', '--get', 'user.name'), '');
  assert.equal(git(unborn, 'config', '--get', 'user.email'), '');
});

test('initialization is serialized and repeated requests never append commits or stage later edits', async (t) => {
  const data = await setup();
  t.after(() => rm(data.base, { recursive: true, force: true }));
  const proposal = await required(data.path);
  const results = await Promise.allSettled([
    initializeLocalProject(proposal),
    initializeLocalProject(proposal),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(
    rejected?.status === 'rejected' && rejected.reason instanceof Error,
  );
  assert.match(rejected.reason.message, /locked/);
  await writeFile(
    join(data.path, 'later.txt'),
    'Do not auto-commit later work',
  );
  await initializeLocalProject(proposal);
  assert.equal(git(data.path, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(data.path, 'status', '--porcelain'), '?? later.txt');
  await assert.rejects(access(join(data.path, '.workbench-init.lock')));
});

test('replaced folders, changed Git state, subfolders and unreadable metadata cannot be silently initialized', async (t) => {
  const data = await setup();
  t.after(() => rm(data.base, { recursive: true, force: true }));
  const proposal = await required(data.path);
  await rename(data.path, data.path + '-original');
  await mkdir(data.path);
  await assert.rejects(initializeLocalProject(proposal), /folder changed/);
  await assert.rejects(access(join(data.path, '.git')));
  const current = await required(data.path);
  const child = join(data.path, 'child');
  await mkdir(child);
  const childProposal = await required(child);
  git(data.path, 'init', '-q', '-b', 'main');
  await assert.rejects(initializeLocalProject(current), /Project changed/);
  const project = await initializeLocalProject(await required(data.path));
  await assert.rejects(inspectLocalProject(child), /Git project root/);
  await assert.rejects(
    initializeLocalProject(childProposal),
    /Git project root/,
  );
  await assert.rejects(
    initializeLocalProject({ ...current, path: child }),
    /folder changed/,
  );
  await assert.rejects(access(join(child, '.git')));
  assert.equal((await inspectLocalProject(data.path)).head, project.head);
  const invalid = join(data.base, 'invalid');
  await mkdir(join(invalid, '.git'), { recursive: true });
  await assert.rejects(inspectLocalProject(invalid), (error: unknown) => {
    assert.ok(
      error instanceof Error &&
        !(error instanceof ProjectInitializationRequired),
    );
    assert.match(error.message, /Cannot read/);
    return true;
  });
});

test('a failed initial commit preserves files and Git state, releases its lock, and can be confirmed again', async (t) => {
  const data = await setup();
  t.after(() => rm(data.base, { recursive: true, force: true }));
  git(data.path, 'init', '-q', '-b', 'main');
  git(data.path, 'config', 'commit.gpgsign', 'true');
  git(data.path, 'config', 'gpg.format', 'openpgp');
  git(data.path, 'config', 'gpg.program', '/missing/workbench-signing-test');
  await writeFile(
    join(data.path, 'keep.txt'),
    'Must survive a signing failure',
  );
  await assert.rejects(
    initializeLocalProject(await required(data.path)),
    /sign|missing/,
  );
  assert.equal(
    await readFile(join(data.path, 'keep.txt'), 'utf8'),
    'Must survive a signing failure',
  );
  await assert.rejects(access(join(data.path, '.workbench-init.lock')));
  assert.equal((await required(data.path)).state, 'no-commit');
  git(data.path, 'config', 'commit.gpgsign', 'false');
  await initializeLocalProject(await required(data.path));
  assert.equal(
    git(data.path, 'show', 'HEAD:keep.txt'),
    'Must survive a signing failure',
  );
});

test('initialization transport requires authentication, same origin, explicit confirmation and validated folder identity', async (t) => {
  const data = await setup();
  const app = createWebWorkbench(origin, data);
  t.after(async () => {
    await app.close();
    await rm(data.base, { recursive: true, force: true });
  });
  const html = await (await app.fetch(new Request(origin))).text();
  const token = html.match(
    /name="workbench-token" content="([a-f0-9]{64})"/,
  )?.[1];
  assert.ok(token);
  const project = await required(data.path);
  const request = (body: unknown, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request(origin + '/api/project/initialize', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    );
  assert.equal((await request({ project, confirm: true })).status, 403);
  const headers = { 'x-workbench-token': token, origin };
  assert.equal(
    (
      await request(
        { project, confirm: true },
        { ...headers, origin: 'http://elsewhere.invalid' },
      )
    ).status,
    403,
  );
  for (const body of [
    { project },
    { project, confirm: false },
    { project, confirm: true, executable: '/bin/sh' },
    { project: { ...project, directoryId: 'bad' }, confirm: true },
  ])
    assert.equal((await request(body, headers)).status, 400);
  assert.equal(
    (
      await request(
        { project: { ...project, directoryId: '0:0' }, confirm: true },
        headers,
      )
    ).status,
    409,
  );
  await assert.rejects(access(join(data.path, '.git')));
  const client = createWorkbenchClient(origin, (input) => app.fetch(input));
  await client.connect();
  await client.initializeProject(project);
  assert.deepEqual((await client.poll()).runs, []);
});

test('Ink defaults to No, declines without writes, and Yes initializes once before the normal branch/create step', async (t) => {
  const data = await setup();
  await writeFile(join(data.path, 'existing.txt'), 'Initial source');
  const app = createWebWorkbench(origin, data);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  let finish: (() => Promise<void>) | undefined;
  let initializationRequests = 0;
  const transport = {
    ...client,
    initializeProject: (project: ProjectInitialization) => {
      initializationRequests++;
      return new Promise<Awaited<ReturnType<typeof client.initializeProject>>>(
        (done, fail) => {
          finish = async () => {
            try {
              done(await client.initializeProject(project));
            } catch (error) {
              fail(error);
            }
          };
        },
      );
    },
  };
  const ui = render(
    <WorkbenchApp
      client={transport}
      initial={await client.connect()}
      projectPath={data.path}
      pollInterval={20}
    />,
  );
  t.after(async () => {
    ui.unmount();
    ui.cleanup();
    await app.close();
    await rm(data.base, { recursive: true, force: true });
  });
  const frame = (text: string, present = true) =>
    until(() => Boolean(ui.lastFrame()?.includes(text)) === present).catch(
      () => {
        throw new Error(
          `Expected ${present ? '' : 'no '}${text}\n${ui.lastFrame()}`,
        );
      },
    );
  ui.stdin.write('n');
  await frame('New Session');
  ui.stdin.write('\r');
  await frame('Yes, initialize');
  ui.stdin.write('\r');
  await frame('Tab folders · Enter list branches');
  await assert.rejects(access(join(data.path, '.git')));
  ui.stdin.write('\r');
  await frame('Yes, initialize');
  ui.stdin.write('\u001b');
  await frame('Tab folders · Enter list branches');
  await assert.rejects(access(join(data.path, '.git')));
  ui.stdin.write('\r');
  await frame('Yes, initialize');
  ui.stdin.write('\u001b[200~y\u001b[201~');
  ui.stdin.write('\u001b[121;1:2u');
  await new Promise((done) => setTimeout(done, 40));
  assert.equal(initializationRequests, 0);
  await frame('Yes, initialize');
  ui.stdin.write('y');
  await frame('Initializing Git + first commit');
  ui.stdin.write('y');
  ui.stdin.write('\u001b');
  await new Promise((done) => setTimeout(done, 40));
  assert.equal(initializationRequests, 1);
  await frame('New Session');
  assert.ok(finish);
  await finish();
  await frame('Enter create');
  assert.deepEqual((await client.poll()).runs, []);
  // A key sent the moment the branches appear reaches Ink's previous handler.
  await new Promise((done) => setTimeout(done, 40));
  ui.stdin.write('\r');
  await frame('New Session', false);
  await until(async () => (await client.poll()).runs[0]?.state.kind === 'idle');
  const run = (await client.poll()).runs[0];
  assert.ok(run?.worktree);
  assert.equal(
    await readFile(join(run.environment.location, 'existing.txt'), 'utf8'),
    'Initial source',
  );
});

test('old daemons keep manual Git setup and a lost initialization reply is never automatically replayed', async (t) => {
  const data = await setup();
  const app = createWebWorkbench(origin, data);
  t.after(async () => {
    await app.close();
    await rm(data.base, { recursive: true, force: true });
  });
  const proposal = await required(data.path);
  let attempts = 0;
  const legacy = createWorkbenchClient(origin, async (request) => {
    if (new URL(request.url).pathname === '/api/project/initialize') attempts++;
    const response = await app.fetch(request);
    if (new URL(request.url).pathname !== '/api/state') return response;
    const state = stateSchema.parse(await response.json());
    return Response.json({
      ...state,
      features: { ...state.features, projectInitialization: false },
    });
  });
  await legacy.connect();
  await assert.rejects(
    legacy.project(data.path),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof ProjectInitializationRequired),
  );
  await assert.rejects(legacy.initializeProject(proposal), /updated/);
  assert.equal(attempts, 0);
  await assert.rejects(access(join(data.path, '.git')));
  const lost = createWorkbenchClient(origin, async (request) => {
    const response = await app.fetch(request);
    if (new URL(request.url).pathname === '/api/project/initialize') {
      attempts++;
      throw new Error('Reply lost after commit');
    }
    return response;
  });
  await lost.connect();
  await assert.rejects(lost.initializeProject(proposal), /uncertain; reload/);
  await lost.connect();
  assert.equal((await lost.project(data.path)).currentBranch, 'main');
  assert.equal(git(data.path, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(attempts, 1);
});

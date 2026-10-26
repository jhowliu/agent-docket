import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import { WorkbenchApp } from '../src/app/tui-app.js';
import { stateForRun, projectForRun } from '../src/app/workbench-work.js';
import { inspectLocalProject } from '../src/execution/index.js';
import type { RunId, LocalWorker } from '../src/execution/index.js';

const origin = 'http://127.0.0.1:4177';
const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('New Session condition timed out');
}
async function setup() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'workbench-sessions-')),
  );
  const paths = [
    join(directory, 'alpha project 中文'),
    join(directory, 'beta project'),
  ];
  for (const [index, path] of paths.entries()) {
    await mkdir(path);
    await writeFile(
      join(path, 'token.mjs'),
      await readFile('fixtures/project/token.mjs'),
    );
    await writeFile(
      join(path, index ? 'beta.txt' : 'alpha.txt'),
      index ? 'Beta' : 'Alpha',
    );
    git(path, 'init', '-q', '-b', 'main');
    git(path, 'config', 'user.name', 'Session Test');
    git(path, 'config', 'user.email', 'session@example.invalid');
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'Initial project');
  }
  const a = paths[0],
    b = paths[1];
  assert.ok(a && b);
  git(a, 'checkout', '-qb', 'workbench/saved-phase');
  await writeFile(join(a, 'continuation.txt'), 'Previously saved code');
  git(a, 'add', '.');
  git(a, 'commit', '-qm', 'Saved phase');
  git(a, 'checkout', '-q', 'main');
  const localWorker = {
    transport: 'local',
    workspaceRoot: join(directory, 'runs'),
    adapter: { file: process.execPath, args: [resolve('fixtures/agent.mjs')] },
  } satisfies LocalWorker;
  return {
    directory,
    a,
    b,
    localWorker,
    planDirectory: join(directory, 'plans'),
  };
}

test('New Session starts from saved local branches and keeps project plans, prompts and files separate', async (t) => {
  const setupData = await setup();
  const { directory, a, b } = setupData;
  let app = createWebWorkbench(origin, setupData);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const initial = await client.connect();
  assert.equal(initial.sessionOptions?.defaultPreset, 'codex-local');
  assert.deepEqual(initial.runs, []);
  const before = git(a, 'rev-parse', 'main');
  await writeFile(join(a, 'local-only.txt'), 'Uncommitted source file');
  const project = await client.project(a);
  const saved = project.branches.find(
    (branch) => branch.name === 'workbench/saved-phase',
  );
  assert.ok(saved);
  const one = await client.command({
    kind: 'new-session',
    presetId: 'codex-local',
    project: {
      path: a,
      base: { branch: saved.name, revision: saved.revision },
    },
  });
  const beta = await client.project(b);
  const two = await client.command({
    kind: 'new-session',
    presetId: 'codex-local',
    project: { path: b, base: { branch: 'main', revision: beta.head } },
  });
  assert.ok('runId' in one && 'runId' in two);
  let state = await client.poll();
  await until(async () => {
    state = await client.poll();
    return state.runs.every((run) => run.state.kind === 'idle');
  });
  const run = state.runs.find((run) => run.id === one.runId);
  assert.ok(run?.worktree);
  assert.equal(run.worktree.baseRevision, saved.revision);
  assert.equal(
    await readFile(join(run.environment.location, 'continuation.txt'), 'utf8'),
    'Previously saved code',
  );
  await assert.rejects(
    access(join(run.environment.location, 'local-only.txt')),
  );
  const alphaProject = projectForRun(state, one.runId),
    betaProject = projectForRun(state, two.runId);
  assert.ok(alphaProject && betaProject && alphaProject.id !== betaProject.id);
  for (const [projectId, runId, title] of [
    [alphaProject.id, one.runId, 'Alpha roadmap'],
    [betaProject.id, two.runId, 'Beta roadmap'],
  ] as const) {
    await client.command({
      kind: 'project-work',
      projectId,
      command: {
        kind: 'work.create',
        expectedRevision: 0,
        runId,
        title,
        phaseTitle: 'Build',
        taskTitle: title,
        spec: title + ' requirements',
      },
    });
    await client.command({ kind: 'prompt', runId, text: 'task-context' });
    await until(
      async () =>
        (await client.poll()).runs.find((run) => run.id === runId)?.state
          .kind === 'idle',
    );
  }
  state = await client.poll();
  assert.equal(
    stateForRun(state, one.runId).work?.plan?.title,
    'Alpha roadmap',
  );
  assert.equal(stateForRun(state, two.runId).source, b);
  const messages = (id: RunId) =>
    state.events
      .filter((event) => event.runId === id)
      .flatMap((event) => (event.type === 'agent.message' ? [event.text] : []))
      .join('');
  assert.match(messages(one.runId), /Alpha roadmap requirements/);
  assert.doesNotMatch(messages(one.runId), /Beta roadmap/);
  assert.match(messages(two.runId), /Beta roadmap requirements/);
  const alpha = stateForRun(state, one.runId).work?.plan;
  const betaPlan = stateForRun(state, two.runId).work?.plan;
  assert.ok(alpha && betaPlan && alpha.phases[0]?.tasks[0]);
  await assert.rejects(
    client.command({
      kind: 'project-work',
      projectId: betaProject.id,
      command: {
        kind: 'work.attach',
        expectedRevision: betaPlan.revision,
        runId: one.runId,
        taskId: alpha.phases[0].tasks[0].id,
      },
    }),
    /another project/,
  );
  const treeA = await client.directory(one.runId);
  assert.ok(
    treeA.kind === 'ready' &&
      treeA.entries.some((entry) => entry.name === 'alpha.txt'),
  );
  const treeB = await client.directory(two.runId);
  assert.ok(
    treeB.kind === 'ready' &&
      treeB.entries.some((entry) => entry.name === 'beta.txt'),
  );

  await writeFile(
    join(run.environment.location, 'next.txt'),
    'Next phase code',
  );
  // Cancelling commits the work to the Run branch, so a new Session continues it.
  await client.command({ kind: 'cancel', runId: one.runId });
  const branch = (await client.project(a)).branches.find(
    (branch) => branch.name === run.worktree?.branch,
  );
  assert.ok(branch);
  const continued = await client.command({
    kind: 'new-session',
    presetId: 'codex-local',
    project: {
      path: a,
      base: { branch: branch.name, revision: branch.revision },
    },
  });
  assert.ok('runId' in continued);
  await until(
    async () =>
      (await client.poll()).runs.find((run) => run.id === continued.runId)
        ?.state.kind === 'idle',
  );
  state = await client.poll();
  const next = state.runs.find((run) => run.id === continued.runId);
  assert.ok(next?.worktree && next.worktree.branch !== run.worktree.branch);
  assert.equal(
    await readFile(join(next.environment.location, 'next.txt'), 'utf8'),
    'Next phase code',
  );
  assert.equal(
    stateForRun(state, continued.runId).work?.plan?.title,
    'Alpha roadmap',
  );
  assert.equal(stateForRun(state, continued.runId).work?.bindings.length, 0);
  assert.equal(git(a, 'rev-parse', 'main'), before);
  assert.equal(
    await readFile(join(a, 'local-only.txt'), 'utf8'),
    'Uncommitted source file',
  );

  await app.close();
  app = createWebWorkbench(origin, setupData);
  state = await client.poll();
  assert.deepEqual(state.runs, []);
  const restarted = await client.command({
    kind: 'new-session',
    presetId: 'codex-local',
    project: { path: b, base: { branch: 'main', revision: beta.head } },
  });
  assert.ok('runId' in restarted);
  state = await client.poll();
  assert.equal(
    stateForRun(state, restarted.runId).work?.plan?.title,
    'Beta roadmap',
  );
  assert.deepEqual(stateForRun(state, restarted.runId).work?.bindings, []);
  for (const file of await readdir(setupData.planDirectory))
    assert.doesNotMatch(
      await readFile(join(setupData.planDirectory, file), 'utf8'),
      /run-|attn-|"events"/,
    );
});

test('project inspection is authenticated/read-only, canonical across worktrees, and stale branches fail without creating a Run', async (t) => {
  const data = await setup();
  const { directory, a } = data;
  const app = createWebWorkbench(origin, data);
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const anonymous = await app.fetch(
    new Request(origin + '/api/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: a }),
    }),
  );
  assert.equal(anonymous.status, 403);
  const before = git(a, 'worktree', 'list', '--porcelain');
  const project = await client.project(a);
  assert.equal(git(a, 'worktree', 'list', '--porcelain'), before);
  assert.deepEqual((await client.poll()).runs, []);
  const link = join(directory, 'project link');
  await symlink(a, link);
  assert.equal((await client.project(link)).path, a);
  const linked = join(directory, 'linked');
  git(a, 'worktree', 'add', '--detach', linked, 'main');
  const other = await inspectLocalProject(linked);
  assert.equal(other.identityPath, project.identityPath);
  assert.equal(other.currentBranch, null);
  git(a, 'worktree', 'remove', linked);
  const saved = project.branches.find(
    (branch) => branch.name === 'workbench/saved-phase',
  );
  assert.ok(saved);
  git(a, 'branch', '-f', saved.name, 'main');
  await assert.rejects(
    client.command({
      kind: 'new-session',
      presetId: 'codex-local',
      project: {
        path: a,
        base: { branch: saved.name, revision: saved.revision },
      },
    }),
    /Starting branch changed/,
  );
  await assert.rejects(
    client.command({
      kind: 'new-session',
      presetId: 'other-provider',
      project: { path: a, base: { revision: project.head } },
    }),
    /preset is unavailable/,
  );
  await assert.rejects(
    client.command({
      kind: 'new-session',
      presetId: 'codex-local',
      project: { path: a, base: { branch: '--help', revision: project.head } },
    }),
    /unavailable/,
  );
  await assert.rejects(
    client.command({
      kind: 'new-session',
      presetId: 'fixture',
      project: { path: a, base: { revision: project.head } },
    }),
    /configured project/,
  );
  assert.deepEqual((await client.poll()).runs, []);
});

test('Ink New Session uses its launch folder, filters saved branches, cancels safely and switches project context', async (t) => {
  const data = await setup();
  const app = createWebWorkbench(origin, {
    ...data,
    defaultProjectPath: data.b,
  });
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  const initial = await client.connect();
  const ui = render(
    <WorkbenchApp
      client={client}
      initial={initial}
      projectPath={data.a}
      pollInterval={20}
    />,
  );
  t.after(async () => {
    ui.unmount();
    ui.cleanup();
    await app.close();
    await rm(data.directory, { recursive: true, force: true });
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
  assert.equal((await client.poll()).runs.length, 0);
  ui.stdin.write('\u001b');
  await frame('New Session', false);
  ui.stdin.write('n');
  await frame('New Session');
  ui.stdin.write('\r');
  await frame('Enter create');
  await new Promise((done) => setTimeout(done, 40));
  ui.stdin.write('saved');
  await frame('Branch saved');
  ui.stdin.write('\r');
  await frame('New Session', false);
  await until(async () => (await client.poll()).runs[0]?.state.kind === 'idle');
  const one = (await client.poll()).runs[0];
  assert.ok(one);
  assert.equal(
    await readFile(join(one.environment.location, 'continuation.txt'), 'utf8'),
    'Previously saved code',
  );
  await frame('Idle');
  await frame('Sending', false);
  ui.stdin.write(':');
  await frame('Command · Enter');
  ui.stdin.write('roadmap Alpha scope');
  await frame(': roadmap Alpha scope');
  ui.stdin.write('\r');
  // Two projects at 24 rows leave the Workflow compact; its stage still shows.
  await frame('> Requirement clarification');
  ui.stdin.write('n');
  await frame('New Session');
  ui.stdin.write('\u0015');
  await new Promise((done) => setTimeout(done, 30));
  ui.stdin.write(data.b);
  await new Promise((done) => setTimeout(done, 30));
  ui.stdin.write('\r');
  await frame('Enter create');
  await new Promise((done) => setTimeout(done, 40));
  ui.stdin.write('\r');
  await frame('New Session', false);
  // Selecting a Run switches to its project's Workflow; beta has none.
  await frame('> Run 2');
  await frame('> Requirement clarification', false);
  ui.stdin.write('k');
  await frame('> Run 1');
  await frame('> Requirement clarification');
  ui.stdin.write('j');
  await frame('> Run 2');
  await frame('> Requirement clarification', false);
  // New Session starts in the selected Run's project, not the launch folder.
  ui.stdin.write('n');
  await frame('New Session');
  await frame(data.b.split('/').slice(-2).join('/'));
  ui.stdin.write('\u001b');
  await frame('New Session', false);
  assert.equal((await client.poll()).runs.length, 2);
  for (const row of (ui.lastFrame() ?? '').split('\n'))
    assert.ok(stringWidth(row) <= 100, row);
});

test('closing New Session while a project lookup is pending ignores its late result', async (t) => {
  const data = await setup();
  const app = createWebWorkbench(origin, data);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  const initial = await client.connect();
  let finish:
    | ((project: Awaited<ReturnType<typeof client.project>>) => void)
    | undefined;
  const deferred = new Promise<Awaited<ReturnType<typeof client.project>>>(
    (done) => {
      finish = done;
    },
  );
  const slow = { ...client, project: () => deferred };
  const ui = render(
    <WorkbenchApp
      client={slow}
      initial={initial}
      projectPath={data.a}
      pollInterval={20}
    />,
  );
  t.after(async () => {
    ui.unmount();
    ui.cleanup();
    await app.close();
    await rm(data.directory, { recursive: true, force: true });
  });
  const frame = (text: string, present = true) =>
    until(() => Boolean(ui.lastFrame()?.includes(text)) === present);
  ui.stdin.write('n');
  await frame('New Session');
  ui.stdin.write('\r');
  await frame('Reading project branches');
  ui.stdin.write('\u001b');
  await frame('New Session', false);
  assert.ok(finish);
  finish(await client.project(data.a));
  await new Promise((done) => setTimeout(done, 30));
  assert.equal((await client.poll()).runs.length, 0);
  ui.stdin.write('n');
  await frame('New Session');
  assert.doesNotMatch(
    ui.lastFrame() ?? '',
    /Enter create|workbench\/saved-phase/,
  );
});

test('Tab browses folders, distinguishes links, preserves Agent focus and accepts a folder without starting a Run', async (t) => {
  const data = await setup();
  await symlink(data.a, join(data.directory, 'linked project'));
  const app = createWebWorkbench(origin, data);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  await client.command({ kind: 'start' });
  const ui = render(
    <WorkbenchApp
      client={client}
      initial={await client.poll()}
      projectPath={data.directory}
      pollInterval={20}
    />,
  );
  t.after(async () => {
    ui.unmount();
    ui.cleanup();
    await app.close();
    await rm(data.directory, { recursive: true, force: true });
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
  ui.stdin.write('\u001b[Z');
  await frame('Agent >');
  ui.stdin.write('\u001b[C');
  await frame('Fixture · no model');
  ui.stdin.write('\u001b[D');
  await frame('Codex · local');
  ui.stdin.write('\t');
  await frame('Agent >', false);
  await new Promise((done) => setTimeout(done, 30));
  ui.stdin.write('\t');
  await frame('↑↓←→/Tab · Enter use');
  await frame('> alpha project 中文/');
  await frame('beta project/');
  await frame('linked project@/');
  assert.equal((await client.poll()).runs.length, 1);
  ui.stdin.write('\u001b[B');
  await frame('> beta project/');
  ui.stdin.write('\u001b[A');
  await frame('> alpha project 中文/');
  ui.stdin.write('\r');
  await frame('Tab folders · Enter list branches');
  await frame('linked project@/', false);
  assert.equal((await client.poll()).runs.length, 1);
  ui.stdin.write('q');
  await frame('中文/q');
  ui.stdin.write('\u007f');
  await frame('中文/q', false);
  ui.stdin.write('\t');
  await frame('No matching folders');
  ui.stdin.write('\u001b');
  await frame('No matching folders', false);
  await frame('New Session');
  ui.stdin.write('\r');
  await frame('Enter create');
  await new Promise((done) => setTimeout(done, 40));
  ui.stdin.write('\r');
  await frame('New Session', false);
  await until(async () => (await client.poll()).runs[1]?.state.kind === 'idle');
  const run = (await client.poll()).runs[1];
  assert.ok(run?.worktree);
  assert.equal(
    await readFile(join(run.environment.location, 'alpha.txt'), 'utf8'),
    'Alpha',
  );
});

test('unique folder completion moves the caret to the completed path and late folder reads cannot overwrite edits or reopen the form', async (t) => {
  const data = await setup();
  const single = join(data.directory, 'single');
  await mkdir(join(single, 'only child 中文'), { recursive: true });
  const app = createWebWorkbench(origin, data);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  const initial = await client.connect();
  let finish:
    | ((value: Awaited<ReturnType<typeof client.folders>>) => void)
    | undefined;
  const deferred = new Promise<Awaited<ReturnType<typeof client.folders>>>(
    (done) => {
      finish = done;
    },
  );
  let delayed = true;
  const transport = {
    ...client,
    folders: (path: string) => (delayed ? deferred : client.folders(path)),
  };
  const ui = render(
    <WorkbenchApp
      client={transport}
      initial={initial}
      projectPath={single}
      pollInterval={20}
    />,
  );
  t.after(async () => {
    ui.unmount();
    ui.cleanup();
    await app.close();
    await rm(data.directory, { recursive: true, force: true });
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
  ui.stdin.write('\t');
  await frame('Reading folders');
  ui.stdin.write('changed');
  await frame('singlechanged');
  assert.ok(finish);
  finish(await client.folders(single));
  await new Promise((done) => setTimeout(done, 30));
  await frame('only child', false);
  await frame('singlechanged');
  ui.stdin.write('\u001b');
  await frame('New Session', false);
  delayed = false;
  ui.stdin.write('n');
  await frame('New Session');
  ui.stdin.write('\t');
  await frame('only child 中文/');
  await frame('↑↓←→/Tab · Enter use', false);
  ui.stdin.write('x');
  await frame('only child 中文/x');
  assert.equal((await client.poll()).runs.length, 0);
});

test('folder columns follow terminal width, arrows and Tab keep selection visible, and shortened names retain their full paths', async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'workbench-folder-grid-')),
  );
  const names = [
    '01-alpha 中文',
    '02-beta',
    '03-a-very-long-資料夾-with-e\u0301-and-👩🏽‍💻-that-must-keep-its-full-path',
    '04-delta',
    '05-epsilon',
    '06-zeta',
    '07-eta',
    '08-theta',
    '09-iota',
    '10-kappa',
    '11-linked 中文',
  ] as const;
  await Promise.all(
    names.slice(0, -1).map((name) => mkdir(join(directory, name))),
  );
  await symlink(join(directory, names[0]), join(directory, names[10]));
  const app = createWebWorkbench(origin, {
    localWorker: {
      transport: 'local',
      workspaceRoot: join(directory, 'runs'),
      adapter: {
        file: process.execPath,
        args: [resolve('fixtures/agent.mjs')],
      },
    },
  });
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  const requests: string[] = [];
  const ui = render(
    <WorkbenchApp
      client={{
        ...client,
        folders: (path) => {
          requests.push(path);
          return client.folders(path);
        },
      }}
      initial={await client.connect()}
      projectPath={directory}
      pollInterval={20}
    />,
  );
  t.after(async () => {
    ui.unmount();
    ui.cleanup();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const plain = () => stripVTControlCharacters(ui.lastFrame() ?? '');
  const frame = (text: string) =>
    until(() => plain().includes(text)).catch(() => {
      throw new Error(`Expected ${text}\n${plain()}`);
    });
  function resize(columns: number, rows: number) {
    Object.defineProperty(ui.stdout, 'columns', {
      configurable: true,
      value: columns,
    });
    Object.defineProperty(ui.stdout, 'rows', {
      configurable: true,
      value: rows,
    });
    ui.stdout.emit('resize');
  }
  resize(120, 36);
  ui.stdin.write('n');
  await frame('New Session');
  ui.stdin.write('\t');
  await frame('1–9/11');
  assert.match(plain(), /> 01-alpha 中文\/ +04-delta\/ +07-eta\//);
  assert.match(plain(), /03-a-very-long-.*…\//);
  assert.doesNotMatch(plain(), /10-kappa\//);
  for (const [key, selected] of [
    ['\u001b[C', '> 04-delta/'],
    ['\u001b[B', '> 05-epsilon/'],
    ['\u001b[D', '> 02-beta/'],
    ['\u001b[C', '> 05-epsilon/'],
    ['\u001b[C', '> 08-theta/'],
    ['\u001b[B', '> 09-iota/'],
    ['\u001b[C', '> 11-linked 中文@/'],
    ['\u001b[A', '> 10-kappa/'],
    ['\t', '> 11-linked 中文@/'],
    ['\t', '> 01-alpha 中文/'],
    ['\u001b[B', '> 02-beta/'],
    ['\u001b[B', '> 03-a-very-long-'],
  ]) {
    assert.ok(key && selected);
    ui.stdin.write(key);
    await frame(selected);
    if (selected.includes('11-linked') || selected.includes('10-kappa'))
      assert.ok(plain().includes('10–11/11'));
  }
  // The modal is wider than the old inline form: three columns fit at 80.
  for (const [columns, rows, page] of [
    [80, 24, '1–9/11'],
    [60, 20, '1–6/11'],
  ] as const) {
    resize(columns, rows);
    await frame(page);
    await new Promise((done) => setTimeout(done, 30));
    assert.match(plain(), /> 03-a-very-long-.*…\//);
    assert.ok(plain().split('\n').length <= rows);
    for (const row of plain().split('\n'))
      assert.ok(stringWidth(row) <= columns, row);
  }
  ui.stdin.write('\r');
  await frame('Tab folders · Enter list branches');
  ui.stdin.write('\t');
  await frame('No matching folders');
  assert.equal(requests.at(-1), join(directory, names[2]));
  ui.stdin.write('\u001b');
  await frame('Tab folders · Enter list branches');
  ui.stdin.write('\u001b[D');
  await new Promise((done) => setTimeout(done, 30));
  ui.stdin.write('X');
  await new Promise((done) => setTimeout(done, 30));
  ui.stdin.write('\t');
  await frame('No matching folders');
  assert.equal(requests.at(-1), join(directory, names[2] + 'X'));
  assert.equal((await client.poll()).runs.length, 0);
});

test('New Session on an older daemon keeps manual paths and never requests unsupported folder completion', async (t) => {
  const data = await setup();
  const app = createWebWorkbench(origin, data);
  let folderRequests = 0;
  const client = createWorkbenchClient(origin, async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/api/project/folders') folderRequests++;
    const response = await app.fetch(request);
    if (path !== '/api/state') return response;
    const body: unknown = await response.json();
    assert.ok(
      body &&
        typeof body === 'object' &&
        'features' in body &&
        body.features &&
        typeof body.features === 'object',
    );
    return Response.json({
      ...body,
      features: { ...body.features, folderCompletion: false },
    });
  });
  const ui = render(
    <WorkbenchApp
      client={client}
      initial={await client.connect()}
      projectPath={data.a}
      pollInterval={20}
    />,
  );
  t.after(async () => {
    ui.unmount();
    ui.cleanup();
    await app.close();
    await rm(data.directory, { recursive: true, force: true });
  });
  const frame = (text: string, present = true) =>
    until(() => Boolean(ui.lastFrame()?.includes(text)) === present);
  ui.stdin.write('n');
  await frame('New Session');
  ui.stdin.write('\t');
  await frame('needs an updated server');
  assert.equal(folderRequests, 0);
  ui.stdin.write('\u001b');
  await frame('needs an updated server', false);
  ui.stdin.write('\r');
  await frame('Enter create');
  assert.equal(folderRequests, 0);
  assert.equal((await client.poll()).runs.length, 0);
});

test('New Session is a centered modal over the workspace, sized by its branches, and creates from a shortened Run branch by its full name', async (t) => {
  const data = await setup();
  const runBranch = 'workbench/run-ce39dd78-321c-4bff-b0c6-35a76c23b7d7';
  for (const name of [runBranch, ...[1, 2, 3, 4, 5].map((n) => `feature-${n}`)])
    git(data.a, 'branch', name);
  const app = createWebWorkbench(origin, data);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  const ui = render(
    <WorkbenchApp
      client={client}
      initial={await client.connect()}
      projectPath={data.a}
      pollInterval={20}
    />,
  );
  t.after(async () => {
    ui.unmount();
    ui.cleanup();
    await app.close();
    await rm(data.directory, { recursive: true, force: true });
  });
  const plain = () => stripVTControlCharacters(ui.lastFrame() ?? '');
  const frame = (text: string, present = true) =>
    until(() => plain().includes(text) === present).catch(() => {
      throw new Error(`Expected ${present ? '' : 'no '}${text}\n${plain()}`);
    });
  function resize(columns: number, rows: number) {
    Object.defineProperty(ui.stdout, 'columns', {
      configurable: true,
      value: columns,
    });
    Object.defineProperty(ui.stdout, 'rows', {
      configurable: true,
      value: rows,
    });
    ui.stdout.emit('resize');
  }
  /** Rows of the modal frame and branch entries within it. */
  const modal = () => {
    const rows = plain().split('\n');
    const top = rows.findIndex((row) => row.includes('╭'));
    const bottom = rows.findIndex((row) => row.includes('╰'));
    const inside = rows.slice(top + 1, bottom);
    return {
      rows,
      top,
      height: bottom - top + 1,
      branches: inside.filter((row) =>
        /(main|feature-\d|saved-phase|run-ce39dd78…) · [0-9a-f]{7}/.test(row),
      ).length,
    };
  };
  resize(80, 24);
  await frame('1 Live');
  ui.stdin.write('n');
  await frame('New Session');
  // The workspace stays behind the modal; the title sits right under its frame.
  const opened = modal();
  assert.ok(plain().includes('1 Live'), plain());
  assert.ok(opened.rows[opened.top + 1]?.includes('New Session'), plain());
  ui.stdin.write('\r');
  await frame('Enter create');
  await until(() => modal().branches === 8);
  assert.ok(plain().includes('workbench/run-ce39dd78… · '), plain());
  assert.ok(!plain().includes(runBranch), plain());
  for (const [columns, height] of [
    [60, 20],
    [120, 36],
  ] as const) {
    resize(columns, height);
    // Wait for the resized frame, not the previous one.
    await until(
      () =>
        modal().branches === 8 &&
        modal().rows.length === height &&
        modal().rows.every((row) => stringWidth(row) <= columns),
    ).catch(() => {
      throw new Error(
        `Expected 8 branches at ${columns}×${height}\n${plain()}`,
      );
    });
    const { rows, top, height: tall } = modal();
    assert.ok(rows.length <= height, plain());
    for (const row of rows) assert.ok(stringWidth(row) <= columns, row);
    // Centered: the space above and below the frame differs by at most one row.
    assert.ok(Math.abs(top - (height - top - tall)) <= 1, plain());
  }
  const before = modal().height;
  ui.stdin.write('run-ce39');
  await frame('> workbench/run-ce39dd78… · ');
  // Filtering does not resize the modal.
  assert.equal(modal().height, before, plain());
  ui.stdin.write('\r');
  await frame('New Session', false);
  await until(async () => (await client.poll()).runs[0]?.state.kind === 'idle');
  const [run] = (await client.poll()).runs;
  assert.equal(
    run?.worktree?.baseRevision,
    git(data.a, 'rev-parse', runBranch),
  );
});

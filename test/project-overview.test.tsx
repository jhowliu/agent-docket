import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderToString } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { createAttention } from '../src/attention/index.js';
import { createProjectWorkspaces } from '../src/work/index.js';
import type { Evidence } from '../src/evidence/index.js';
import type { ProjectOverview } from '../src/work/index.js';
import type {
  LocalWorker,
  RunId,
  RunSnapshot,
  RunState,
  WorktreeSnapshot,
} from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import { WorkbenchApp } from '../src/app/tui-app.js';
import { WorkbenchScreen, workbenchMainWidth } from '../src/app/tui-view.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';

async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('Overview condition timed out');
}
// Overview and session tests never verify.
const noEvidence: Evidence = {
  verify: () => Promise.reject(new Error('Not used')),
  assess: () => null,
};
function fakeExecution() {
  const runs: RunSnapshot[] = [];
  const launched: string[] = [];
  return {
    runs,
    launched,
    add(
      id: RunId,
      state: RunState,
      worktree?: WorktreeSnapshot['status'],
    ): RunId {
      runs.push({
        id,
        provider: 'fixture',
        label: id,
        state,
        environment: { kind: 'trusted-fixture-directory', location: '/unused' },
        capabilities: null,
        ...(worktree
          ? {
              worktree: {
                path: '/unused',
                branch: `workbench/${id}`,
                baseRevision: 'a'.repeat(40),
                status: worktree,
              },
            }
          : {}),
      });
      return id;
    },
    execution: {
      list: () => runs,
      snapshot(id: RunId) {
        const run = runs.find((item) => item.id === id);
        if (!run) throw new Error('Unknown Run');
        return run;
      },
      submit() {},
      subscribe: () => () => {},
      async start(input: { label?: string }) {
        launched.push(input.label ?? 'start');
        const run = runs.at(-1);
        assert.ok(run);
        return run;
      },
      launch(): RunSnapshot {
        throw new Error('Only fixture launches are expected');
      },
    },
  };
}
const summary = (
  overview: readonly ProjectOverview[],
  names: Map<string, string>,
) =>
  overview.map(
    ({ projectId, next, runs }) =>
      `${names.get(projectId)} → ${next?.runId ?? '-'}: ${runs.map((run) => `${run.runId}=${run.next}`).join(' ')}`,
  );

test("overview puts Runs that ask something of the person first, keeps launch order otherwise and names each project's next action", () => {
  const fake = fakeExecution();
  const attention = createAttention();
  const workspaces = createProjectWorkspaces({
    execution: fake.execution,
    attention,
    evidence: noEvidence,
  });
  const names = new Map<string, string>();
  const project = (name: string) => {
    const id = workspaces.register(`directory:/${name}`, `/${name}`);
    names.set(id, name);
    return id;
  };
  const [a, b, c, d, e, f, g] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(
    project,
  );
  assert.ok(a && b && c && d && e && f && g);
  const runs = [
    [a, fake.add('run-a1', { kind: 'running' })],
    [a, fake.add('run-a2', { kind: 'idle' })],
    [a, fake.add('run-a3', { kind: 'authentication-required', methods: [] })],
    [b, fake.add('run-b1', { kind: 'idle' })],
    [b, fake.add('run-b2', { kind: 'running' })],
    [
      c,
      fake.add(
        'run-c1',
        { kind: 'cancelled' },
        { kind: 'commit-required', changes: 2 },
      ),
    ],
    [c, fake.add('run-c2', { kind: 'failed', reason: 'exit 17' })],
    [e, fake.add('run-e1', { kind: 'idle' })],
    [
      f,
      fake.add(
        'run-f1',
        { kind: 'closed' },
        { kind: 'retained', reason: 'busy' },
      ),
    ],
    [g, fake.add('run-g1', { kind: 'running' })],
    [g, fake.add('run-g2', { kind: 'idle' })],
  ] as const;
  for (const [projectId, runId] of runs) workspaces.associate(projectId, runId);
  // A Run without a project is not placed in any project.
  fake.add('run-x', { kind: 'idle' });
  const approval = attention.request({
    runId: 'run-b2',
    title: 'Edit token.mjs',
    detail: '',
    choices: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
  });
  attention.ask({
    runId: 'run-e1',
    request: 'question',
    title: 'Which port?',
    steps: [],
  });
  assert.deepEqual(summary(workspaces.overview(), names), [
    'b → run-b2: run-b2=approve run-b1=prompt',
    'e → run-e1: run-e1=respond',
    'a → run-a3: run-a3=sign-in run-a1=working run-a2=prompt',
    'c → run-c1: run-c1=commit run-c2=ended',
    'f → run-f1: run-f1=worktree',
    // Waiting for a prompt is the next action, but the Runs keep launch order.
    'g → run-g2: run-g1=working run-g2=prompt',
    'd → -: ',
  ]);
  // An answered approval no longer asks anything of the person.
  assert.equal(attention.answer(approval.id, 'allow'), 'accepted');
  assert.deepEqual(summary(workspaces.overview(), names), [
    'e → run-e1: run-e1=respond',
    'a → run-a3: run-a3=sign-in run-a1=working run-a2=prompt',
    'c → run-c1: run-c1=commit run-c2=ended',
    'f → run-f1: run-f1=worktree',
    'b → run-b1: run-b1=prompt run-b2=working',
    'g → run-g2: run-g1=working run-g2=prompt',
    'd → -: ',
  ]);
  attention.close();
});

test('startSession starts nothing for an unknown project or a launch without a starting branch', async () => {
  const fake = fakeExecution();
  const attention = createAttention();
  const workspaces = createProjectWorkspaces({
    execution: fake.execution,
    attention,
    evidence: noEvidence,
  });
  await assert.rejects(
    workspaces.startSession({ provider: 'fixture' }),
    /Choose a Git project and starting branch/,
  );
  await assert.rejects(
    workspaces.startSession({
      provider: 'codex',
      worker: { transport: 'local', workspaceRoot: '/unused' },
      source: { kind: 'directory', path: '/unused' },
    }),
    /Choose a Git project and starting branch/,
  );
  await assert.rejects(
    workspaces.startSession({ provider: 'fixture' }, 'f'.repeat(64)),
    /Project is unavailable/,
  );
  assert.deepEqual(fake.launched, []);
  const projectId = workspaces.register('fixture:/project', '/project');
  fake.add('run-new', { kind: 'idle' });
  const started = await workspaces.startSession(
    { provider: 'fixture', label: 'fixture / run-1' },
    projectId,
  );
  assert.equal(started.projectId, projectId);
  assert.deepEqual(fake.launched, ['fixture / run-1']);
  // Associated before startSession returns.
  assert.deepEqual(workspaces.overview()[0], {
    projectId,
    next: { runId: 'run-new', next: 'prompt' },
    runs: [{ runId: 'run-new', next: 'prompt' }],
  });
  attention.close();
});

const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

test('Ink groups Runs by project, puts the project waiting on an approval first and follows that order with j/k', async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'workbench-overview-')),
  );
  const paths = [join(directory, 'alpha'), join(directory, 'beta')];
  for (const path of paths) {
    await mkdir(path);
    await writeFile(
      join(path, 'token.mjs'),
      await readFile('fixtures/project/token.mjs'),
    );
    git(path, 'init', '-q', '-b', 'main');
    git(path, 'config', 'user.name', 'Overview Test');
    git(path, 'config', 'user.email', 'overview@example.invalid');
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'Initial project');
  }
  const origin = 'http://127.0.0.1:4177';
  const app = createWebWorkbench(origin, {
    localWorker: {
      transport: 'local',
      workspaceRoot: join(directory, 'runs'),
      adapter: {
        file: process.execPath,
        args: [resolve('fixtures/agent.mjs')],
      },
    } satisfies LocalWorker,
    planDirectory: join(directory, 'plans'),
  });
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect();
  const ids: RunId[] = [];
  for (const path of paths) {
    const project = await client.project(path);
    const started = await client.command({
      kind: 'new-session',
      presetId: 'codex-local',
      project: { path, base: { branch: 'main', revision: project.head } },
    });
    assert.ok('runId' in started);
    ids.push(started.runId);
  }
  const [alpha, beta] = ids;
  assert.ok(alpha && beta);
  let state = await client.poll();
  await until(async () => {
    state = await client.poll();
    return state.runs.every((run) => run.state.kind === 'idle');
  });
  const ui = render(
    <WorkbenchApp client={client} initial={state} pollInterval={20} />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  // The left column: spaces (a glyph, the project, its next action beneath),
  // then agents in the same order.
  const left = (frame: string) =>
    frame.split('\n').map((row) => row.slice(0, 100 - workbenchMainWidth(100)));
  const rowOf = (text: string) =>
    left(ui.lastFrame() ?? '').findIndex((row) => row.includes(text));
  const space = (name: string, frame = ui.lastFrame() ?? '') =>
    left(frame).findIndex((row) => new RegExp(`^. ${name}\\b`).test(row));
  const frame = (text: string) =>
    until(() => rowOf(text) >= 0).catch(() => {
      throw new Error(`Expected ${text}\n${ui.lastFrame()}`);
    });
  // Equal next actions keep launch order.
  await frame('prompt Run 1');
  await frame('prompt Run 2');
  assert.ok(space('alpha') < space('beta'), ui.lastFrame());
  assert.equal(rowOf('prompt Run 1'), space('alpha') + 1, ui.lastFrame());
  assert.ok(rowOf('> Run 1') < rowOf('Run 2 ·'), ui.lastFrame());
  // Agents sit under their project's label; their second line names the provider.
  const label = (name: string) =>
    left(ui.lastFrame() ?? '').findIndex((row) =>
      new RegExp(`^${name} ─`).test(row),
    );
  assert.equal(label('alpha') + 1, rowOf('> Run 1'), ui.lastFrame());
  assert.equal(label('beta') + 1, rowOf('Run 2 ·'), ui.lastFrame());
  assert.match(
    left(ui.lastFrame() ?? '')[rowOf('> Run 1') + 1] ?? '',
    /idle · codex/,
  );
  await client.command({
    kind: 'prompt',
    runId: beta,
    text: 'command-permission',
  });
  await frame('approve Run 2');
  assert.ok(space('beta') < space('alpha'), ui.lastFrame());
  assert.equal(rowOf('approve Run 2'), space('beta') + 1, ui.lastFrame());
  assert.ok(rowOf('Run 2 ·') < rowOf('> Run 1'), ui.lastFrame());
  // Run 1 is now last in the roster; k moves up the grouped order to Run 2.
  ui.stdin.write('j');
  await frame('> Run 1');
  ui.stdin.write('k');
  await frame('> Run 2');
  await until(() => (ui.lastFrame() ?? '').includes('APPROVAL 1/1'));
  ui.stdin.write('a');
  await frame('prompt Run 1');
  await until(() => space('alpha') < space('beta'));
  await frame('> Run 2');
  for (const row of (ui.lastFrame() ?? '').split('\n'))
    assert.ok(stringWidth(row) <= 100, row);

  // A daemon from before the overview groups by project in launch order, without next actions.
  state = await client.poll();
  const { overview, ...older } = state;
  assert.ok(overview);
  const screen = (state: WorkbenchState) =>
    renderToString(
      <WorkbenchScreen
        state={state}
        selectedId={alpha}
        filter="active"
        view="timeline"
        offset={0}
        request={undefined}
        armed
        connected
        busy={false}
        note=""
        options={false}
        help={false}
        details={false}
        outline={false}
        outlinePhase={0}
        mode="normal"
        columns={100}
        rows={30}
      />,
      { columns: 100 },
    );
  let output = screen(older satisfies WorkbenchState);
  assert.doesNotMatch(output, /next: |prompt Run/);
  // Spaces still lead with each project's most urgent glyph; both are idle.
  assert.ok(
    space('alpha', output) >= 0 &&
      space('beta', output) > space('alpha', output),
    output,
  );
  assert.match(left(output)[space('alpha', output)] ?? '', /^○ alpha/);
  assert.ok(output.indexOf('> Run 1') < output.indexOf('Run 2 ·'), output);
  // Without projects either, the agents stay a flat launch-order list.
  const { projects, ...oldest } = older;
  assert.ok(projects);
  output = screen(oldest satisfies WorkbenchState);
  assert.doesNotMatch(output, /^spaces/m);
  assert.ok(output.indexOf('> Run 1') < output.indexOf('Run 2 ·'), output);
});

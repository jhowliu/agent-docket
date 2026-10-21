import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createExecution, parseLaunch } from '../src/execution/index.js';
import type { Launch } from '../src/execution/index.js';
import { createAttention } from '../src/attention/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';

async function until<T>(
  read: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Native launch condition timed out');
}
const observationSchema = z.object({
  home: z.string(),
  codexHome: z.string(),
  temporary: z.string(),
  cwd: z.string(),
  injectedHostSetting: z.null(),
  mode: z.literal('workspace-write'),
  auth: z.object({ test: z.string() }).optional(),
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-native-test-'));
  const source = join(directory, 'source');
  await mkdir(source);
  await writeFile(
    join(source, 'token.mjs'),
    await readFile('fixtures/project/token.mjs'),
  );
  const launch: Launch = {
    provider: 'codex',
    worker: {
      transport: 'local',
      workspaceRoot: join(directory, 'runs'),
      adapter: {
        file: process.execPath,
        args: [resolve('fixtures/local-agent.mjs')],
      },
    },
    source: { kind: 'directory', path: source },
  };
  return { directory, source, launch };
}

test('explicit local Runs have separate code/config copies and retain edits after cancellation', async (t) => {
  const { directory, source, launch } = await setup();
  const attention = createAttention(),
    execution = createExecution({ attention });
  t.after(async () => {
    await execution.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.notEqual(launch.provider, 'fixture');
  if (launch.worker.transport !== 'local')
    throw new Error('Expected local launch');
  const authFile = join(directory, 'auth.json');
  await writeFile(authFile, JSON.stringify({ test: 'original' }));
  await writeFile(join(source, '.env'), 'DO_NOT_COPY=1');
  await mkdir(join(source, 'node_modules'));
  await writeFile(join(source, 'node_modules', 'ignored'), 'dependency');
  await symlink(join(source, 'token.mjs'), join(source, 'linked.mjs'));
  const hostValue = process.env['WORKBENCH_TEST_HOST_SETTING'];
  process.env['WORKBENCH_TEST_HOST_SETTING'] = 'must not be inherited';
  t.after(() => {
    if (hostValue === undefined)
      delete process.env['WORKBENCH_TEST_HOST_SETTING'];
    else process.env['WORKBENCH_TEST_HOST_SETTING'] = hostValue;
  });
  const configured = { ...launch, worker: { ...launch.worker, authFile } };
  const one = await execution.start(configured),
    two = await execution.start(configured);
  assert.equal(one.environment.kind, 'local');
  assert.notEqual(one.environment.location, two.environment.location);
  const observations = await Promise.all(
    [one, two].map(async (run) =>
      observationSchema.parse(
        JSON.parse(
          await readFile(
            join(run.environment.location, 'launch-observed.json'),
            'utf8',
          ),
        ),
      ),
    ),
  );
  const first = observations[0],
    second = observations[1];
  assert.ok(first && second);
  assert.notEqual(first.home, homedir());
  assert.notEqual(first.home, second.home);
  assert.equal(first.cwd, one.environment.location);
  const workspaceListing = await execution.listDirectory(one.id);
  assert.ok(
    workspaceListing.kind === 'ready' &&
      workspaceListing.entries.some((entry) => entry.name === 'token.mjs'),
  );
  assert.equal(first.auth?.test, 'original');
  assert.equal(
    await readFile(authFile, 'utf8'),
    JSON.stringify({ test: 'original' }),
  );
  for (const name of ['.env', 'node_modules', 'linked.mjs'])
    await assert.rejects(access(join(one.environment.location, name)));
  const before = await readFile(join(source, 'token.mjs'), 'utf8');
  const prompt = execution.prompt(one.id, 'fix');
  const item = await until(() =>
    attention.list(one.id).find((item) => item.status === 'pending'),
  );
  attention.answer(item.id, 'choice-0');
  await prompt;
  await Promise.all([execution.cancel(one.id), execution.cancel(one.id)]);
  assert.match(
    await readFile(join(one.environment.location, 'token.mjs'), 'utf8'),
    /expiry <= now/,
  );
  assert.equal(await readFile(join(source, 'token.mjs'), 'utf8'), before);
  assert.equal(
    await readFile(join(two.environment.location, 'token.mjs'), 'utf8'),
    before,
  );
  await assert.rejects(access(first.home));
  await access(second.home);
  assert.equal(execution.snapshot(two.id).state.kind, 'idle');
});

test('native cancellation stops its process group, including ordinary descendants', async (t) => {
  const { directory, launch } = await setup();
  if (launch.worker.transport !== 'local' || !launch.worker.adapter)
    throw new Error('Expected local launch');
  const execution = createExecution({ attention: createAttention() });
  t.after(async () => {
    await execution.close();
    await rm(directory, { recursive: true, force: true });
  });
  const run = await execution.start({
    ...launch,
    worker: {
      ...launch.worker,
      adapter: {
        ...launch.worker.adapter,
        args: [...launch.worker.adapter.args, '--descendants'],
      },
    },
  });
  const descendants = await until(async () => {
    try {
      return z
        .array(z.number().int())
        .parse(
          JSON.parse(
            await readFile(
              join(run.environment.location, 'descendants.json'),
              'utf8',
            ),
          ),
        );
    } catch {
      return undefined;
    }
  });
  assert.equal(descendants.length, 2);
  await execution.cancel(run.id);
  for (const pid of descendants)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await access(run.environment.location);
});

test('a Rust project copies source while excluding its oversized root target directory', async (t) => {
  const { directory, source, launch } = await setup();
  const execution = createExecution({ attention: createAttention() });
  t.after(async () => {
    await execution.close();
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(source, 'target'));
  const artifact = join(source, 'target', 'compiled-output');
  await writeFile(artifact, '');
  await truncate(artifact, 300 * 1024 * 1024);
  await mkdir(join(source, 'src', 'target'), { recursive: true });
  await writeFile(
    join(source, 'src', 'target', 'logic.rs'),
    '// source module\n',
  );
  const run = await execution.start(launch);
  await assert.rejects(access(join(run.environment.location, 'target')));
  assert.equal(
    await readFile(
      join(run.environment.location, 'src', 'target', 'logic.rs'),
      'utf8',
    ),
    '// source module\n',
  );
  await access(artifact);
});

test('configured workbench starts local Runs without accepting executable settings from clients', async (t) => {
  const { directory, source, launch } = await setup();
  const origin = 'http://127.0.0.1:4177';
  const app = createWebWorkbench(origin, { launch });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  const initial = await client.connect();
  assert.equal(initial.source, source);
  assert.deepEqual(initial.launch, { provider: 'codex', kind: 'local' });
  const accepted = await client.command({ kind: 'start' });
  assert.ok('runId' in accepted);
  const state = await until(async () => {
    const state = await client.poll();
    return state.runs[0]?.state.kind === 'idle' ? state : undefined;
  });
  assert.equal(state.runs[0]?.id, accepted.runId);
  await client.command({
    kind: 'prompt',
    runId: accepted.runId,
    text: 'question',
  });
  await until(async () =>
    (await client.poll()).events.find(
      (event) =>
        event.type === 'agent.message' && event.text.includes('What name'),
    ),
  );
  await client.command({ kind: 'cancel', runId: accepted.runId });
  const closed = await client.poll();
  assert.equal(closed.runs[0]?.state.kind, 'cancelled');
  assert.match(JSON.stringify(closed.events), /no OS isolation/);
  assert.doesNotMatch(JSON.stringify(closed), /"adapter"|"authFile"/);
});

test('local mode requires explicit valid configuration and does not weaken container source validation', () => {
  assert.throws(() =>
    parseLaunch({
      provider: 'codex',
      source: { kind: 'directory', path: '/tmp/project' },
    }),
  );
  assert.throws(() =>
    parseLaunch({
      provider: 'codex',
      worker: { transport: 'local', workspaceRoot: 'relative' },
      source: { kind: 'fixture' },
    }),
  );
  assert.throws(() =>
    parseLaunch({
      provider: 'claude',
      worker: { transport: 'local', workspaceRoot: '/tmp/runs' },
      source: { kind: 'fixture' },
    }),
  );
  assert.throws(() =>
    parseLaunch({
      provider: 'codex',
      worker: { transport: 'docker', image: 'worker' },
      source: { kind: 'directory', path: '/tmp/project' },
    }),
  );
});

test('cancelling accepted local startup retains its code path and leaves no active decision', async (t) => {
  const { directory, launch } = await setup();
  const attention = createAttention(),
    execution = createExecution({ attention });
  t.after(async () => {
    await execution.close();
    await rm(directory, { recursive: true, force: true });
  });
  const accepted = execution.launch(launch);
  assert.equal(accepted.state.kind, 'starting');
  await Promise.all([
    execution.cancel(accepted.id),
    execution.cancel(accepted.id),
  ]);
  const stopped = execution.snapshot(accepted.id);
  assert.equal(stopped.state.kind, 'cancelled');
  assert.equal(stopped.environment.kind, 'local');
  assert.notEqual(stopped.environment.location, 'pending');
  await access(join(stopped.environment.location, 'token.mjs'));
  assert.equal(
    attention.list(accepted.id).filter((item) => item.status === 'pending')
      .length,
    0,
  );
});

test('missing local adapter becomes an observed startup failure and preserves the copied source', async (t) => {
  const { directory, launch } = await setup();
  if (launch.worker.transport !== 'local')
    throw new Error('Expected local launch');
  const execution = createExecution({ attention: createAttention() });
  t.after(async () => {
    await execution.close();
    await rm(directory, { recursive: true, force: true });
  });
  const worker = {
    ...launch.worker,
    adapter: { file: join(directory, 'missing-adapter'), args: [] },
  };
  const accepted = execution.launch({ ...launch, worker });
  const failure = await until(() => {
    const state = execution.snapshot(accepted.id).state;
    return state.kind === 'failed' ? state : undefined;
  });
  assert.match(failure.reason, /ENOENT/);
  const copies = await readdir(worker.workspaceRoot);
  assert.equal(copies.length, 1);
  assert.ok(copies[0]);
  await access(join(worker.workspaceRoot, copies[0], 'repo', 'token.mjs'));
});

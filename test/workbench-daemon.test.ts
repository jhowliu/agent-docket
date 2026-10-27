import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectWorkbench } from '../src/app/workbench-daemon.js';
import { codeBuild } from '../src/app/code-build.js';
import type { WorkbenchClient } from '../src/app/workbench-client.js';

async function freeOrigin(): Promise<string> {
  const socket = createServer();
  await new Promise<void>((done, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', done);
  });
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((done, reject) =>
    socket.close((error) => (error ? reject(error) : done())),
  );
  return origin;
}
async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('Daemon condition timed out');
}

test('one-command bootstrap creates a real shared server; client detach preserves approval and explicit stop cleans its copy', async (t) => {
  const origin = await freeOrigin();
  const logDirectory = await mkdtemp(join(tmpdir(), 'workbench-daemon-test-'));
  let owner: WorkbenchClient | undefined;
  t.after(async () => {
    if (owner) await owner.command({ kind: 'shutdown' }).catch(() => {});
    await rm(logDirectory, { recursive: true, force: true });
  });
  const boot = await connectWorkbench(origin, {
    autostart: true,
    logDirectory,
  });
  owner = boot.client;
  assert.equal(boot.initial.runs.length, 0);
  // The started server runs this tree's code, so the TUI finds it current.
  assert.equal(boot.initial.build, await codeBuild());
  const started = await owner.command({ kind: 'start' });
  assert.ok('runId' in started);
  await owner.command({ kind: 'prompt', runId: started.runId, text: 'fix' });
  await until(async () =>
    (await boot.client.poll()).attention.some(
      (item) => item.status === 'pending',
    ),
  );
  const waiting = await owner.poll();
  const location = waiting.runs[0]?.environment.location;
  assert.ok(location);
  const attached = await connectWorkbench(origin, {
    autostart: true,
    logDirectory,
  });
  assert.equal(attached.initial.instanceId, boot.initial.instanceId);
  assert.equal(attached.initial.attention[0]?.id, waiting.attention[0]?.id);
  assert.equal(attached.initial.attention[0]?.status, 'pending');
  const config = join(logDirectory, 'different-launch.json');
  await writeFile(
    config,
    JSON.stringify({
      provider: 'codex',
      worker: { transport: 'local', workspaceRoot: join(logDirectory, 'runs') },
      source: { kind: 'fixture' },
    }),
  );
  const previousConfig = process.env['WORKBENCH_LAUNCH'];
  try {
    process.env['WORKBENCH_LAUNCH'] = config;
    await assert.rejects(
      connectWorkbench(origin, { autostart: true, logDirectory }),
      /different launch configuration/,
    );
  } finally {
    if (previousConfig === undefined) delete process.env['WORKBENCH_LAUNCH'];
    else process.env['WORKBENCH_LAUNCH'] = previousConfig;
  }
  assert.equal((await owner.poll()).instanceId, boot.initial.instanceId);
  assert.equal((await owner.poll()).attention[0]?.status, 'pending');
  await attached.client.command({ kind: 'shutdown' });
  owner = undefined;
  await until(async () => {
    try {
      await access(location);
      return false;
    } catch {
      return true;
    }
  });
  await until(async () => {
    try {
      await fetch(origin);
      return false;
    } catch {
      return true;
    }
  });
});

test('a blocked HTTP port is rejected before autostart creates a log or daemon', async (t) => {
  const logDirectory = await mkdtemp(join(tmpdir(), 'workbench-blocked-port-'));
  t.after(() => rm(logDirectory, { recursive: true, force: true }));
  await assert.rejects(
    connectWorkbench('http://127.0.0.1:4190', {
      autostart: true,
      logDirectory,
    }),
    /4190.*blocked.*4182/,
  );
  assert.deepEqual(await readdir(logDirectory), []);
});

test('connect-only fails without starting a background listener', async () => {
  const origin = await freeOrigin();
  await assert.rejects(
    connectWorkbench(origin, { autostart: false }),
    /Cannot connect/,
  );
  await assert.rejects(fetch(origin));
});

test('the code build changes with the source and the lockfile, not with other files', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'workbench-build-test-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const src = join(project, 'src');
  await mkdir(join(src, 'app'), { recursive: true });
  await writeFile(join(src, 'app', 'web.ts'), 'export const port = 4177;\n');
  const first = await codeBuild(src);
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.equal(await codeBuild(src), first);
  await writeFile(join(src, 'notes.md'), 'not code');
  assert.equal(await codeBuild(src), first);
  await writeFile(join(src, 'app', 'web.ts'), 'export const port = 4180;\n');
  const edited = await codeBuild(src);
  assert.notEqual(edited, first);
  await writeFile(join(project, 'package-lock.json'), '{}');
  assert.notEqual(await codeBuild(src), edited);
});

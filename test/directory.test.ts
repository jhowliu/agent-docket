import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
  rename,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAttention } from '../src/attention/index.js';
import { createExecution } from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';

test('directory metadata is Run scoped, bounded, read only and rejects traversal/links/ended workspaces', async (t) => {
  const execution = createExecution({ attention: createAttention() });
  const external = await mkdtemp(join(tmpdir(), 'workbench-directory-test-'));
  t.after(async () => {
    await execution.close();
    await rm(external, { recursive: true, force: true });
  });
  const one = await execution.start({ provider: 'fixture' });
  const two = await execution.start({ provider: 'fixture' });
  await mkdir(join(one.environment.location, 'src', '中文'), {
    recursive: true,
  });
  await writeFile(
    join(one.environment.location, 'src', 'main.ts'),
    'export {};',
  );
  await writeFile(join(external, 'outside-secret.txt'), 'not read');
  await symlink(external, join(one.environment.location, 'link'));
  await mkdir(join(one.environment.location, 'node_modules'));
  const before = execution.events().length;
  const root = await execution.listDirectory(one.id);
  assert.equal(root.kind, 'ready');
  if (root.kind !== 'ready') return;
  assert.ok(
    root.entries.some(
      (entry) => entry.name === 'src' && entry.kind === 'directory',
    ),
  );
  assert.ok(
    root.entries.some(
      (entry) => entry.name === 'link' && entry.kind === 'symlink',
    ),
  );
  assert.ok(!root.entries.some((entry) => entry.name === 'node_modules'));
  const nested = await execution.listDirectory(one.id, 'src');
  assert.equal(nested.kind, 'ready');
  if (nested.kind === 'ready')
    assert.deepEqual(
      nested.entries.map((entry) => entry.name),
      ['中文', 'main.ts'],
    );
  const other = await execution.listDirectory(two.id);
  assert.ok(
    other.kind === 'ready' &&
      !other.entries.some((entry) => entry.name === 'src'),
  );
  for (const path of [
    '..',
    'src/../../',
    '/tmp',
    'src/../src',
    '.workbench',
    '.git',
    'node_modules',
  ])
    await assert.rejects(execution.listDirectory(one.id, path));
  assert.equal(
    (await execution.listDirectory(one.id, 'link')).kind,
    'unavailable',
  );
  assert.equal(
    (await execution.listDirectory(one.id, 'missing')).kind,
    'unavailable',
  );
  assert.equal(execution.events().length, before);
  await mkdir(join(one.environment.location, 'many'));
  await Promise.all(
    Array.from({ length: 205 }, (_, index) =>
      writeFile(
        join(one.environment.location, 'many', String(index) + '.txt'),
        '',
      ),
    ),
  );
  const many = await execution.listDirectory(one.id, 'many');
  assert.ok(
    many.kind === 'ready' && many.entries.length === 200 && many.truncated,
  );
  const reading = execution.listDirectory(one.id, 'many');
  await execution.cancel(one.id);
  assert.equal((await reading).kind, 'unavailable');
  // A cancelled Run with nothing to save is removed.
  await assert.rejects(execution.listDirectory(one.id), /Unknown Run/);
  await assert.rejects(execution.listDirectory('run-unknown'));
  await rename(
    two.environment.location,
    two.environment.location + '-original',
  );
  await symlink(external, two.environment.location);
  assert.equal((await execution.listDirectory(two.id)).kind, 'unavailable');
});

test('directory transport advertises support, requires bootstrap auth and returns validated matching metadata', async (t) => {
  const origin = 'http://127.0.0.1:4177';
  const app = createWebWorkbench(origin);
  t.after(() => app.close());
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  const initial = await client.connect();
  assert.equal(initial.features?.directoryTree, true);
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  const listing = await client.directory(started.runId);
  assert.ok(
    listing.kind === 'ready' &&
      listing.entries.some((entry) => entry.name === 'token.mjs'),
  );
  const path =
    '/api/directory?' + new URLSearchParams({ runId: started.runId, path: '' });
  assert.equal((await app.fetch(new Request(origin + path))).status, 403);
  const html = await (await app.fetch(new Request(origin + '/'))).text();
  const token = html.match(
    /name="workbench-token" content="([a-f0-9]{64})"/,
  )?.[1];
  assert.ok(token);
  const headers = { 'x-workbench-token': token, origin };
  const good = await app.fetch(new Request(origin + path, { headers }));
  assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.equal(
    (
      await app.fetch(
        new Request(origin + path + '&ignored=x', {
          headers: { ...headers, origin: 'https://example.test' },
        }),
      )
    ).status,
    403,
  );
  const escape =
    '/api/directory?' +
    new URLSearchParams({ runId: started.runId, path: '../' });
  assert.equal(
    (await app.fetch(new Request(origin + escape, { headers }))).status,
    400,
  );
  await assert.rejects(client.directory(started.runId, '../'));
});

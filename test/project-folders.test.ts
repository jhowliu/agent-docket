import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjectFolders } from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';

const origin = 'http://127.0.0.1:4177';
async function setup() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'workbench-folder-')),
  );
  await Promise.all(
    ['alpha project 中文', 'beta', 'constructor', '.hidden'].map((name) =>
      mkdir(join(root, name)),
    ),
  );
  await writeFile(
    join(root, 'alpha-file.txt'),
    'This file must not be read or listed',
  );
  await symlink(join(root, 'alpha project 中文'), join(root, 'folder-link'));
  await symlink(join(root, 'alpha-file.txt'), join(root, 'file-link'));
  await symlink(join(root, 'missing'), join(root, 'broken-link'));
  return root;
}

test('folder completion reads one level, supports partial/hidden/parent paths, and identifies directory links without requiring Git', async (t) => {
  const root = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readdir(root);
  const listed = await listProjectFolders(root);
  assert.equal(listed.directory, root);
  assert.equal(listed.input, root);
  assert.equal(listed.truncated, false);
  assert.deepEqual(
    listed.entries.map((entry) => [entry.name, entry.kind]),
    [
      ['alpha project 中文', 'directory'],
      ['beta', 'directory'],
      ['constructor', 'directory'],
      ['folder-link', 'directory-link'],
    ],
  );
  const partial = await listProjectFolders(join(root, 'AL'));
  assert.equal(partial.prefix, 'AL');
  assert.deepEqual(
    partial.entries.map((entry) => entry.path),
    [join(root, 'alpha project 中文')],
  );
  const hidden = await listProjectFolders(root + '/.');
  assert.deepEqual(
    hidden.entries.map((entry) => entry.name),
    ['.hidden'],
  );
  const parent = await listProjectFolders(root + '/beta/..');
  assert.deepEqual(parent.entries, listed.entries);
  assert.deepEqual((await listProjectFolders(join(root, 'beta'))).entries, []);
  assert.deepEqual(
    (await listProjectFolders(join(root, 'folder-link'))).entries,
    [],
  );
  assert.deepEqual(await readdir(root), before);
  await assert.rejects(listProjectFolders('relative/path'), /absolute folder/);
  await assert.rejects(
    listProjectFolders(root + '/bad\0path'),
    /absolute folder/,
  );
  await assert.rejects(
    listProjectFolders(join(root, 'missing', 'child')),
    /check its path and permissions/,
  );
});

test('folder results are bounded and a narrower prefix can find a candidate beyond the first result page', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'workbench-folder-bound-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 205 }, (_, index) =>
      mkdir(join(root, `project-${String(index).padStart(4, '0')}`)),
    ),
  );
  const result = await listProjectFolders(root);
  assert.equal(result.entries.length, 200);
  assert.equal(result.truncated, true);
  const narrow = await listProjectFolders(join(root, 'project-0204'));
  assert.deepEqual(narrow.entries, []); // Existing folders browse their children.
  const prefix = await listProjectFolders(join(root, 'project-020'));
  assert.equal(prefix.entries.length, 5);
  assert.equal(prefix.truncated, false);
});

test('folder browsing reports permission failures without changing permissions', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('Root can bypass directory read permissions');
    return;
  }
  const root = await setup();
  const denied = join(root, 'denied');
  await mkdir(denied);
  await chmod(denied, 0o000);
  t.after(async () => {
    await chmod(denied, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    listProjectFolders(denied),
    /check its path and permissions/,
  );
});

test('folder transport is authenticated, validates matching metadata, advertises support and never creates a Run', async (t) => {
  const root = await setup();
  const app = createWebWorkbench(origin);
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  const state = await client.connect();
  assert.equal(state.features?.folderCompletion, true);
  assert.equal((await client.folders(root)).entries.length, 4);
  assert.deepEqual((await client.poll()).runs, []);
  const url = origin + '/api/project/folders';
  const anonymous = await app.fetch(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    }),
  );
  assert.equal(anonymous.status, 403);
  const html = await (await app.fetch(new Request(origin))).text();
  const token = html.match(
    /name="workbench-token" content="([a-f0-9]{64})"/,
  )?.[1];
  assert.ok(token);
  const headers = {
    'content-type': 'application/json',
    'x-workbench-token': token,
  };
  const crossOrigin = await app.fetch(
    new Request(url, {
      method: 'POST',
      headers: { ...headers, origin: 'http://127.0.0.1:4188' },
      body: JSON.stringify({ path: root }),
    }),
  );
  assert.equal(crossOrigin.status, 403);
  const invalid = await app.fetch(
    new Request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: root, executable: 'custom' }),
    }),
  );
  assert.equal(invalid.status, 400);
  assert.equal((await app.fetch(new Request(url))).status, 404);
  const response = await app.fetch(
    new Request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: root }),
    }),
  );
  assert.equal(response.headers.get('cache-control'), 'no-store');
  let mismatched = false;
  const bad = createWorkbenchClient(origin, async (request) => {
    const response = await app.fetch(request);
    if (
      mismatched &&
      new URL(request.url).pathname === '/api/project/folders'
    ) {
      const body: unknown = await response.json();
      assert.ok(body && typeof body === 'object');
      return Response.json({ ...body, input: root + '/different' });
    }
    return response;
  });
  await bad.connect();
  mismatched = true;
  await assert.rejects(bad.folders(root), /Invalid folder response/);
});

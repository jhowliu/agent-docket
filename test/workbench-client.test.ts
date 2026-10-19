import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import {
  createWorkbenchClient,
  WorkbenchError,
} from '../src/app/workbench-client.js';
import type { WorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';

const origin = 'http://127.0.0.1:4177';
export async function waitFor(
  client: WorkbenchClient,
  predicate: (state: WorkbenchState) => boolean,
) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const state = await client.poll();
    if (predicate(state)) return state;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('Timed out waiting for workbench state');
}

test('new clients reattach to the same pending request and cannot answer it twice', async (t) => {
  const app = createWebWorkbench(origin);
  t.after(() => app.close());
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  const before = await readFile('fixtures/project/token.mjs', 'utf8');
  await client.command({ kind: 'prompt', runId: started.runId, text: 'fix' });
  const pending = await waitFor(client, (state) =>
    state.attention.some((item) => item.status === 'pending'),
  );
  const item = pending.attention[0];
  const choice = item?.choices.find((choice) => choice.kind === 'allow-once');
  assert.ok(item && choice);
  // Replacing a TUI client has no Run lifecycle side effects.
  const other = createWorkbenchClient(origin, (request) => app.fetch(request));
  assert.equal((await other.connect()).attention[0]?.id, item.id);
  await other.command({ kind: 'answer', id: item.id, choiceId: choice.id });
  const finished = await waitFor(
    client,
    (state) =>
      state.attention[0]?.status === 'delivered' &&
      state.runs[0]?.state.kind === 'idle',
  );
  await assert.rejects(
    client.command({ kind: 'answer', id: item.id, choiceId: choice.id }),
    WorkbenchError,
  );
  assert.ok(finished.events.some((event) => event.type === 'diff'));
  assert.equal(await readFile('fixtures/project/token.mjs', 'utf8'), before);
  const once = await other.poll();
  const twice = await other.poll();
  assert.equal(
    new Set(twice.events.map((event) => event.sequence)).size,
    twice.events.length,
  );
  assert.deepEqual(twice.events, once.events);
});

test('a lost mutation response is never replayed, and concurrent polls share one cursor request', async (t) => {
  const app = createWebWorkbench(origin);
  t.after(() => app.close());
  let lose = true;
  let reads = 0;
  const client = createWorkbenchClient(origin, async (request) => {
    if (new URL(request.url).pathname === '/api/state') reads++;
    const response = await app.fetch(request);
    if (request.method === 'POST' && lose) {
      lose = false;
      throw new Error('Response lost');
    }
    return response;
  });
  await client.connect();
  await assert.rejects(client.command({ kind: 'start' }), WorkbenchError);
  const recovered = await client.poll();
  assert.equal(recovered.runs.length, 1);
  const before = reads;
  const [one, two] = await Promise.all([client.poll(), client.poll()]);
  assert.equal(reads - before, 1);
  assert.equal(one, two);
  assert.equal(two.runs.length, 1);
});

test('server restart replaces the journal and credentials without restoring old requests', async (t) => {
  let app = createWebWorkbench(origin);
  t.after(() => app.close());
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  const original = await client.connect();
  const run = await client.command({ kind: 'start' });
  assert.ok('runId' in run);
  await client.command({ kind: 'prompt', runId: run.runId, text: 'fix' });
  const waiting = await waitFor(client, (state) =>
    state.attention.some((item) => item.status === 'pending'),
  );
  const old = waiting.attention[0];
  assert.ok(old?.choices[0]);
  await app.close();
  app = createWebWorkbench(origin);
  const fresh = await client.poll();
  assert.notEqual(fresh.instanceId, original.instanceId);
  assert.equal(fresh.runs.length, 0);
  assert.equal(fresh.events.length, 0);
  await assert.rejects(
    client.command({ kind: 'answer', id: old.id, choiceId: old.choices[0].id }),
    /Unknown attention/,
  );
  const next = await client.command({ kind: 'start' });
  assert.ok('runId' in next);
  assert.notEqual(next.runId, run.runId);
});

test('incompatible servers and non-loopback addresses cannot become a TUI connection', async () => {
  assert.throws(() => createWorkbenchClient('https://example.com'), /loopback/);
  assert.throws(() => createWorkbenchClient(origin + '/path'), /loopback/);
  const client = createWorkbenchClient(
    origin,
    async () => new Response('<html>Other app</html>'),
  );
  await assert.rejects(client.connect(), /not Agent Workbench/);
  await assert.rejects(client.command({ kind: 'start' }), /Not connected/);
});

test('stopping a server is authenticated and invokes only its registered lifecycle callback', async (t) => {
  let stops = 0;
  const app = createWebWorkbench(origin, {
    onShutdown: () => {
      stops++;
    },
  });
  t.after(() => app.close());
  const blocked = await app.fetch(
    new Request(origin + '/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"kind":"shutdown"}',
    }),
  );
  assert.equal(blocked.status, 403);
  assert.equal(stops, 0);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  await client.command({ kind: 'shutdown' });
  await new Promise((done) => setImmediate(done));
  assert.equal(stops, 1);
});

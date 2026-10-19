import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createWebWorkbench } from '../src/app/web-workbench.js';

const origin = 'http://127.0.0.1:4177';
const snapshotSchema = z.object({
  runs: z.array(
    z.object({
      id: z.string(),
      state: z.object({ kind: z.string() }),
      environment: z.object({ location: z.string() }),
    }),
  ),
  attention: z.array(
    z.object({
      id: z.string(),
      runId: z.string(),
      status: z.string(),
      choices: z.array(z.object({ id: z.string(), kind: z.string() })),
    }),
  ),
  events: z.array(
    z.object({ runId: z.string(), type: z.string(), sequence: z.number() }),
  ),
  cursor: z.number(),
  reset: z.boolean(),
  source: z.string(),
});

async function setup() {
  const app = createWebWorkbench(origin);
  const page = await app.fetch(new Request(origin));
  const html = await page.text();
  const token = html.match(/name="workbench-token" content="([a-f0-9]+)"/)?.[1];
  assert.ok(token);
  const command = (input: unknown) =>
    app.fetch(
      new Request(origin + '/api/commands', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-workbench-token': token,
          origin,
        },
        body: JSON.stringify(input),
      }),
    );
  const snapshot = async (after = 0) =>
    snapshotSchema.parse(
      await (
        await app.fetch(new Request(origin + '/api/state?after=' + after))
      ).json(),
    );
  async function start() {
    const response = await command({ kind: 'start' });
    assert.equal(response.status, 201);
    return z.object({ runId: z.string() }).parse(await response.json()).runId;
  }
  async function waitFor(
    predicate: (state: z.infer<typeof snapshotSchema>) => boolean,
  ) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const state = await snapshot();
      if (predicate(state)) return state;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('Workbench condition timed out');
  }
  return { app, command, snapshot, start, waitFor, html, token };
}

test('browser transport allows only its own fixture controls and allowlisted assets', async (t) => {
  const ui = await setup();
  t.after(() => ui.app.close());
  assert.match(ui.html, /Fixture Demo/);
  assert.doesNotMatch(ui.html, /content="WORKBENCH_TOKEN"/);
  assert.equal(
    (await ui.app.fetch(new Request(origin + '/runtime.js'))).status,
    200,
  );
  assert.equal(
    (await ui.app.fetch(new Request(origin + '/package.json'))).status,
    404,
  );
  assert.equal(
    (await ui.app.fetch(new Request('http://attacker.test/api/state'))).status,
    403,
  );
  assert.equal(
    (await ui.app.fetch(new Request(origin + '/api/state?after=NaN'))).status,
    400,
  );
  const blocked = await ui.app.fetch(
    new Request(origin + '/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"kind":"start"}',
    }),
  );
  assert.equal(blocked.status, 403);
  const crossSite = await ui.app.fetch(
    new Request(origin + '/api/commands', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-workbench-token': ui.token,
        origin: 'http://attacker.test',
      },
      body: '{"kind":"start"}',
    }),
  );
  assert.equal(crossSite.status, 403);
  assert.equal(
    (await ui.command({ kind: 'start', provider: 'codex' })).status,
    400,
  );
  assert.equal(
    (await ui.command({ kind: 'shell', command: 'touch /tmp/test' })).status,
    400,
  );
  assert.equal((await ui.snapshot()).runs.length, 0);
});

test('browser controls keep concurrent approvals and diffs with their Run and clean copies', async (t) => {
  const ui = await setup();
  t.after(() => ui.app.close());
  const before = await readFile('fixtures/project/token.mjs', 'utf8');
  const one = await ui.start(),
    two = await ui.start();
  assert.equal(
    (await ui.command({ kind: 'prompt', runId: one, text: 'fix' })).status,
    202,
  );
  assert.equal(
    (await ui.command({ kind: 'prompt', runId: two, text: 'fix' })).status,
    202,
  );
  const waiting = await ui.waitFor(
    (state) =>
      state.attention.filter((item) => item.status === 'pending').length === 2,
  );
  const allow = waiting.attention.find((item) => item.runId === one);
  const reject = waiting.attention.find((item) => item.runId === two);
  assert.ok(allow && reject);
  const allowChoice = allow.choices.find(
    (choice) => choice.kind === 'allow-once',
  );
  const rejectChoice = reject.choices.find(
    (choice) => choice.kind === 'reject-once',
  );
  assert.ok(allowChoice && rejectChoice);
  assert.equal(
    (
      await ui.command({
        kind: 'answer',
        id: allow.id,
        choiceId: allowChoice.id,
      })
    ).status,
    202,
  );
  assert.equal(
    (
      await ui.command({
        kind: 'answer',
        id: reject.id,
        choiceId: rejectChoice.id,
      })
    ).status,
    202,
  );
  const finished = await ui.waitFor((state) =>
    state.runs.every((run) => run.state.kind === 'idle'),
  );
  assert.ok(
    finished.events.some(
      (event) => event.runId === one && event.type === 'diff',
    ),
  );
  assert.ok(
    !finished.events.some(
      (event) => event.runId === two && event.type === 'diff',
    ),
  );
  assert.ok(finished.attention.every((item) => item.status === 'delivered'));
  assert.equal(
    (
      await ui.command({
        kind: 'answer',
        id: allow.id,
        choiceId: allowChoice.id,
      })
    ).status,
    409,
  );
  const copyOne = finished.runs.find((run) => run.id === one)?.environment
    .location;
  const copyTwo = finished.runs.find((run) => run.id === two)?.environment
    .location;
  assert.ok(copyOne && copyTwo && copyOne !== copyTwo);
  assert.match(await readFile(copyOne + '/token.mjs', 'utf8'), /expiry <= now/);
  assert.equal(await readFile(copyTwo + '/token.mjs', 'utf8'), before);
  assert.equal(await readFile('fixtures/project/token.mjs', 'utf8'), before);
  await ui.app.close();
  await assert.rejects(access(copyOne));
  await assert.rejects(access(copyTwo));
});

test('cancelling through the browser invalidates the old decision and rejects busy prompts', async (t) => {
  const ui = await setup();
  t.after(() => ui.app.close());
  const runId = await ui.start();
  await ui.command({ kind: 'prompt', runId, text: 'fix' });
  const waiting = await ui.waitFor((state) =>
    state.attention.some((item) => item.status === 'pending'),
  );
  const item = waiting.attention[0];
  assert.ok(item?.choices[0]);
  assert.equal(
    (await ui.command({ kind: 'prompt', runId, text: 'question' })).status,
    409,
  );
  assert.equal((await ui.command({ kind: 'cancel', runId })).status, 200);
  assert.equal(
    (
      await ui.command({
        kind: 'answer',
        id: item.id,
        choiceId: item.choices[0].id,
      })
    ).status,
    409,
  );
  const state = await ui.snapshot();
  assert.equal(state.runs[0]?.state.kind, 'cancelled');
  assert.equal(state.attention[0]?.status, 'stale');
  assert.equal(
    (await ui.command({ kind: 'prompt', runId, text: 'fix' })).status,
    409,
  );
});

test('browser snapshots support cursor polling, question follow-ups and interrupted Runs', async (t) => {
  const ui = await setup();
  t.after(() => ui.app.close());
  const runId = await ui.start();
  const initial = await ui.snapshot();
  assert.equal((await ui.snapshot(initial.cursor)).events.length, 0);
  await ui.command({ kind: 'prompt', runId, text: 'question' });
  await ui.waitFor((state) =>
    state.events.some((event) => event.type === 'turn.end'),
  );
  await ui.command({ kind: 'prompt', runId, text: 'reply:from-browser' });
  const replied = await ui.waitFor(
    (state) =>
      state.events.filter((event) => event.type === 'turn.end').length === 2,
  );
  const delta = await ui.snapshot(initial.cursor);
  assert.ok(delta.events.every((event) => event.sequence > initial.cursor));
  assert.equal(delta.cursor, replied.cursor);
  assert.equal((await ui.snapshot(999999)).reset, true);
  await ui.command({ kind: 'prompt', runId, text: 'crash' });
  await ui.waitFor((state) => state.runs[0]?.state.kind === 'interrupted');
  await ui.app.close();
  assert.equal(
    (await ui.app.fetch(new Request(origin + '/api/state'))).status,
    503,
  );
});

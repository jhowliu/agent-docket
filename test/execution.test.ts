import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createAttention } from '../src/attention/index.js';
import { createExecution, parseLaunch } from '../src/execution/index.js';
import type { RunId } from '../src/execution/index.js';
import type { Attention, AttentionItem } from '../src/attention/index.js';

async function until<T>(read: () => T | undefined): Promise<T> {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Fixture condition timed out');
}
/** A cancelled Run leaves the list; its journal keeps the final state. */
function removed(runtime: ReturnType<typeof createExecution>, id: RunId) {
  assert.ok(!runtime.list().some((run) => run.id === id));
  assert.throws(() => runtime.snapshot(id), /Unknown Run/);
  const states = runtime
    .events()
    .flatMap((event) =>
      event.runId === id && event.type === 'run.state'
        ? [event.state.kind]
        : [],
    );
  return states.at(-1);
}
const waiting = (attention: Attention, id: RunId) =>
  until<AttentionItem>(() =>
    attention.list(id).find((item) => item.status === 'pending'),
  );

test('accepted prompt inputs enter the journal once and busy rejections do not create a turn', async (t) => {
  const runtime = createExecution({ attention: createAttention() });
  t.after(() => runtime.close());
  const run = await runtime.start({ provider: 'fixture' });
  await runtime.prompt(run.id, 'question');
  const running = runtime.prompt(run.id, 'wait');
  await assert.rejects(runtime.prompt(run.id, 'must not be recorded'), /idle/);
  await runtime.cancel(run.id);
  await running;
  const journal = runtime.events();
  const starts = journal.filter((event) => event.type === 'turn.start');
  assert.deepEqual(
    starts.map((event) => event.text),
    ['question', 'wait'],
  );
  assert.ok(
    (starts[0]?.sequence ?? Infinity) <
      (journal.find((event) => event.type === 'agent.message')?.sequence ?? 0),
  );
});

test('partial ACP tool updates keep the original title for meaningful activity records', async (t) => {
  const attention = createAttention(),
    runtime = createExecution({ attention });
  t.after(() => runtime.close());
  const run = await runtime.start({ provider: 'fixture' });
  const prompt = runtime.prompt(run.id, 'fix');
  const decision = await waiting(attention, run.id);
  attention.answer(decision.id, 'choice-1');
  await prompt;
  const tools = runtime.events().filter((event) => event.type === 'tool');
  const first = tools[0],
    last = tools.at(-1);
  assert.ok(first && last);
  assert.equal(last.id, first.id);
  assert.equal(last.status, 'failed');
  assert.equal(last.title, first.title);
});

test('recorded prompt inputs apply the journal redaction boundary', async (t) => {
  const runtime = createExecution({ attention: createAttention() });
  t.after(() => runtime.close());
  const run = await runtime.start({ provider: 'fixture' });
  await runtime.prompt(run.id, 'reply:sk-abcdefghijklmnopqrstuv');
  const start = runtime.events().find((event) => event.type === 'turn.start');
  assert.ok(start);
  assert.equal(start.text, 'reply:[redacted]');
});

test('two real ACP subprocesses isolate edits, correlate opaque options and retain ordered receipts', async (t) => {
  const source = await readFile(resolve('fixtures/project/token.mjs'), 'utf8');
  const attention = createAttention(),
    runtime = createExecution({ attention });
  t.after(() => runtime.close());
  const one = await runtime.start({ provider: 'fixture', label: 'allowed' }),
    two = await runtime.start({ provider: 'fixture', label: 'denied' });
  assert.notEqual(one.environment.location, two.environment.location);
  assert.equal(one.capabilities?.clientFilesystem, false);
  const statuses: string[] = [];
  attention.subscribe((item) => {
    if (item.runId === one.id) statuses.push(item.status);
  });
  const p1 = runtime.prompt(one.id, 'fix'),
    p2 = runtime.prompt(two.id, 'fix');
  const a1 = await waiting(attention, one.id),
    a2 = await waiting(attention, two.id);
  attention.answer(a1.id, 'choice-0');
  attention.answer(a2.id, 'choice-1');
  assert.equal(attention.list(one.id)[0]?.status, 'accepted');
  await Promise.all([p1, p2]);
  assert.deepEqual(statuses, ['pending', 'accepted', 'delivered']);
  assert.match(
    await readFile(join(one.environment.location, 'token.mjs'), 'utf8'),
    /expiry <= now/,
  );
  assert.equal(
    await readFile(join(two.environment.location, 'token.mjs'), 'utf8'),
    source,
  );
  assert.equal(
    await readFile(resolve('fixtures/project/token.mjs'), 'utf8'),
    source,
  );
  assert.ok(
    runtime.events().some((e) => e.runId === one.id && e.type === 'diff'),
  );
  assert.equal(
    runtime.snapshot(one.id).state.kind,
    'idle',
    'turn completion is not Task/Run completion',
  );
  const events = runtime.events();
  assert.ok(
    events.every(
      (event, i) => i === 0 || event.sequence > (events[i - 1]?.sequence ?? 0),
    ),
  );
  await runtime.close();
  await assert.rejects(access(one.environment.location));
});

test('simultaneous permission requests map to their original request and option IDs', async (t) => {
  const attention = createAttention(),
    runtime = createExecution({ attention });
  t.after(() => runtime.close());
  const run = await runtime.start({ provider: 'fixture' });
  const prompt = runtime.prompt(run.id, 'two-permissions');
  const pending = await until(() => {
    const items = attention.list(run.id).filter((i) => i.status === 'pending');
    return items.length === 2 ? items : undefined;
  });
  const first = pending[0],
    second = pending[1];
  assert.ok(first && second);
  attention.answer(second.id, 'choice-1');
  attention.answer(first.id, 'choice-0');
  await prompt;
  assert.ok(
    attention.list(run.id).every((item) => item.status === 'delivered'),
  );
  assert.match(
    await readFile(join(run.environment.location, 'token.mjs'), 'utf8'),
    /expiry <= now/,
  );
});

test('accepted decision followed immediately by cancellation cannot edit the fixture', async (t) => {
  const attention = createAttention(),
    runtime = createExecution({ attention });
  t.after(() => runtime.close());
  const run = await runtime.start({ provider: 'fixture' });
  const prompt = runtime.prompt(run.id, 'fix');
  const item = await waiting(attention, run.id);
  attention.answer(item.id, 'choice-0');
  const cancelled = runtime.cancel(run.id);
  assert.equal((await prompt).stopReason, 'cancelled');
  await cancelled;
  assert.equal(attention.list(run.id)[0]?.status, 'stale');
  assert.equal(removed(runtime, run.id), 'cancelled');
  assert.ok(
    !runtime
      .events()
      .some((event) => event.runId === run.id && event.type === 'diff'),
  );
  await assert.rejects(access(run.environment.location));
});

test('busy prompts reject steering; cancellation unblocks a long-running turn', async (t) => {
  const attention = createAttention(),
    runtime = createExecution({ attention });
  t.after(() => runtime.close());
  const run = await runtime.start({ provider: 'fixture' });
  const prompt = runtime.prompt(run.id, 'wait');
  await until(() => runtime.events().find((e) => e.type === 'agent.message'));
  await assert.rejects(runtime.prompt(run.id, 'extra'), /idle/);
  await runtime.cancel(run.id);
  assert.equal((await prompt).stopReason, 'cancelled');
});

test('plain-text questions accept a new prompt; client filesystem callbacks remain unsupported', async (t) => {
  const attention = createAttention(),
    runtime = createExecution({ attention });
  t.after(() => runtime.close());
  const run = await runtime.start({ provider: 'fixture' });
  await runtime.prompt(run.id, 'question');
  await runtime.prompt(run.id, 'reply:boundary-test');
  await runtime.prompt(run.id, 'unsupported-files');
  const text = runtime
    .events()
    .filter((e) => e.type === 'agent.message')
    .map((e) => e.text)
    .join('');
  assert.match(text, /boundary-test/);
  assert.match(text, /filesystem callback rejected/);
  assert.doesNotMatch(text, /root:x:/);
});

test('adapter exit interrupts its Run and cleans its environment', async (t) => {
  const attention = createAttention(),
    runtime = createExecution({ attention });
  t.after(() => runtime.close());
  const run = await runtime.start({ provider: 'fixture' });
  await assert.rejects(runtime.prompt(run.id, 'crash'));
  assert.equal(runtime.snapshot(run.id).state.kind, 'interrupted');
  await assert.rejects(access(run.environment.location));
});

test('closing during startup removes a fixture created after close began', async () => {
  const attention = createAttention(),
    runtime = createExecution({ attention });
  const start = runtime.start({ provider: 'fixture' });
  const rejected = assert.rejects(start, /cancelled/);
  await runtime.close();
  await rejected;
  const location = runtime.list()[0]?.environment.location;
  if (location && location !== 'pending')
    await assert.rejects(access(location));
});

test('idle adapter exit also removes its environment without waiting for operator shutdown', async (t) => {
  const attention = createAttention(),
    runtime = createExecution({ attention });
  t.after(() => runtime.close());
  const run = await runtime.start({ provider: 'fixture' });
  await runtime.prompt(run.id, 'exit-idle');
  await until(() =>
    runtime.snapshot(run.id).state.kind === 'interrupted' ? true : undefined,
  );
  await until(() => (!existsSync(run.environment.location) ? true : undefined));
});

test('concurrent duplicate cancellations share one operation', async (t) => {
  const attention = createAttention(),
    runtime = createExecution({ attention });
  t.after(() => runtime.close());
  const run = await runtime.start({ provider: 'fixture' });
  const prompt = runtime.prompt(run.id, 'wait');
  await until(() =>
    runtime.events().find((event) => event.type === 'agent.message'),
  );
  await Promise.all([runtime.cancel(run.id), runtime.cancel(run.id)]);
  await prompt;
  assert.equal(removed(runtime, run.id), 'cancelled');
  assert.equal(
    runtime
      .events()
      .filter(
        (event) =>
          event.type === 'run.state' && event.state.kind === 'cancelling',
      ).length,
    1,
  );
});

test('bounded event history detects stale cursors instead of silently dropping events', async (t) => {
  const attention = createAttention(),
    runtime = createExecution({ attention, maxEvents: 5 });
  t.after(() => runtime.close());
  const run = await runtime.start({ provider: 'fixture' });
  await runtime.prompt(run.id, 'question');
  await runtime.prompt(run.id, 'reply:x');
  assert.equal(runtime.events().length, 5);
  assert.throws(() => runtime.events(0), /expired/);
});

test('launch validation requires explicit transports and rejects injection and mutable revisions', () => {
  assert.throws(() =>
    parseLaunch({ provider: 'codex', command: 'codex --yolo' }),
  );
  assert.throws(() =>
    parseLaunch({
      provider: 'codex',
      worker: {
        transport: 'ssh',
        host: 'worker; touch /tmp/owned',
        image: 'agent-workbench',
      },
      source: { kind: 'fixture' },
    }),
  );
  assert.throws(() =>
    parseLaunch({
      provider: 'claude',
      worker: { transport: 'docker', image: 'agent-workbench' },
      source: {
        kind: 'git',
        url: 'file:///Users/private/repo',
        revision: 'main',
      },
    }),
  );
  assert.throws(() =>
    parseLaunch({
      provider: 'codex',
      worker: { transport: 'ssh', image: 'agent-workbench' },
      source: { kind: 'fixture' },
    }),
  );
  assert.equal(parseLaunch({ provider: 'fixture' }).provider, 'fixture');
});

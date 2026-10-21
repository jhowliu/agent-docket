import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttention } from '../src/attention/index.js';
import type { RunId } from '../src/execution/index.js';

const runId: RunId = 'run-test';
const input = {
  runId,
  title: 'Edit file',
  detail: 'fixture only',
  choices: [
    { id: 'yes', label: 'Allow once', kind: 'allow-once' },
    { id: 'no', label: 'Reject', kind: 'reject-once' },
  ],
} as const;

test('acceptance, transport delivery and repeated replies remain distinct', async () => {
  const inbox = createAttention();
  const seen: string[] = [];
  inbox.subscribe((item) => seen.push(item.status));
  const request = inbox.request(input);
  assert.throws(() => inbox.answer(request.id, 'invented'), /Unknown decision/);
  assert.equal(inbox.answer(request.id, 'yes'), 'accepted');
  assert.equal(inbox.list()[0]?.status, 'accepted');
  assert.equal(inbox.answer(request.id, 'no'), 'already-answered');
  assert.deepEqual(await request.decision, {
    kind: 'selected',
    choiceId: 'yes',
  });
  inbox.delivered(request.id);
  inbox.delivered(request.id);
  assert.deepEqual(seen, ['pending', 'accepted', 'delivered']);
});

test('withdrawal only invalidates its request; cancelling a Run invalidates accepted replies too', async () => {
  const inbox = createAttention();
  const one = inbox.request(input),
    two = inbox.request(input);
  inbox.invalidate(one.id, 'request cancelled');
  assert.deepEqual(await one.decision, { kind: 'cancelled' });
  assert.equal(inbox.list().find((i) => i.id === two.id)?.status, 'pending');
  inbox.answer(two.id, 'yes');
  inbox.invalidate(runId, 'Run cancelled');
  inbox.delivered(two.id);
  assert.equal(inbox.list().find((i) => i.id === two.id)?.status, 'stale');
  assert.equal(inbox.answer(two.id, 'yes'), 'stale');
});

test('snapshots and observer exceptions cannot alter broker state', () => {
  const inbox = createAttention();
  inbox.subscribe(() => {
    throw new Error('broken UI');
  });
  const request = inbox.request(input);
  const copy = inbox.list();
  assert.equal(copy[0]?.status, 'pending');
  assert.equal(inbox.answer(request.id, 'no'), 'accepted');
  assert.equal(copy[0]?.status, 'pending');
});

test('pending inbox has bounded capacity', () => {
  const inbox = createAttention();
  for (let i = 0; i < 100; i++) inbox.request(input);
  assert.throws(() => inbox.request(input), /capacity/);
  inbox.invalidate(runId, 'reset');
  assert.doesNotThrow(() => inbox.request(input));
});

test('closing an inbox revokes unfinished decisions without carrying them to a new inbox', async () => {
  const inbox = createAttention();
  const pending = inbox.request(input);
  const accepted = inbox.request(input);
  const delivered = inbox.request(input);
  inbox.answer(accepted.id, 'yes');
  inbox.answer(delivered.id, 'no');
  inbox.delivered(delivered.id);
  inbox.close();
  inbox.close();
  assert.deepEqual(await pending.decision, { kind: 'cancelled' });
  inbox.delivered(accepted.id);
  assert.equal(
    inbox.list().find((item) => item.id === accepted.id)?.status,
    'stale',
  );
  assert.equal(
    inbox.list().find((item) => item.id === delivered.id)?.status,
    'delivered',
  );
  assert.throws(() => inbox.request(input), /closed/);
  const fresh = createAttention();
  assert.deepEqual(fresh.list(), []);
  assert.throws(() => fresh.answer(pending.id, 'yes'), /Unknown attention/);
});

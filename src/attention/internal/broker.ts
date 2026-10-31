import { randomUUID } from 'node:crypto';
import type {
  Attention,
  AttentionId,
  AttentionItem,
  Decision,
} from '../index.js';

export function createAttention(): Attention {
  let closed = false;
  const entries = new Map<
    AttentionId,
    { item: AttentionItem; resolve: (decision: Decision) => void }
  >();
  const listeners = new Set<(item: AttentionItem) => void>();
  const notify = (item: AttentionItem) => {
    for (const listener of listeners) {
      try {
        listener(structuredClone(item));
      } catch {
        /* Observers cannot invalidate a decision. */
      }
    }
  };
  /** Shared bounds; finished receipts make room before new items are refused. */
  function admit() {
    if (closed) throw new Error('Attention inbox is closed');
    if (
      [...entries.values()].filter((e) => e.item.status === 'pending').length >=
      100
    )
      throw new Error('Attention inbox capacity reached');
    for (const [id, entry] of entries) {
      if (entries.size < 500) break;
      if (['delivered', 'stale', 'done'].includes(entry.item.status))
        entries.delete(id);
    }
    if (entries.size >= 500)
      throw new Error('Attention inbox capacity reached');
    const id: AttentionId = `attn-${randomUUID()}`;
    return { id, createdAt: new Date().toISOString() };
  }
  return {
    request(input) {
      if (
        !input.choices.length ||
        new Set(input.choices.map((c) => c.id)).size !== input.choices.length
      )
        throw new Error('Choices must be non-empty and unique');
      const { id, createdAt } = admit();
      let resolve: (decision: Decision) => void = () => {};
      const decision = new Promise<Decision>((done) => {
        resolve = done;
      });
      const item: AttentionItem = {
        ...structuredClone(input),
        kind: 'permission',
        id,
        createdAt,
        status: 'pending',
      };
      entries.set(id, { item, resolve });
      notify(item);
      return { id, decision };
    },
    ask(input) {
      if (!input.title.trim() || input.steps.length > 8)
        throw new Error('An agent request needs a title and at most 8 steps');
      if (
        [...entries.values()].filter(
          (e) =>
            e.item.kind === 'agent-request' &&
            e.item.runId === input.runId &&
            e.item.status === 'pending',
        ).length >= 20
      )
        throw new Error('This Run already has 20 open agent requests');
      const { id, createdAt } = admit();
      const item: AttentionItem = {
        ...structuredClone(input),
        kind: 'agent-request',
        id,
        createdAt,
        status: 'pending',
      };
      // Nothing waits on an agent request; its entry never resolves a decision.
      entries.set(id, { item, resolve: () => {} });
      notify(item);
      return id;
    },
    answer(id, choiceId) {
      if (closed) throw new Error('Attention inbox is closed');
      const entry = entries.get(id);
      if (!entry) throw new Error('Unknown attention item');
      if (entry.item.kind !== 'permission')
        throw new Error('Only permission requests take a choice');
      if (entry.item.status === 'stale') return 'stale';
      if (entry.item.status !== 'pending') return 'already-answered';
      if (!entry.item.choices.some((c) => c.id === choiceId))
        throw new Error('Unknown decision choice');
      const accepted: AttentionItem = {
        ...entry.item,
        status: 'accepted',
        choiceId,
      };
      entry.item = accepted;
      entry.resolve({ kind: 'selected', choiceId });
      notify(entry.item);
      return 'accepted';
    },
    complete(id) {
      if (closed) throw new Error('Attention inbox is closed');
      const entry = entries.get(id);
      if (!entry) throw new Error('Unknown attention item');
      if (entry.item.kind !== 'agent-request')
        throw new Error('Only agent requests can be marked done');
      if (entry.item.status === 'stale') return 'stale';
      if (entry.item.status === 'done') return 'already-done';
      const done: AttentionItem = { ...entry.item, status: 'done' };
      entry.item = done;
      notify(entry.item);
      return 'done';
    },
    delivered(id) {
      if (closed) return;
      const entry = entries.get(id);
      if (entry?.item.kind !== 'permission' || entry.item.status !== 'accepted')
        return;
      const delivered: AttentionItem = { ...entry.item, status: 'delivered' };
      entry.item = delivered;
      notify(entry.item);
    },
    invalidate(target, reason, options) {
      if (closed) return;
      for (const entry of entries.values()) {
        const item = entry.item;
        if (
          (item.runId !== target && item.id !== target) ||
          !['pending', 'accepted'].includes(item.status) ||
          (item.kind === 'agent-request' && !options?.includeRequests)
        )
          continue;
        const stale: AttentionItem =
          item.kind === 'permission'
            ? { ...item, status: 'stale', reason }
            : { ...item, status: 'stale', reason };
        entry.item = stale;
        entry.resolve({ kind: 'cancelled' });
        notify(entry.item);
      }
    },
    list(runId) {
      return [...entries.values()]
        .filter((e) => !runId || e.item.runId === runId)
        .map((e) => structuredClone(e.item));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of entries.values()) {
        const item = entry.item;
        if (!['pending', 'accepted'].includes(item.status)) continue;
        const reason = 'Attention inbox closed';
        const stale: AttentionItem =
          item.kind === 'permission'
            ? { ...item, status: 'stale', reason }
            : { ...item, status: 'stale', reason };
        entry.item = stale;
        entry.resolve({ kind: 'cancelled' });
        notify(stale);
      }
      listeners.clear();
    },
  };
}

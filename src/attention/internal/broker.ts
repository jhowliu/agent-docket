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
  return {
    request(input) {
      if (closed) throw new Error('Attention inbox is closed');
      if (
        [...entries.values()].filter((e) => e.item.status === 'pending')
          .length >= 100
      )
        throw new Error('Attention inbox capacity reached');
      if (
        !input.choices.length ||
        new Set(input.choices.map((c) => c.id)).size !== input.choices.length
      )
        throw new Error('Choices must be non-empty and unique');
      for (const [id, entry] of entries) {
        if (entries.size < 500) break;
        if (entry.item.status === 'delivered' || entry.item.status === 'stale')
          entries.delete(id);
      }
      if (entries.size >= 500)
        throw new Error('Attention inbox capacity reached');
      const id: AttentionId = `attn-${randomUUID()}`;
      let resolve: (decision: Decision) => void = () => {};
      const decision = new Promise<Decision>((done) => {
        resolve = done;
      });
      const item: AttentionItem = {
        ...structuredClone(input),
        id,
        createdAt: new Date().toISOString(),
        status: 'pending',
      };
      entries.set(id, { item, resolve });
      notify(item);
      return { id, decision };
    },
    answer(id, choiceId) {
      if (closed) throw new Error('Attention inbox is closed');
      const entry = entries.get(id);
      if (!entry) throw new Error('Unknown attention item');
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
    delivered(id) {
      if (closed) return;
      const entry = entries.get(id);
      if (entry?.item.status !== 'accepted') return;
      const delivered: AttentionItem = { ...entry.item, status: 'delivered' };
      entry.item = delivered;
      notify(entry.item);
    },
    invalidate(target, reason) {
      if (closed) return;
      for (const entry of entries.values()) {
        if (
          (entry.item.runId !== target && entry.item.id !== target) ||
          !['pending', 'accepted'].includes(entry.item.status)
        )
          continue;
        const stale: AttentionItem = { ...entry.item, status: 'stale', reason };
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
        if (!['pending', 'accepted'].includes(entry.item.status)) continue;
        const stale: AttentionItem = {
          ...entry.item,
          status: 'stale',
          reason: 'Attention inbox closed',
        };
        entry.item = stale;
        entry.resolve({ kind: 'cancelled' });
        notify(stale);
      }
      listeners.clear();
    },
  };
}

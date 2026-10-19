import { randomUUID } from 'node:crypto';
import type {
  Attention,
  AttentionId,
  AttentionItem,
  Decision,
} from '../index.js';

export function createAttention(): Attention {
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
        throw new Error('Attention history capacity reached');
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
      const entry = entries.get(id);
      if (!entry) throw new Error('Unknown attention item');
      if (entry.item.status === 'stale') return 'stale';
      if (entry.item.status !== 'pending') return 'already-answered';
      if (!entry.item.choices.some((c) => c.id === choiceId))
        throw new Error('Unknown decision choice');
      entry.item = { ...entry.item, status: 'accepted', choiceId };
      entry.resolve({ kind: 'selected', choiceId });
      notify(entry.item);
      return 'accepted';
    },
    delivered(id) {
      const entry = entries.get(id);
      if (entry?.item.status !== 'accepted') return;
      entry.item = { ...entry.item, status: 'delivered' };
      notify(entry.item);
    },
    invalidate(target, reason) {
      for (const entry of entries.values()) {
        if (
          (entry.item.runId !== target && entry.item.id !== target) ||
          !['pending', 'accepted'].includes(entry.item.status)
        )
          continue;
        entry.item = { ...entry.item, status: 'stale', reason };
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
  };
}

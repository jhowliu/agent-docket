export type AttentionId = `attn-${string}`;
/** Opaque foreign reference; execution owns Run allocation and lifecycle. */
type RunReference = `run-${string}`;
export type Choice = Readonly<{
  id: string;
  label: string;
  kind: 'allow-once' | 'allow-always' | 'reject-once' | 'reject-always';
}>;
type Content = Readonly<{
  id: AttentionId;
  runId: RunReference;
  title: string;
  detail: string;
  choices: readonly Choice[];
  createdAt: string;
}>;
export type AttentionItem = Content &
  (
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'accepted' | 'delivered'; choiceId: string }>
    | Readonly<{ status: 'stale'; reason: string; choiceId?: string }>
  );
export type Decision =
  | Readonly<{ kind: 'selected'; choiceId: string }>
  | Readonly<{ kind: 'cancelled' }>;
export interface Attention {
  /** At most 100 pending items; in-memory receipts are bounded to 500 items. */
  request(input: Omit<Content, 'id' | 'createdAt'>): {
    id: AttentionId;
    decision: Promise<Decision>;
  };
  /** Synchronous acceptance. Repeats never resolve a request twice. */
  answer(
    id: AttentionId,
    choiceId: string,
  ): 'accepted' | 'already-answered' | 'stale';
  /** Execution calls this only after writing the corresponding ACP response. */
  delivered(id: AttentionId): void;
  invalidate(target: RunReference | AttentionId, reason: string): void;
  list(runId?: RunReference): readonly AttentionItem[];
  subscribe(listener: (item: AttentionItem) => void): () => void;
  /** Invalidates unfinished decisions and closes the in-memory inbox. */
  close(): void;
}
export { attentionItemSchema } from './internal/contract.js';
export { createAttention } from './internal/broker.js';

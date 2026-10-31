export type AttentionId = `attn-${string}`;
/** Opaque foreign reference; execution owns Run allocation and lifecycle. */
type RunReference = `run-${string}`;
export type Choice = Readonly<{
  id: string;
  label: string;
  kind: 'allow-once' | 'allow-always' | 'reject-once' | 'reject-always';
}>;
type Base = Readonly<{
  id: AttentionId;
  runId: RunReference;
  title: string;
  createdAt: string;
}>;
/** A provider permission request; the chosen option is delivered back to the agent. */
export type PermissionItem = Base &
  Readonly<{
    kind: 'permission';
    detail: string;
    /** What it acts on, for display: a command line or a file path. */
    subject?: string;
    choices: readonly Choice[];
  }> &
  (
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'accepted' | 'delivered'; choiceId: string }>
    | Readonly<{ status: 'stale'; reason: string; choiceId?: string }>
  );
/**
 * Something the agent explicitly asked the person to do outside the session
 * (`action`) or to answer (`question`). Marking it done tells the agent nothing
 * and verifies nothing; a reply is an ordinary next prompt.
 */
export type AgentRequestItem = Base &
  Readonly<{
    kind: 'agent-request';
    request: 'action' | 'question';
    steps: readonly string[];
  }> &
  (
    | Readonly<{ status: 'pending' | 'done' }>
    | Readonly<{ status: 'stale'; reason: string }>
  );
export type AttentionItem = PermissionItem | AgentRequestItem;
export type PermissionRequest = Readonly<{
  runId: RunReference;
  title: string;
  detail: string;
  subject?: string;
  choices: readonly Choice[];
}>;
export type AgentRequest = Readonly<{
  runId: RunReference;
  request: 'action' | 'question';
  title: string;
  steps: readonly string[];
}>;
export type Decision =
  | Readonly<{ kind: 'selected'; choiceId: string }>
  | Readonly<{ kind: 'cancelled' }>;
export interface Attention {
  /** At most 100 pending items; in-memory receipts are bounded to 500 items. */
  request(input: PermissionRequest): {
    id: AttentionId;
    decision: Promise<Decision>;
  };
  /**
   * Records an agent request as pending and returns at once; nothing waits for
   * it. At most 20 pending agent requests per Run, within the shared bounds.
   */
  ask(input: AgentRequest): AttentionId;
  /** Synchronous acceptance of a permission choice. Repeats never resolve a request twice. */
  answer(
    id: AttentionId,
    choiceId: string,
  ): 'accepted' | 'already-answered' | 'stale';
  /** Marks a pending agent request done. Nothing is sent to the agent. */
  complete(id: AttentionId): 'done' | 'already-done' | 'stale';
  /** Execution calls this only after writing the corresponding ACP response. */
  delivered(id: AttentionId): void;
  /**
   * Invalidates pending/accepted permission decisions. Agent requests outlive a
   * turn; `includeRequests` also retires them when their Run ends.
   */
  invalidate(
    target: RunReference | AttentionId,
    reason: string,
    options?: { includeRequests?: boolean },
  ): void;
  list(runId?: RunReference): readonly AttentionItem[];
  subscribe(listener: (item: AttentionItem) => void): () => void;
  /** Invalidates unfinished decisions and requests and closes the in-memory inbox. */
  close(): void;
}
export { attentionItemSchema } from './internal/contract.js';
export { createAttention } from './internal/broker.js';

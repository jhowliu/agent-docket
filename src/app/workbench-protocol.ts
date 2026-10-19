import { z } from 'zod';
import type { AttentionId, AttentionItem } from '../attention/index.js';
import type {
  RunEvent,
  RunId,
  RunSnapshot,
  RunState,
} from '../execution/index.js';

const runId = z.custom<RunId>(
  (value) => typeof value === 'string' && /^run-[a-zA-Z0-9-]+$/.test(value),
);
const attentionId = z.custom<AttentionId>(
  (value) => typeof value === 'string' && /^attn-[a-zA-Z0-9-]+$/.test(value),
);
const runState: z.ZodType<RunState> = z.union([
  z.object({
    kind: z.enum([
      'starting',
      'idle',
      'running',
      'cancelling',
      'cancelled',
      'closed',
    ]),
  }),
  z.object({
    kind: z.literal('authentication-required'),
    methods: z.array(z.object({ id: z.string(), label: z.string() })),
  }),
  z.object({ kind: z.enum(['failed', 'interrupted']), reason: z.string() }),
]);
const capabilities = z.object({
  protocolVersion: z.number().int(),
  agent: z.string(),
  version: z.string(),
  loadSessionAdvertised: z.boolean(),
  clientFilesystem: z.literal(false),
  clientTerminal: z.literal(false),
  structuredQuestions: z.literal(false),
  resumeImplemented: z.literal(false),
});
const run: z.ZodType<RunSnapshot> = z.object({
  id: runId,
  provider: z.enum(['fixture', 'codex', 'claude']),
  label: z.string(),
  state: runState,
  environment: z.object({
    kind: z.enum(['trusted-fixture-directory', 'local', 'docker', 'ssh']),
    location: z.string(),
  }),
  capabilities: capabilities.nullable(),
});
const choice = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['allow-once', 'allow-always', 'reject-once', 'reject-always']),
});
const attentionContent = z.object({
  id: attentionId,
  runId,
  title: z.string(),
  detail: z.string(),
  choices: z.array(choice),
  createdAt: z.string(),
});
const item: z.ZodType<AttentionItem> = z.union([
  attentionContent.extend({ status: z.literal('pending') }),
  attentionContent.extend({
    status: z.enum(['accepted', 'delivered']),
    choiceId: z.string(),
  }),
  attentionContent.extend({ status: z.literal('stale'), reason: z.string() }),
]);
const eventBase = z.object({
  sequence: z.number().int().nonnegative(),
  runId,
  at: z.string(),
});
const event: z.ZodType<RunEvent> = z.discriminatedUnion('type', [
  eventBase.extend({ type: z.literal('run.state'), state: runState }),
  eventBase.extend({ type: z.literal('capabilities'), capabilities }),
  eventBase.extend({ type: z.literal('agent.message'), text: z.string() }),
  eventBase.extend({
    type: z.literal('tool'),
    id: z.string(),
    title: z.string(),
    status: z.string(),
  }),
  eventBase.extend({
    type: z.literal('diff'),
    path: z.string(),
    oldText: z.string(),
    newText: z.string(),
  }),
  eventBase.extend({
    type: z.literal('attention'),
    id: z.string(),
    status: z.string(),
  }),
  eventBase.extend({ type: z.literal('turn.end'), reason: z.string() }),
  eventBase.extend({ type: z.literal('diagnostic'), message: z.string() }),
]);

export const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }).strict(),
  z
    .object({
      kind: z.literal('prompt'),
      runId,
      text: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z.object({ kind: z.literal('cancel'), runId }).strict(),
  z
    .object({
      kind: z.literal('authenticate'),
      runId,
      methodId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('answer'),
      id: attentionId,
      choiceId: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ kind: z.literal('shutdown') }).strict(),
]);
export type WorkbenchCommand = z.infer<typeof commandSchema>;
export const stateSchema = z.object({
  // Older browser fixture servers omit instanceId. Their bootstrap token identifies the instance.
  instanceId: z.string().optional(),
  runs: z.array(run).max(20),
  attention: z.array(item).max(600),
  events: z.array(event).max(2000),
  cursor: z.number().int().nonnegative(),
  reset: z.boolean(),
  source: z.string(),
  configurationId: z.string().optional(),
  launch: z
    .object({
      provider: z.enum(['fixture', 'codex', 'claude']),
      kind: z.enum(['trusted-fixture-directory', 'local', 'docker', 'ssh']),
    })
    .optional(),
});
export type WorkbenchState = z.infer<typeof stateSchema>;
export const replySchema = z.union([
  z.object({ runId }),
  z.object({
    result: z.enum(['accepted', 'cancelled', 'already-answered', 'stale']),
  }),
]);
export type WorkbenchReply = z.infer<typeof replySchema>;

export function workbenchOrigin(
  port = process.env['WORKBENCH_PORT'] ?? '4177',
): string {
  if (!/^\d{4,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error('WORKBENCH_PORT must be an integer between 1024 and 65535');
  return `http://127.0.0.1:${Number(port)}`;
}

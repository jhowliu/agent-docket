import { z } from 'zod';
import { attentionItemSchema } from '../attention/index.js';
import type { AttentionId } from '../attention/index.js';
import {
  runIdSchema,
  runSnapshotSchema,
  runEventSchema,
  directoryPathSchema,
} from '../execution/index.js';
import { workCommandSchema, workSnapshotSchema } from '../work/index.js';

const runId = runIdSchema;
const attentionId = z.custom<AttentionId>(
  (value) => typeof value === 'string' && /^attn-[a-zA-Z0-9-]+$/.test(value),
);
const run = runSnapshotSchema;
const item = attentionItemSchema;
const event = runEventSchema;
export const directoryRequestSchema = z
  .object({ runId, path: directoryPathSchema })
  .strict();

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
  ...workCommandSchema.options,
]);
export type WorkbenchCommand = z.infer<typeof commandSchema>;
export const stateSchema = z.object({
  // Older browser fixture servers omit instanceId. Their bootstrap token identifies the instance.
  instanceId: z.string().optional(),
  runs: z.array(run).max(64),
  attention: z.array(item).max(600),
  events: z.array(event).max(2000),
  cursor: z.number().int().nonnegative(),
  reset: z.boolean(),
  source: z.string(),
  configurationId: z.string().optional(),
  work: workSnapshotSchema.optional(),
  features: z.object({ directoryTree: z.boolean() }).optional(),
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

// Fetch Standard bad ports within our supported 1024–65535 range.
// https://fetch.spec.whatwg.org/#port-blocking
const blockedHttpPorts = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6679, 6697, 10080,
]);

export function workbenchOrigin(
  port = process.env['WORKBENCH_PORT'] ?? '4177',
): string {
  if (!/^\d{4,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error('WORKBENCH_PORT must be an integer between 1024 and 65535');
  if (blockedHttpPorts.has(Number(port)))
    throw new Error(
      `WORKBENCH_PORT ${Number(port)} is blocked by Fetch; choose another port, for example 4182.`,
    );
  return `http://127.0.0.1:${Number(port)}`;
}

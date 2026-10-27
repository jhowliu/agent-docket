import { z } from 'zod';
import { attentionItemSchema } from '../attention/index.js';
import type { AttentionId } from '../attention/index.js';
import {
  runIdSchema,
  runSnapshotSchema,
  runEventSchema,
  directoryPathSchema,
  projectInitializationSchema,
} from '../execution/index.js';
import {
  workCommandSchema,
  workSnapshotSchema,
  projectWorkSchema,
  projectOverviewSchema,
  projectCheckSchema,
  runReviewSchema,
  runVerificationSchema,
  taskFlowSchema,
} from '../work/index.js';

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
export const changesRequestSchema = z
  .object({
    runId,
    /** `only`: files and hunks without the TypeScript pass (the Diff tab). */
    files: z.literal('only').optional(),
  })
  .strict();
export const projectRequestSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) => value.startsWith('/') && !/[\u0000-\u001f]/u.test(value),
      ),
  })
  .strict();
export const initializeProjectRequestSchema = z
  .object({
    project: projectInitializationSchema,
    confirm: z.literal(true),
  })
  .strict();
export const sessionOptionsSchema = z
  .object({
    defaultPath: z.string().min(1).max(4096),
    defaultPreset: z.string().min(1),
    presets: z
      .array(
        z
          .object({
            id: z.string().min(1).max(40),
            label: z.string().min(1).max(100),
            kind: z.enum(['local', 'fixed', 'fixture']),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();

export const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }).strict(),
  z
    .object({
      kind: z.literal('new-session'),
      presetId: z.string().min(1).max(40),
      project: z
        .object({
          path: projectRequestSchema.shape.path,
          base: z
            .object({
              branch: z.string().min(1).max(255).optional(),
              revision: z.string().regex(/^[a-f0-9]{40,64}$/),
            })
            .strict(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('project-work'),
      projectId: projectWorkSchema.shape.id,
      command: workCommandSchema,
    })
    .strict(),
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
      kind: z.literal('commit-workspace'),
      runId,
      message: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .refine((value) => !value.includes('\0')),
    })
    .strict(),
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
  // Marks an agent request done; nothing is sent to the agent.
  z.object({ kind: z.literal('complete-request'), id: attentionId }).strict(),
  // Freezes the Run's code and runs its project's check on it.
  z.object({ kind: z.literal('verify'), runId }).strict(),
  // Human Review: accept the Run's Task on passing checks, or send it back.
  z.object({ kind: z.literal('accept'), runId }).strict(),
  z
    .object({
      kind: z.literal('request-changes'),
      runId,
      text: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('set-check'),
      projectId: projectWorkSchema.shape.id,
      command: projectCheckSchema.shape.command,
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
  projects: z.array(projectWorkSchema).max(65).optional(),
  // Older daemons omit it; the TUI then lists Runs in launch order.
  overview: z.array(projectOverviewSchema).max(65).optional(),
  checks: z.array(projectCheckSchema).max(65).optional(),
  verifications: z.array(runVerificationSchema).max(64).optional(),
  flows: z.array(taskFlowSchema).max(64).optional(),
  reviews: z.array(runReviewSchema).max(64).optional(),
  defaultProjectId: projectWorkSchema.shape.id.optional(),
  sessionOptions: sessionOptionsSchema.optional(),
  features: z
    .object({
      directoryTree: z.boolean(),
      newSession: z.boolean().optional(),
      folderCompletion: z.boolean().optional(),
      projectInitialization: z.boolean().optional(),
      changeMap: z.boolean().optional(),
      verify: z.boolean().optional(),
      flow: z.boolean().optional(),
      review: z.boolean().optional(),
    })
    .optional(),
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
    result: z.enum([
      'accepted',
      'cancelled',
      'already-answered',
      'stale',
      'done',
      'already-done',
    ]),
    branch: z.string().optional(),
    workspaceRemoved: z.boolean().optional(),
    /** The Run left the list: cancelled or committed, with nothing left to save. */
    removed: z.boolean().optional(),
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

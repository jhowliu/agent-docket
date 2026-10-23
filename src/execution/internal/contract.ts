import { z } from 'zod';
import type {
  RunEvent,
  RunId,
  RunSnapshot,
  RunState,
  WorktreeSnapshot,
} from '../index.js';

const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const worktree: z.ZodType<WorktreeSnapshot> = z.object({
  path: z.string(),
  branch: z.string(),
  baseRevision: z.string().regex(/^[a-f0-9]{40,64}$/),
  tree: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  status: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('active') }),
    z.object({ kind: z.literal('removed') }),
    z.object({
      kind: z.literal('commit-required'),
      changes: z.number().int().positive(),
    }),
    z.object({ kind: z.literal('retained'), reason: z.string() }),
  ]),
});

export const runIdSchema = z.custom<RunId>(
  (value) => typeof value === 'string' && /^run-[a-zA-Z0-9-]+$/.test(value),
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
export const runSnapshotSchema: z.ZodType<RunSnapshot> = z.object({
  id: runIdSchema,
  provider: z.enum(['fixture', 'codex', 'claude']),
  label: z.string(),
  state: runState,
  environment: z.object({
    kind: z.enum(['trusted-fixture-directory', 'local', 'docker', 'ssh']),
    location: z.string(),
  }),
  capabilities: capabilities.nullable(),
  worktree: worktree.optional(),
});
const base = z.object({
  sequence: z.number().int().positive(),
  runId: runIdSchema,
  at: z.string(),
});
export const runEventSchema: z.ZodType<RunEvent> = z.discriminatedUnion(
  'type',
  [
    base.extend({ type: z.literal('run.state'), state: runState }),
    base.extend({ type: z.literal('capabilities'), capabilities }),
    base.extend({ type: z.literal('agent.message'), text: z.string() }),
    base.extend({
      type: z.literal('agent.progress'),
      summary: z.string().min(1).max(2000),
    }),
    base.extend({ type: z.literal('turn.start'), text: z.string() }),
    base.extend({
      type: z.literal('tool'),
      id: z.string(),
      title: z.string(),
      status: z.string(),
    }),
    base.extend({
      type: z.literal('diff'),
      path: z.string(),
      oldText: z.string(),
      newText: z.string(),
    }),
    base.extend({
      type: z.literal('attention'),
      id: z.string(),
      status: z.string(),
    }),
    base.extend({
      type: z.literal('check.start'),
      command: z.string(),
      candidate: sha,
    }),
    base.extend({
      type: z.literal('check.end'),
      command: z.string(),
      candidate: sha,
      outcome: z.enum(['exited', 'timed-out', 'cancelled', 'failed-to-start']),
      exitCode: z.number().int().nullable(),
      output: z.string(),
      truncated: z.boolean(),
      durationMs: z.number().int().nonnegative(),
    }),
    base.extend({ type: z.literal('turn.end'), reason: z.string() }),
    base.extend({ type: z.literal('diagnostic'), message: z.string() }),
  ],
);

import { z } from 'zod';
import { runIdSchema } from '../../execution/index.js';

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (value) => !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value),
      'Use plain text',
    );
const title = text(120).min(1);
const id = (prefix: string) =>
  z
    .string()
    .regex(
      new RegExp(
        `^${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`,
      ),
    );
export const stageSchema = z.enum([
  'clarification',
  'development',
  'agent-review',
  'human-review',
]);
const taskSchema = z
  .object({
    id: id('task'),
    title,
    spec: z
      .object({
        revision: z.number().int().positive(),
        text: text(4000),
        confirmed: z.boolean(),
      })
      .strict(),
    stage: stageSchema,
    status: z.enum(['planned', 'active']),
  })
  .strict()
  .refine(
    (task) => task.stage === 'clarification' || task.spec.confirmed,
    'Confirm requirements before tracking another stage',
  );
const phaseSchema = z
  .object({
    id: id('phase'),
    title,
    goal: text(1000),
    tasks: z.array(taskSchema).max(16),
  })
  .strict();

export const planSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().regex(/^[a-f0-9]{64}$/),
    title,
    revision: z.number().int().positive(),
    activePhaseId: id('phase'),
    phases: z.array(phaseSchema).min(1).max(8),
  })
  .strict()
  .superRefine((plan, context) => {
    const phaseIds = plan.phases.map((phase) => phase.id);
    const taskIds = plan.phases.flatMap((phase) =>
      phase.tasks.map((task) => task.id),
    );
    if (
      !phaseIds.includes(plan.activePhaseId) ||
      new Set(phaseIds).size !== phaseIds.length ||
      new Set(taskIds).size !== taskIds.length ||
      taskIds.length > 64
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid Roadmap references or limits',
      });
  });

const revision = { expectedRevision: z.number().int().nonnegative() };
export const workCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('work.create'),
      ...revision,
      runId: runIdSchema.optional(),
      title,
      phaseTitle: title,
      taskTitle: title,
      spec: text(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('work.add-phase'),
      ...revision,
      title,
      goal: text(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('work.add-task'),
      ...revision,
      phaseId: id('phase'),
      title,
      spec: text(4000),
      runId: runIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('work.attach'),
      ...revision,
      runId: runIdSchema,
      taskId: id('task'),
    })
    .strict(),
  z
    .object({ kind: z.literal('work.detach'), ...revision, runId: runIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal('work.spec'),
      ...revision,
      taskId: id('task'),
      text: text(4000).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('work.confirm'),
      ...revision,
      taskId: id('task'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('work.stage'),
      ...revision,
      taskId: id('task'),
      stage: stageSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('work.focus'),
      ...revision,
      phaseId: id('phase'),
    })
    .strict(),
]);

export const workSnapshotSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ready'),
      persistence: z.enum(['memory', 'project-file']),
      plan: planSchema.nullable(),
      bindings: z
        .array(z.object({ runId: runIdSchema, taskId: id('task') }).strict())
        .max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      reason: z.string().max(400),
      plan: z.null(),
      bindings: z.array(z.never()).length(0),
    })
    .strict(),
]);

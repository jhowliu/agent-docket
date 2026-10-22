import { z } from 'zod';
import type { AttentionId, AttentionItem } from '../index.js';

const base = z.object({
  id: z.custom<AttentionId>(
    (value) => typeof value === 'string' && /^attn-[a-zA-Z0-9-]+$/.test(value),
  ),
  runId: z.custom<`run-${string}`>(
    (value) => typeof value === 'string' && /^run-[a-zA-Z0-9-]+$/.test(value),
  ),
  title: z.string(),
  createdAt: z.string(),
});

const permission = base.extend({
  // Daemons before agent requests sent permission items without `kind`.
  kind: z.literal('permission').default('permission'),
  detail: z.string(),
  choices: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        kind: z.enum([
          'allow-once',
          'allow-always',
          'reject-once',
          'reject-always',
        ]),
      }),
    )
    .min(1)
    .refine(
      (choices) =>
        new Set(choices.map((choice) => choice.id)).size === choices.length,
    ),
});

const agentRequest = base.extend({
  kind: z.literal('agent-request'),
  request: z.enum(['action', 'question']),
  steps: z.array(z.string()).max(8),
});

export const attentionItemSchema: z.ZodType<AttentionItem> = z.union([
  agentRequest.extend({ status: z.enum(['pending', 'done']) }),
  agentRequest.extend({ status: z.literal('stale'), reason: z.string() }),
  z
    .union([
      permission.extend({ status: z.literal('pending') }),
      permission.extend({
        status: z.enum(['accepted', 'delivered']),
        choiceId: z.string(),
      }),
      permission
        .extend({
          status: z.literal('stale'),
          reason: z.string(),
          choiceId: z.string().optional(),
        })
        .transform(({ choiceId, ...item }) =>
          choiceId === undefined ? item : { ...item, choiceId },
        ),
    ])
    .refine(
      (item) =>
        !('choiceId' in item) ||
        item.choiceId === undefined ||
        item.choices.some((choice) => choice.id === item.choiceId),
    ),
]);

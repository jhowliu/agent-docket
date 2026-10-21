import { z } from 'zod';
import type { AttentionId, AttentionItem } from '../index.js';

const content = z.object({
  id: z.custom<AttentionId>(
    (value) => typeof value === 'string' && /^attn-[a-zA-Z0-9-]+$/.test(value),
  ),
  runId: z.custom<`run-${string}`>(
    (value) => typeof value === 'string' && /^run-[a-zA-Z0-9-]+$/.test(value),
  ),
  title: z.string(),
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
  createdAt: z.string(),
});

export const attentionItemSchema: z.ZodType<AttentionItem> = z
  .union([
    content.extend({ status: z.literal('pending') }),
    content.extend({
      status: z.enum(['accepted', 'delivered']),
      choiceId: z.string(),
    }),
    content
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
  );

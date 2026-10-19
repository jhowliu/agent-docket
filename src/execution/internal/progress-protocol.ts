import { z } from 'zod';

export const progressInstructions =
  'Use the report_progress tool to give the workbench concise progress updates in English, each at most 50 words. ' +
  'Report meaningful progress, a discovery, a blocker, a needed decision, or the outcome of your work. ' +
  'Explain what changed and the next step when useful. Choose your own wording; there are no progress categories. ' +
  'Do not report every tool call or repeat unchanged status. Keep the final answer in the conversation. ' +
  'Use the normal permission mechanism for approvals; a progress report does not grant permission or establish verification.';

/** Length validation only. No keyword classification or interpretation of the report. */
export const progressSummary = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((text) => text.split(/\s+/u).length <= 50, 'Use at most 50 words')
  .refine(
    (text) => !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text),
    'Use plain text',
  );

export const progressInput = z.object({ summary: progressSummary }).strict();

export const progressRecord = z.object({
  turn: z.string().uuid(),
  summary: progressSummary,
});

export const progressLimit = 1024 * 1024;

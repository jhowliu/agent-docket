import { z } from 'zod';

export const progressInstructions =
  'Use the report_progress tool to give the workbench concise progress updates in English, each at most 50 words. ' +
  'Report meaningful progress, a discovery, a blocker, a needed decision, or the outcome of your work. ' +
  'Explain what changed and the next step when useful. Choose your own wording; there are no progress categories. ' +
  'Do not report every tool call or repeat unchanged status. Keep the final answer in the conversation. ' +
  'Use the normal permission mechanism for approvals; a progress report does not grant permission or establish verification.';

export const requestInstructions =
  'Call request_user when the person must do something outside this session before work can continue or take effect ' +
  '(run a command, restart a program, sign in, provide information), or must answer a question. ' +
  'Give a short English title and, for an action, the exact steps or commands in order. ' +
  'It returns immediately; nothing waits for the person, so also explain it in your answer and end the turn. ' +
  'Do not use it for approvals, progress updates or optional suggestions.';

/** Everything the Run's private tools ask of the agent; appended to each prompt. */
export const workbenchInstructions = `${progressInstructions} ${requestInstructions}`;

const plain = (text: string) =>
  !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text);

/** Length validation only. No keyword classification or interpretation of the report. */
export const progressSummary = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((text) => text.split(/\s+/u).length <= 50, 'Use at most 50 words')
  .refine(plain, 'Use plain text');

export const progressInput = z.object({ summary: progressSummary }).strict();

export const progressRecord = z.object({
  turn: z.string().uuid(),
  summary: progressSummary,
});

/** Shape and length only; the workbench never infers meaning from the text. */
export const requestInput = z
  .object({
    kind: z.enum(['action', 'question']),
    title: z.string().trim().min(1).max(120).refine(plain, 'Use plain text'),
    steps: z
      .array(z.string().trim().min(1).max(300).refine(plain, 'Use plain text'))
      .max(8, 'Use at most 8 steps'),
  })
  .strict();

export const requestRecord = z.object({
  turn: z.string().uuid(),
  request: requestInput,
});

/** One line of the Run's private tool journal. */
export const toolRecord = z.union([progressRecord, requestRecord]);

/** Agent requests accepted per turn; more are refused so a loop cannot flood the inbox. */
export const requestsPerTurn = 5;

export const progressLimit = 1024 * 1024;

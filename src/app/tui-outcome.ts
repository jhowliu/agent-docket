import type { AttentionItem } from '../attention/index.js';
import type { RunEvent, RunId } from '../execution/index.js';
import { terminalText } from './tui-input.js';

/**
 * How a turn ended, from what its agent declared through the Run's private
 * tools: `request_user` (blocked or a question) or `report_progress` with
 * `finished`. Never inferred from the conversation; `none` means it declared
 * nothing. `finished` is the agent's claim, not verification.
 */
export type TurnOutcome = Readonly<
  | {
      kind: 'blocked' | 'question';
      title: string;
      steps: readonly string[];
      /** Marked done by the person; the agent has not been told. */
      done: boolean;
    }
  | { kind: 'finished'; summary: string }
  | { kind: 'none' }
>;

const NONE: TurnOutcome = { kind: 'none' };

/** A turn starts when its input is accepted or the Run starts running it. */
export const startsTurn = (event: RunEvent) =>
  event.type === 'turn.start' ||
  (event.type === 'run.state' && event.state.kind === 'running');

/**
 * One turn's outcome from its own events. An open request outranks a done
 * one, and any request outranks a finished report: the agent still needs you.
 */
export function outcomeOf(
  turn: readonly RunEvent[],
  attention: readonly AttentionItem[],
): TurnOutcome {
  const asked = new Set(
    turn.flatMap((event) => (event.type === 'attention' ? [event.id] : [])),
  );
  const requests = attention.filter(
    (item): item is Extract<AttentionItem, { kind: 'agent-request' }> =>
      item.kind === 'agent-request' &&
      asked.has(item.id) &&
      item.status !== 'stale',
  );
  const request =
    requests.filter((item) => item.status === 'pending').at(-1) ??
    requests.at(-1);
  if (request)
    return {
      kind: request.request === 'question' ? 'question' : 'blocked',
      title: terminalText(request.title),
      steps: request.steps.map(terminalText),
      done: request.status === 'done',
    };
  const finished = turn
    .filter(
      (event): event is Extract<RunEvent, { type: 'agent.progress' }> =>
        event.type === 'agent.progress' && event.finished === true,
    )
    .at(-1);
  return finished
    ? { kind: 'finished', summary: terminalText(finished.summary) }
    : NONE;
}

/** Each Run's latest turn outcome, from the TUI's retained event window. */
export function latestOutcomes(
  events: readonly RunEvent[],
  attention: readonly AttentionItem[],
): ReadonlyMap<RunId, TurnOutcome> {
  const turns = new Map<RunId, RunEvent[]>();
  for (const event of events) {
    if (startsTurn(event)) turns.set(event.runId, []);
    else turns.get(event.runId)?.push(event);
  }
  return new Map(
    [...turns].map(([runId, turn]) => [runId, outcomeOf(turn, attention)]),
  );
}

/** The reply's last paragraph, verbatim and bounded; shown, never interpreted. */
export function lastParagraph(text: string): string {
  const paragraph =
    terminalText(text)
      .split(/\n\s*\n/)
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .at(-1) ?? '';
  return paragraph.length > 400 ? paragraph.slice(0, 399) + '…' : paragraph;
}

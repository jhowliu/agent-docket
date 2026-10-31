import type { AttentionItem } from '../attention/index.js';
import type { RunEvent } from '../execution/index.js';
import { terminalText } from './tui-input.js';
import { lastParagraph, outcomeOf, startsTurn } from './tui-outcome.js';
import { inlineText } from './tui-markdown.js';

export type TimelineEntry = Readonly<{
  sequence: number;
  at: string;
  text: string;
  label: string;
  detail: string;
  color: string;
  detailBold: boolean;
  /** Keeps the agent's own line breaks (progress); every row wraps on screen. */
  wrap: boolean;
  /** Dim lines beneath: a request's steps, or the end of the turn's reply. */
  notes: readonly string[];
  /** The turn this row belongs to, keyed like `turnReplies`; null before any turn. */
  turn: number | null;
}>;
type ToolActivity = {
  row: number | undefined;
  first: RunEvent;
  title: string;
  status: string;
};
function elapsed(start: string | undefined, end: string): string | undefined {
  if (!start) return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
const preview = (text: string) =>
  (
    terminalText(text)
      .split('\n')
      .find((line) => line.trim()) ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);

/**
 * What a finished check did, from its exit alone. Whether it still applies to
 * the Run's code is the evidence assessment, shown separately.
 */
export function checkEnded(
  event: Extract<RunEvent, { type: 'check.end' }>,
): Readonly<{ label: string; detail: string; color: string }> {
  const seconds = Math.round(event.durationMs / 1000);
  const time =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const sha = event.candidate.slice(0, 7);
  switch (event.outcome) {
    case 'exited':
      return event.exitCode === 0
        ? { label: 'Checks passed', detail: `${sha} · ${time}`, color: 'green' }
        : {
            label: 'Checks failed',
            detail: `${event.exitCode === null ? 'signal' : `exit ${event.exitCode}`} · ${sha} · ${time} · :live`,
            color: 'red',
          };
    case 'timed-out':
      return {
        label: 'Checks timed out',
        detail: `${sha} · :live`,
        color: 'red',
      };
    case 'cancelled':
      return { label: 'Checks cancelled', detail: sha, color: 'gray' };
    case 'failed-to-start':
      return {
        label: 'Checks could not start',
        detail: event.output.split('\n')[0] ?? '',
        color: 'yellow',
      };
  }
}

/**
 * Names each event's turn by the event that started it. A `turn.start` right
 * after the Run started running belongs to that same turn.
 */
function turnKeys(): (event: RunEvent) => number | null {
  let key: number | null = null;
  let open = false;
  return (event) => {
    if (startsTurn(event)) {
      if (!(open && event.type === 'turn.start')) key = event.sequence;
      open = true;
    } else if (event.type === 'turn.end') open = false;
    return key;
  };
}

/** Each turn's request and reply, verbatim; the reply is the agent's words, never interpreted. */
export function turnReplies(
  events: readonly RunEvent[],
): ReadonlyMap<number, Readonly<{ request: string; reply: string }>> {
  const turnOf = turnKeys();
  const turns = new Map<number, { request: string; parts: string[] }>();
  for (const event of readableEvents(events)) {
    const key = turnOf(event);
    if (key === null) continue;
    const turn = turns.get(key) ?? { request: '', parts: [] };
    turns.set(key, turn);
    if (event.type === 'turn.start') turn.request = event.text;
    else if (event.type === 'agent.message' && event.text.trim())
      turn.parts.push(event.text);
  }
  return new Map(
    [...turns].map(([key, turn]) => [
      key,
      { request: turn.request, reply: turn.parts.join('\n\n') },
    ]),
  );
}

/** Concatenate adjacent deltas for reading without changing raw events or cursors. */
export function readableEvents(events: readonly RunEvent[]): RunEvent[] {
  const result: RunEvent[] = [];
  let message: Extract<RunEvent, { type: 'agent.message' }> | undefined;
  let chunks: string[] = [];
  const flush = () => {
    if (message) result.push({ ...message, text: chunks.join('') });
    message = undefined;
    chunks = [];
  };
  for (const event of events) {
    if (event.type === 'agent.message') {
      message ??= event;
      chunks.push(event.text);
    } else {
      flush();
      result.push(event);
    }
  }
  flush();
  return result;
}

/** Reading projection of one Run's retained observations, never a verification verdict. */
export function timelineEntries(
  events: readonly RunEvent[],
  attention: readonly AttentionItem[],
): TimelineEntry[] {
  const rows: TimelineEntry[] = [];
  const decisions = new Map<string, AttentionItem>(
    attention.map((item) => [item.id, item]),
  );
  const tools = new Map<string, ToolActivity>();
  const files = new Set<string>();
  let turnAt: string | undefined;
  let requestRow: number | undefined;
  let ended = false;
  // The turn's own events decide its outcome; its reply opens with Space,
  // and its last paragraph sits under the turn's result row.
  let turn: RunEvent[] = [];
  const turnOf = turnKeys();
  let turnKey: number | null = null;
  let reply: string[] = [];
  // Marked-done requests the agent has not heard about until the next turn.
  let unreplied: { index: number; event: RunEvent; title: string }[] = [];
  const row = (
    event: RunEvent,
    label: string,
    detail = '',
    color = 'gray',
    detailBold = false,
    wrap = false,
  ): TimelineEntry => {
    const cleanLabel = terminalText(label).replace(/\s+/g, ' ').trim();
    const cleanDetail = wrap
      ? terminalText(detail).trim()
      : terminalText(detail).replace(/\s+/g, ' ').trim();
    return {
      sequence: event.sequence,
      at: event.at,
      text: [cleanLabel, ...(cleanDetail ? [cleanDetail] : [])].join(' · '),
      label: cleanLabel,
      detail: cleanDetail,
      color,
      detailBold,
      wrap,
      notes: [],
      turn: turnKey,
    };
  };
  for (const event of readableEvents(events)) {
    if (startsTurn(event)) {
      turn = [];
      reply = [];
      for (const { index, event: done, title } of unreplied)
        rows[index] = row(done, 'Marked done', title);
      unreplied = [];
    } else turn.push(event);
    turnKey = turnOf(event);
    switch (event.type) {
      case 'agent.progress': {
        rows.push(
          event.finished
            ? row(event, 'Finished', event.summary, 'green', false, true)
            : row(event, 'Progress', event.summary, 'cyan', false, true),
        );
        break;
      }
      case 'agent.message':
        // Free-form conversation is available in Live; progress has its own explicit ingress.
        if (event.text.trim()) reply.push(event.text);
        break;
      case 'run.state': {
        const state = event.state;
        if (state.kind === 'running') {
          tools.clear();
          files.clear();
          turnAt = event.at;
          ended = false;
          requestRow = rows.length;
          rows.push(row(event, 'Turn started', '', 'blue'));
        } else if (state.kind === 'idle') {
          if (!ended) rows.push(row(event, 'Ready for prompt'));
        } else if (state.kind === 'failed' || state.kind === 'interrupted') {
          rows.push(
            row(
              event,
              state.kind === 'failed' ? 'Run failed' : 'Run interrupted',
              preview(state.reason),
              'red',
            ),
          );
        } else {
          const labels = {
            starting: 'Starting agent',
            'authentication-required': 'Sign-in required',
            cancelling: 'Stopping agent',
            cancelled: 'Run cancelled',
            closed: 'Run ended',
          };
          const color =
            state.kind === 'starting'
              ? 'blue'
              : state.kind === 'authentication-required'
                ? 'yellow'
                : 'white';
          rows.push(row(event, labels[state.kind], '', color));
        }
        break;
      }
      case 'turn.start': {
        const entry = row(event, 'Request', preview(event.text), 'cyan');
        if (requestRow !== undefined) rows[requestRow] = entry;
        else {
          tools.clear();
          files.clear();
          turnAt = event.at;
          rows.push(entry);
        }
        ended = false;
        requestRow = undefined;
        break;
      }
      case 'tool': {
        const activity = tools.get(event.id) ?? {
          row: undefined,
          first: event,
          title: event.title,
          status: event.status,
        };
        // Old daemons replaced missing patch fields with these fallback values.
        if (event.title && event.title !== 'Tool update')
          activity.title = event.title;
        if (event.status !== 'unknown') activity.status = event.status;
        tools.set(event.id, activity);
        // Routine tool activity belongs in Live. Keep failures visible without
        // mistaking an agent-run command for a Workbench Check.
        if (activity.status === 'failed' || activity.row !== undefined) {
          const duration = elapsed(activity.first.at, event.at);
          activity.row ??= rows.length;
          rows[activity.row] = row(
            activity.first,
            'Tool ' + activity.status,
            `${preview(activity.title)}${duration ? ` · ${duration}` : ''} · :live`,
            activity.status === 'failed' ? 'red' : 'gray',
            true,
          );
        }
        break;
      }
      case 'attention': {
        const decision = decisions.get(event.id);
        if (decision?.kind === 'agent-request') {
          const labels: Readonly<Record<string, string>> = {
            pending:
              decision.request === 'question'
                ? 'Question for you'
                : 'Needs you',
            done: 'Marked done',
            stale: 'Request expired',
          };
          const title = preview(decision.title);
          if (event.status === 'done')
            unreplied.push({ index: rows.length, event, title });
          rows.push({
            ...row(
              event,
              labels[event.status] ?? event.status,
              // Done tells the agent nothing; it waits for the next prompt.
              event.status === 'done' ? `reply to continue · ${title}` : title,
              event.status === 'stale' ? 'gray' : 'yellow',
              event.status === 'pending',
            ),
            notes:
              event.status === 'pending'
                ? decision.steps.map(
                    (step, index) => `${index + 1}. ${terminalText(step)}`,
                  )
                : [],
          });
          break;
        }
        if (!decision) {
          rows.push(
            row(
              event,
              'Approval',
              event.status,
              event.status === 'delivered'
                ? 'green'
                : event.status === 'stale'
                  ? 'gray'
                  : 'yellow',
            ),
          );
          break;
        }
        const choice =
          'choiceId' in decision
            ? decision.choices.find((choice) => choice.id === decision.choiceId)
                ?.label
            : undefined;
        const labels: Readonly<Record<string, string>> = {
          pending: 'Approval requested',
          accepted: 'Reply accepted',
          delivered: 'Reply delivered',
          stale: 'Approval expired',
        };
        rows.push(
          row(
            event,
            labels[event.status] ?? event.status,
            [
              ...(['accepted', 'delivered'].includes(event.status) && choice
                ? [preview(choice)]
                : []),
              preview(decision.title),
            ].join(' · '),
            event.status === 'delivered'
              ? 'green'
              : event.status === 'stale'
                ? 'gray'
                : 'yellow',
          ),
        );
        break;
      }
      case 'diff':
        files.add(event.path);
        break;
      case 'turn.end': {
        const details = [elapsed(turnAt, event.at)];
        if (tools.size)
          details.push(`${tools.size} tool${tools.size === 1 ? '' : 's'}`);
        if (files.size)
          details.push(
            `${files.size} file${files.size === 1 ? '' : 's'} changed`,
          );
        if (event.reason !== 'end_turn') details.push('stop: ' + event.reason);
        // The turn's result, as its agent declared it.
        const outcome = outcomeOf(turn, attention);
        // Whatever the agent declared, its reply may hold the answer.
        const text = reply.join('\n\n');
        // Its words without Markdown markers, which a dim line cannot show.
        const ending = reply.length ? inlineText(lastParagraph(text)) : '';
        if (ending) {
          const count = text.split('\n').length;
          details.push(`Space reply · ${count} line${count === 1 ? '' : 's'}`);
        }
        const stats = details.filter(Boolean).join(' · ');
        rows.push({
          ...(outcome.kind === 'blocked' || outcome.kind === 'question'
            ? row(
                event,
                outcome.kind === 'blocked' ? 'Blocked' : 'Question',
                [preview(outcome.title), stats].filter(Boolean).join(' · '),
                'yellow',
              )
            : outcome.kind === 'finished'
              ? row(event, 'Finished', stats, 'green')
              : row(event, 'Turn ended', stats)),
          notes: ending ? [ending] : [],
        });
        reply = [];
        ended = true;
        requestRow = undefined;
        break;
      }
      case 'check.start':
        rows.push(
          row(
            event,
            'Checks started',
            `${event.command} · ${event.candidate.slice(0, 7)}`,
            'cyan',
          ),
        );
        break;
      case 'check.end': {
        const ended = checkEnded(event);
        rows.push(row(event, ended.label, ended.detail, ended.color));
        break;
      }
      case 'diagnostic':
      case 'capabilities':
        // Transport/environment diagnostics remain available in Live and the header.
        break;
    }
  }
  return rows;
}

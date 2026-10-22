import type { AttentionItem } from '../attention/index.js';
import type { RunEvent } from '../execution/index.js';
import { terminalText } from './tui-input.js';

export type TimelineEntry = Readonly<{
  sequence: number;
  at: string;
  text: string;
  label: string;
  detail: string;
  color: string;
  detailBold: boolean;
  wrap: boolean;
}>;
type ToolActivity = {
  row: number;
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
  // Whether the agent wrote any reply this turn; its text stays in Live.
  let replied = false;
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
    };
  };
  for (const event of readableEvents(events)) {
    switch (event.type) {
      case 'agent.progress': {
        rows.push(row(event, 'Progress', event.summary, 'cyan', false, true));
        break;
      }
      case 'agent.message':
        // Free-form conversation is available in Live; progress has its own explicit ingress.
        if (event.text.trim()) replied = true;
        break;
      case 'run.state': {
        const state = event.state;
        if (state.kind === 'running') {
          tools.clear();
          files.clear();
          turnAt = event.at;
          ended = false;
          replied = false;
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
          replied = false;
          rows.push(entry);
        }
        ended = false;
        requestRow = undefined;
        break;
      }
      case 'tool': {
        const activity = tools.get(event.id) ?? {
          row: rows.length,
          first: event,
          title: event.title,
          status: event.status,
        };
        // Old daemons replaced missing patch fields with these fallback values.
        if (event.title && event.title !== 'Tool update')
          activity.title = event.title;
        if (event.status !== 'unknown') activity.status = event.status;
        tools.set(event.id, activity);
        const duration = ['completed', 'failed'].includes(activity.status)
          ? elapsed(activity.first.at, event.at)
          : undefined;
        rows[activity.row] = row(
          activity.first,
          activity.status === 'in_progress'
            ? 'Tool running'
            : activity.status === 'unknown'
              ? 'Tool update'
              : 'Tool ' + activity.status,
          `${preview(activity.title)}${duration ? ` · ${duration}` : ''}`,
          activity.status === 'failed'
            ? 'red'
            : activity.status === 'completed'
              ? 'green'
              : activity.status === 'in_progress'
                ? 'blue'
                : 'gray',
          true,
        );
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
          rows.push(
            row(
              event,
              labels[event.status] ?? event.status,
              preview(decision.title),
              event.status === 'pending'
                ? 'yellow'
                : event.status === 'done'
                  ? 'green'
                  : 'gray',
              event.status === 'pending',
            ),
          );
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
        if (!files.has(event.path))
          rows.push(row(event, 'File changed', event.path, 'white', true));
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
        if (replied) details.push('replied · 1 Live');
        replied = false;
        rows.push(
          row(event, 'Turn finished', details.filter(Boolean).join(' · ')),
        );
        ended = true;
        requestRow = undefined;
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

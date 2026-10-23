import type { AttentionId } from '../attention/index.js';
import type { RunId } from '../execution/index.js';
import type { WorkbenchState } from './workbench-protocol.js';
import { terminalText } from './tui-input.js';
import { checkEnded } from './tui-timeline.js';
import { trackedWork } from './workbench-work.js';

/** A background Run's change worth telling the person about; lower rank is more urgent. */
export type Notice = Readonly<{
  runId: RunId;
  rank: number;
  text: string;
  color: string;
  /** Shown only while this request is still pending. */
  attentionId?: AttentionId;
  /** Shown only while the Run is still idle after this turn. */
  turn?: true;
}>;

const lastSequence = (state: WorkbenchState) =>
  Math.max(0, ...state.events.map((event) => event.sequence));

/** Each Run's latest turn end still in the TUI's event window. */
export function turnEnds(state: WorkbenchState): ReadonlyMap<RunId, number> {
  const ends = new Map<RunId, number>();
  for (const event of state.events)
    if (event.type === 'turn.end')
      ends.set(
        event.runId,
        Math.max(event.sequence, ends.get(event.runId) ?? 0),
      );
  return ends;
}

/**
 * Idle Runs whose latest turn ended after this TUI last showed them. Seen state
 * belongs to this client only; turns at or before `floor` (those that ended
 * before it connected) count as seen.
 */
export function unreadRuns(
  state: WorkbenchState,
  seen: Readonly<Record<string, number>>,
  floor: number,
  selectedId: RunId | null,
): ReadonlySet<RunId> {
  const unread = new Set<RunId>();
  for (const [runId, sequence] of turnEnds(state))
    if (
      runId !== selectedId &&
      sequence > Math.max(floor, seen[runId] ?? 0) &&
      state.runs.find((run) => run.id === runId)?.state.kind === 'idle'
    )
      unread.add(runId);
  return unread;
}

function runName(state: WorkbenchState, runId: RunId) {
  const index = state.runs.findIndex((run) => run.id === runId);
  const run = state.runs[index];
  const title = trackedWork(state, runId)?.task.title ?? run?.label ?? '';
  return `Run ${index + 1} · ${terminalText(title)}`;
}

/**
 * What changed between two polls of one server instance: new pending requests,
 * finished turns, failures and check results, at most one per Run.
 */
export function notices(
  previous: WorkbenchState,
  next: WorkbenchState,
): readonly Notice[] {
  const found: Notice[] = [];
  const known = new Set(
    previous.attention
      .filter((item) => item.status === 'pending')
      .map((item) => item.id),
  );
  for (const item of next.attention)
    if (item.status === 'pending' && !known.has(item.id))
      found.push({
        runId: item.runId,
        rank: item.kind === 'permission' ? 0 : 1,
        text:
          item.kind === 'permission'
            ? 'needs approval'
            : `asks: ${terminalText(item.title)}`,
        color: 'yellow',
        attentionId: item.id,
      });
  const since = lastSequence(previous);
  for (const event of next.events) {
    if (event.sequence <= since) continue;
    const { runId } = event;
    if (event.type === 'run.state') {
      if (event.state.kind === 'authentication-required')
        found.push({ runId, rank: 2, text: 'needs sign-in', color: 'yellow' });
      else if (
        event.state.kind === 'failed' ||
        event.state.kind === 'interrupted'
      )
        found.push({ runId, rank: 3, text: event.state.kind, color: 'red' });
    } else if (event.type === 'check.end') {
      const ended = checkEnded(event);
      found.push({
        runId,
        rank: 4,
        text: ended.label.toLowerCase(),
        color: ended.color,
      });
    } else if (event.type === 'turn.end')
      found.push({
        runId,
        rank: 5,
        text: 'finished a turn',
        color: 'magenta',
        turn: true,
      });
  }
  const urgent = new Map<RunId, Notice>();
  for (const notice of found) {
    const current = urgent.get(notice.runId);
    if (!current || notice.rank < current.rank)
      urgent.set(notice.runId, notice);
  }
  return [...urgent.values()].map((notice) => ({
    ...notice,
    text: `${runName(next, notice.runId)} ${notice.text}`,
  }));
}

/** Whether a delayed notice still tells the person something new. */
export function stillNews(
  state: WorkbenchState,
  notice: Notice,
  selectedId: RunId | null,
): boolean {
  if (notice.runId === selectedId) return false;
  if (notice.attentionId)
    return state.attention.some(
      (item) => item.id === notice.attentionId && item.status === 'pending',
    );
  const run = state.runs.find((item) => item.id === notice.runId);
  return notice.turn ? run?.state.kind === 'idle' : run !== undefined;
}

/** The notice line: the most urgent one, how many more, and `w` when it reaches them. */
export function noticeText(shown: readonly Notice[]): string {
  const sorted = [...shown].sort((a, b) => a.rank - b.rank);
  const first = sorted[0];
  if (!first) return '';
  const more = sorted.length > 1 ? ` · +${sorted.length - 1} more` : '';
  const jump = first.attentionId || first.turn ? ' · w jump' : '';
  return `${first.text}${more}${jump}`;
}

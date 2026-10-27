import { basename } from 'node:path';
import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { Backdrop, Box, Text } from './tui-text.js';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type { AttentionItem } from '../attention/index.js';
import type { ChangeMap } from '../delivery/index.js';
import { NO_WORKTREE } from './tui-diff.js';
import type { WorktreeDiff } from './tui-diff.js';
import type {
  RunEvent,
  RunId,
  RunSnapshot,
  RunState,
} from '../execution/index.js';
import type {
  NextAction,
  ProjectWork,
  Stage,
  WorkPlan,
} from '../work/index.js';
import type { WorkbenchState } from './workbench-protocol.js';
import { terminalText } from './tui-input.js';
import {
  checkEnded,
  readableEvents,
  timelineEntries,
  turnReplies,
} from './tui-timeline.js';
import type { TimelineEntry } from './tui-timeline.js';
import { stageLabels, trackedWork } from './workbench-work.js';
import { latestOutcomes } from './tui-outcome.js';
import type { TurnOutcome } from './tui-outcome.js';
import { markdownLines, plainText } from './tui-markdown.js';
import type { Span } from './tui-markdown.js';

export type View = 'live' | 'diff' | 'timeline';
export type Filter = 'active' | 'inbox';
export type Line = {
  text: string;
  color?: string;
  bold?: boolean;
  timeline?: { time: string; entry: TimelineEntry };
  /** The Timeline row this line belongs to, by index. */
  row?: number;
  /** Styled runs of a rendered Markdown reply, in place of `text`. */
  spans?: readonly Span[];
};
const views: readonly View[] = ['live', 'diff', 'timeline'];
const NO_UNREAD: ReadonlySet<RunId> = new Set();
const tone = (color: string | undefined) => (color ? { color } : {});
const workflowLabels = {
  clarification: 'Requirement clarification',
  development: 'Development',
  'agent-review': 'Agent Review',
  'human-review': 'Human Review',
} satisfies Record<Stage, string>;
const states = {
  starting: 'Starting',
  idle: 'Idle',
  running: 'Running',
  cancelling: 'Cancelling',
  cancelled: 'Cancelled',
  closed: 'Ended',
  failed: 'Failed',
  interrupted: 'Interrupted',
  'authentication-required': 'Sign-in required',
} satisfies Record<RunState['kind'], string>;
const ended = new Set<RunState['kind']>([
  'cancelled',
  'closed',
  'failed',
  'interrupted',
]);
export const workspaceNeedsAction = (run: RunSnapshot | undefined) =>
  run?.worktree?.status.kind === 'commit-required' ||
  run?.worktree?.status.kind === 'retained';
type RunStatus = Readonly<{
  label: string;
  /** The left column's label; still words, so the state reads without color. */
  short: string;
  /** herdr's glyphs, one column each: ◉ needs you, ✕ failed, ● active, ○ idle; the label stays readable. */
  icon: string;
  color: string | undefined;
  /** Lower is more urgent; a project header shows its most urgent Run's icon. */
  rank: number;
}>;
/**
 * A roster row's state. Each color means one thing across the TUI: yellow
 * needs you, red broke, green the agent reports finished (never verified),
 * blue working, magenta new to you, gray quiet. `unread` is this client's view
 * of a turn; `outcome` is what the agent declared when its latest turn ended.
 */
/**
 * Where a Run's Task flow stands, from work's flows, reviews and next
 * actions. `review` is Human Review; `approved` says an Agent Review of the
 * current code approved it.
 */
type FlowView = Readonly<{
  step: 'verifying' | 'reviewing' | 'fixing' | 'stopped' | 'review';
  attempts: number;
  reason: string;
  reviewer?: RunId | undefined;
  cause?: 'checks' | 'review' | undefined;
  approved?: boolean | undefined;
}>;
const NO_FLOWS: ReadonlyMap<RunId, FlowView> = new Map();
export function flowViews(state: WorkbenchState): ReadonlyMap<RunId, FlowView> {
  const views = new Map<RunId, FlowView>();
  for (const flow of state.flows ?? []) views.set(flow.runId, flow);
  for (const project of state.overview ?? [])
    for (const run of project.runs)
      if (run.next === 'accept')
        views.set(run.runId, {
          step: 'review',
          attempts: 0,
          reason: '',
          approved: state.reviews?.some(
            (item) => item.runId === run.runId && item.status === 'approved',
          ),
        });
  return views;
}
function runStatus(
  run: RunSnapshot,
  pending: readonly AttentionItem[],
  unread: boolean,
  outcome?: TurnOutcome,
  flow?: FlowView,
): RunStatus {
  const own = pending.filter((item) => item.runId === run.id);
  const count = own.length > 1 ? ` (${own.length})` : '';
  // Approvals block the agent; agent requests block it until the person acts or answers.
  if (own.some((item) => item.kind === 'permission'))
    return {
      label: `Awaiting approval (${own.length})`,
      short: `Approve (${own.length})`,
      icon: '◉',
      color: 'yellow',
      rank: 0,
    };
  if (own.length)
    return own.every(
      (item) => item.kind === 'agent-request' && item.request === 'question',
    )
      ? {
          label: `Question${count}`,
          short: `Question${count}`,
          icon: '◉',
          color: 'yellow',
          rank: 0,
        }
      : {
          label: `Blocked${count}`,
          short: `Blocked${count}`,
          icon: '◉',
          color: 'yellow',
          rank: 0,
        };
  if (workspaceNeedsAction(run))
    return run.worktree?.status.kind === 'commit-required'
      ? {
          label: 'Commit required',
          short: 'Commit',
          icon: '◉',
          color: 'yellow',
          rank: 0,
        }
      : {
          label: 'Worktree retained',
          short: 'Worktree',
          icon: '◉',
          color: 'yellow',
          rank: 0,
        };
  if (run.state.kind === 'idle' && flow?.step === 'stopped')
    return flow.cause === 'review'
      ? {
          label: `Agent Review · ${flow.reason}`,
          short: 'Agent review',
          icon: '◉',
          color: 'yellow',
          rank: 0,
        }
      : {
          label: `Checks · ${flow.reason}`,
          short: 'Checks',
          icon: '◉',
          color: 'yellow',
          rank: 0,
        };
  if (run.state.kind === 'idle' && flow?.step === 'review')
    return {
      label: `Human Review · checks passed${flow.approved ? ' · review approved' : ''}`,
      short: 'Review',
      icon: '◉',
      color: 'yellow',
      rank: 0,
    };
  if (run.state.kind === 'idle' && flow?.step === 'verifying')
    return {
      label: 'Verifying',
      short: 'Verifying',
      icon: '●',
      color: 'blue',
      rank: 3,
    };
  if (run.state.kind === 'idle' && flow?.step === 'reviewing')
    return {
      label: 'Agent Review',
      short: 'Reviewing',
      icon: '●',
      color: 'blue',
      rank: 3,
    };
  if (run.state.kind === 'running' && flow?.step === 'fixing')
    return {
      label: `Fixing ${flow.cause === 'review' ? 'review findings' : 'failed checks'} (${flow.attempts} of 2)`,
      short: 'Fixing',
      icon: '●',
      color: 'blue',
      rank: 3,
    };
  const label = states[run.state.kind];
  const short = label;
  switch (run.state.kind) {
    case 'authentication-required':
      return { label, short: 'Sign in', icon: '◉', color: 'yellow', rank: 0 };
    case 'failed':
    case 'interrupted':
      return { label, short, icon: '✕', color: 'red', rank: 1 };
    case 'idle':
      // Done tells the agent nothing: it stays blocked until the next prompt.
      if (
        (outcome?.kind === 'blocked' || outcome?.kind === 'question') &&
        outcome.done
      )
        return {
          label: 'Blocked · reply to continue',
          short: 'Blocked',
          icon: '◉',
          color: 'yellow',
          rank: 0,
        };
      if (outcome?.kind === 'finished')
        return {
          label: 'Finished',
          short: 'Finished',
          icon: unread ? '●' : '○',
          color: 'green',
          rank: unread ? 2 : 4,
        };
      return unread
        ? {
            label: 'Unread',
            short: 'Unread',
            icon: '●',
            color: 'magenta',
            rank: 2,
          }
        : { label, short, icon: '○', color: 'gray', rank: 4 };
    case 'starting':
    case 'running':
      return { label, short, icon: '●', color: 'blue', rank: 3 };
    case 'cancelling':
      return { label, short, icon: '●', color: undefined, rank: 3 };
    case 'cancelled':
    case 'closed':
      return { label, short, icon: ' ', color: undefined, rank: 5 };
  }
}
const shownBy =
  (state: WorkbenchState, filter: Filter) => (run: RunSnapshot) =>
    filter === 'inbox'
      ? state.attention.some(
          (item) => item.runId === run.id && item.status === 'pending',
        )
      : !ended.has(run.state.kind) || workspaceNeedsAction(run);
type RosterLine = Readonly<
  | { group: RosterGroup; run?: undefined }
  | { group?: RosterGroup; run: RunSnapshot }
>;
type RunNext = Readonly<{ runId: RunId; next: NextAction }>;
export type RosterGroup = Readonly<{
  /** Absent for Runs the overview does not place in a project. */
  project?: ProjectWork | undefined;
  next?: RunNext | null;
  runs: readonly RunSnapshot[];
}>;
/** Older daemons without an overview: work's project ownership in launch order. */
function launchOrder(state: WorkbenchState) {
  const position = (runId: RunId) =>
    state.runs.findIndex((run) => run.id === runId);
  const first = (runIds: readonly RunId[]) =>
    Math.min(Infinity, ...runIds.map(position).filter((index) => index >= 0));
  return (state.projects ?? [])
    .map((project) => ({
      projectId: project.id,
      next: null,
      runs: [...project.runIds]
        .sort((a, b) => position(a) - position(b))
        .map((runId) => ({ runId })),
    }))
    .sort(
      (a, b) =>
        first(a.runs.map(({ runId }) => runId)) -
        first(b.runs.map(({ runId }) => runId)),
    );
}
/**
 * Visible Runs grouped by project in the daemon's overview order (work ranks
 * them). Daemons from before the overview group in launch order without next
 * actions; those without projects keep a flat launch-order list.
 */
export function rosterGroups(
  state: WorkbenchState,
  filter: Filter,
): readonly RosterGroup[] | null {
  const entries =
    state.overview ?? (state.projects ? launchOrder(state) : null);
  if (!entries) return null;
  const shown = shownBy(state, filter);
  const byId = new Map(state.runs.map((run) => [run.id, run]));
  const placed = new Set<RunId>();
  const groups: RosterGroup[] = entries.map((entry) => ({
    project: state.projects?.find((project) => project.id === entry.projectId),
    next: entry.next,
    runs: entry.runs.flatMap(({ runId }) => {
      const run = byId.get(runId);
      if (!run || !shown(run)) return [];
      placed.add(runId);
      return [run];
    }),
  }));
  groups.push({
    runs: state.runs.filter((run) => !placed.has(run.id) && shown(run)),
  });
  return groups.filter((group) => group.runs.length);
}
export function visibleRuns(
  state: WorkbenchState,
  filter: Filter,
): readonly RunSnapshot[] {
  const groups = rosterGroups(state, filter);
  return groups
    ? groups.flatMap((group) => group.runs)
    : state.runs.filter(shownBy(state, filter));
}
function nextText(
  state: WorkbenchState,
  entry: RunNext | null | undefined,
): string {
  if (!entry) return '';
  const id = entry.runId;
  const run = `Run ${state.runs.findIndex((item) => item.id === id) + 1}`;
  switch (entry.next) {
    case 'approve':
      return `next: approve ${run}`;
    case 'respond': {
      const request = state.attention.find(
        (item) =>
          item.runId === id &&
          item.status === 'pending' &&
          item.kind === 'agent-request',
      );
      return `next: ${run} · ${terminalText(request?.title ?? 'needs you')}`;
    }
    case 'sign-in':
      return `next: sign in ${run}`;
    case 'checks':
      return `next: ${run} checks need you`;
    case 'accept': {
      const task = trackedWork(state, id)?.task.title;
      return `next: review ${run}${task ? ` · ${terminalText(task)}` : ''}`;
    }
    case 'commit':
      return `next: commit ${run}`;
    case 'worktree':
      return `next: check ${run} worktree`;
    case 'prompt':
      return `next: prompt ${run}`;
    case 'working': {
      const progress = state.events
        .filter(
          (event) => event.runId === id && event.type === 'agent.progress',
        )
        .at(-1);
      return progress?.type === 'agent.progress'
        ? `${run} · ${terminalText(progress.summary)}`
        : `${run} working`;
    }
    case 'ended':
      return 'no action';
  }
}
/** One line naming the project, what to do next and its active Phase (cut first). */
function groupHeader(state: WorkbenchState, group: RosterGroup) {
  const plan =
    group.project?.work.kind === 'ready' ? group.project.work.plan : null;
  const phase = plan?.phases.findIndex(
    (phase) => phase.id === plan.activePhaseId,
  );
  const next = group.next?.next;
  return {
    name: group.project
      ? terminalText(basename(group.project.source))
      : 'Other Runs',
    phase:
      plan && phase !== undefined && phase >= 0
        ? ` · Phase ${phase + 1}/${plan.phases.length} ${terminalText(plan.phases[phase]?.title ?? '')}`
        : '',
    next: nextText(state, group.next),
    urgent:
      next !== undefined &&
      [
        'approve',
        'respond',
        'sign-in',
        'checks',
        'accept',
        'commit',
        'worktree',
      ].includes(next),
  };
}
function eventSummary(event: RunEvent): string {
  switch (event.type) {
    case 'run.state':
      return (
        states[event.state.kind] +
        ('reason' in event.state ? ' · ' + event.state.reason : '')
      );
    case 'agent.message':
      return event.text;
    case 'agent.progress':
      return (event.finished ? 'Finished · ' : 'Progress · ') + event.summary;
    case 'turn.start':
      return 'Request · ' + event.text;
    case 'tool':
      return `${event.title} · ${event.status}`;
    case 'attention':
      return `Approval · ${event.status}`;
    case 'diff':
      return `File changed · ${event.path}`;
    case 'turn.end':
      return `Turn ended · ${event.reason}`;
    case 'diagnostic':
      return event.message;
    case 'capabilities':
      return `ACP · ${event.capabilities.agent} ${event.capabilities.version}`;
    case 'check.start':
      return `Checks started · ${event.command} · ${event.candidate.slice(0, 7)}`;
    case 'check.end': {
      const ended = checkEnded(event);
      return `${ended.label} · ${ended.detail.replace(' · 1 Live', '')}`;
    }
  }
}
function eventColor(event: RunEvent): string | undefined {
  if (event.type === 'check.end') return checkEnded(event).color;
  return event.type === 'attention'
    ? 'yellow'
    : event.type === 'diagnostic' ||
        (event.type === 'tool' && event.status === 'failed')
      ? 'red'
      : undefined;
}
const DIFF_LINES = 4000;
/** The real worktree diff: every changed file, whether or not the agent reported it. */
function worktreeLines(
  map: ChangeMap,
  append: (text: string, color?: string) => void,
) {
  append(
    `Worktree vs ${map.base.slice(0, 7)} · ${map.totals.files} file${map.totals.files === 1 ? '' : 's'} · +${map.totals.plus} −${map.totals.minus} · m Change map`,
    'gray',
  );
  if (map.truncated.length)
    append(
      `Some changes left out (${map.truncated.join(', ')}) · m Change map lists every file`,
      'gray',
    );
  if (!map.files.length) append('No changes in the worktree yet');
  let shown = 0;
  for (const file of map.files) {
    if (shown >= DIFF_LINES) {
      append(`… more files · m Change map shows the rest`, 'gray');
      return;
    }
    const name = file.previousPath
      ? `${file.previousPath} → ${file.path}`
      : file.path;
    append('');
    append(
      `${file.status === 'modified' ? '' : file.status + ' '}${name} · +${file.plus} −${file.minus}`,
      'white',
    );
    if (file.binary) append('Binary file', 'gray');
    else if (file.diff === null)
      append(
        'Diff left out: larger than the size limit · m Change map',
        'gray',
      );
    else
      for (const row of file.diff.replace(/\n$/, '').split('\n')) {
        if (++shown > DIFF_LINES) break;
        append(
          row,
          row.startsWith('@@')
            ? 'cyan'
            : row.startsWith('+')
              ? 'green'
              : row.startsWith('-')
                ? 'red'
                : undefined,
        );
      }
  }
}
function detailLines(
  events: readonly RunEvent[],
  runId: RunId | null,
  view: View,
  width: number,
  entries: readonly TimelineEntry[],
  worktree: WorktreeDiff = NO_WORKTREE,
): Line[] {
  const ownEvents = events.filter((event) => event.runId === runId);
  const selected = view === 'live' ? readableEvents(ownEvents) : ownEvents;
  const lines: Line[] = [];
  const append = (text: string, color?: string) => {
    for (const part of wrapAnsi(terminalText(text), width, {
      hard: true,
      trim: false,
    }).split('\n'))
      lines.push({ text: part, ...(color ? { color } : {}) });
  };
  if (view === 'diff' && worktree.kind === 'ready') {
    worktreeLines(worktree.map, append);
  } else if (view === 'diff' && worktree.kind === 'loading') {
    append('Reading worktree changes…', 'gray');
  } else if (view === 'diff') {
    // Without a readable worktree, only edits the agent reported are known.
    if (worktree.kind === 'unavailable')
      append(`Worktree diff unavailable · ${worktree.reason}`, 'gray');
    for (const event of selected) {
      if (event.type !== 'diff') continue;
      append('--- ' + event.path);
      for (const line of event.oldText.split('\n')) append('- ' + line, 'red');
      append('+++ ' + event.path);
      for (const line of event.newText.split('\n'))
        append('+ ' + line, 'green');
    }
  } else if (view === 'live') {
    for (const event of selected) {
      if (event.type === 'agent.message')
        for (const spans of markdownLines(event.text, width))
          lines.push({ text: plainText(spans), spans });
      else if (
        event.type === 'agent.progress' ||
        event.type === 'turn.start' ||
        event.type === 'tool' ||
        event.type === 'diagnostic' ||
        event.type === 'turn.end' ||
        event.type === 'check.start'
      )
        append(eventSummary(event), eventColor(event));
      else if (event.type === 'check.end') {
        // The check's own output, as the shell printed it.
        if (event.truncated) append('(earlier output dropped)', 'gray');
        for (const line of event.output.replace(/\n+$/, '').split('\n'))
          append(line);
        append(eventSummary(event), eventColor(event));
      }
    }
  } else {
    for (const [row, entry] of entries.entries()) {
      const date = new Date(entry.at);
      const time = Number.isNaN(date.getTime())
        ? '--:--:--'
        : date.toLocaleTimeString('en-GB', { hour12: false });
      // Every row wraps rather than cutting its detail; full output remains in Live.
      const prefix = `${time} ${entry.label} · `;
      const wrapped = wrapAnsi(prefix + entry.detail, Math.max(1, width - 2), {
        hard: true,
        trim: true,
      }).split('\n');
      for (const [index, part] of wrapped.entries())
        lines.push(
          index === 0
            ? {
                text: part,
                timeline: {
                  time,
                  entry: { ...entry, detail: part.slice(prefix.length) },
                },
                row,
              }
            : { text: '  ' + part, bold: entry.detailBold, row },
        );
      // Steps and reply endings sit indented beneath their row, dimmed; a
      // numbered step's wrapped lines hang under its text, not its number.
      for (const note of entry.notes) {
        const marker = /^\d+\. /.exec(note)?.[0] ?? '';
        const parts = wrapAnsi(
          note.slice(marker.length),
          Math.max(1, width - 6 - marker.length),
          { hard: true, trim: true },
        ).split('\n');
        for (const [index, part] of parts.entries())
          lines.push({
            text:
              '    ' +
              (index === 0 ? marker : ' '.repeat(marker.length)) +
              part,
            color: 'gray',
            row,
          });
      }
    }
  }
  return lines;
}
export type ScreenProps = {
  state: WorkbenchState;
  selectedId: RunId | null;
  filter: Filter;
  view: View;
  offset: number;
  request: AttentionItem | undefined;
  armed: boolean;
  connected: boolean;
  busy: boolean;
  actionFailed?: boolean;
  note: string;
  options: boolean;
  help: boolean;
  details: boolean;
  outline?: boolean;
  outlinePhase?: number;
  outlineOffset?: number;
  mode: 'normal' | 'reply' | 'command' | 'new-session';
  /** New Session form, given the most room its modal can offer. */
  composer?:
    | ((size: Readonly<{ width: number; maxHeight: number }>) => ReactNode)
    | undefined;
  columns: number;
  rows: number;
  input?: ReactNode;
  /** The selected Run's worktree diff for the Diff tab; reported edits when absent. */
  worktreeDiff?: WorktreeDiff;
  /** Runs with a finished turn this TUI has not shown yet. */
  unread?: ReadonlySet<RunId>;
  /** A background Run's latest change, shown beside the roster title. */
  notice?: Readonly<{ text: string; color: string }> | undefined;
  /** The selected Timeline row, by its entry's sequence; none follows the end. */
  cursor?: number | undefined;
  /** An open reply: its turn (as `turnReplies` keys it) and lines scrolled from the top. */
  peek?: Readonly<{ turn: number; offset: number }> | undefined;
  /** Receives the scroll actually shown, so keys never scroll past an end. */
  onViewport?:
    | ((viewport: Readonly<{ offset: number; peek: number }>) => void)
    | undefined;
};

/** The Timeline row a cursor names, or the last one before it if that row is gone. */
export function cursorRow(
  entries: readonly TimelineEntry[],
  cursor: number | undefined,
): number {
  if (cursor === undefined) return -1;
  const exact = entries.findIndex((entry) => entry.sequence === cursor);
  if (exact >= 0) return exact;
  return Math.max(
    0,
    entries.filter((entry) => entry.sequence < cursor).length - 1,
  );
}

/**
 * The first line on screen. `offset` counts lines from the end, 0 following
 * it; a selected Timeline row is kept in view.
 */
function scrollStart(
  lines: readonly Line[],
  rows: number,
  offset: number,
  row: number,
): number {
  const most = Math.max(0, lines.length - rows);
  let start = most - Math.min(offset, most);
  const first = row < 0 ? -1 : lines.findIndex((line) => line.row === row);
  if (first >= 0) {
    let last = first;
    while (lines[last + 1]?.row === row) last++;
    if (first < start) start = first;
    else if (last >= start + rows) start = Math.min(first, last - rows + 1);
  }
  return Math.max(0, Math.min(most, start));
}

/** The left column (agents, Workflow) from 80 columns; it widens to 44. */
function leftColumnWidth(columns: number) {
  return columns >= 80
    ? Math.min(44, Math.max(32, Math.floor(columns * 0.3)))
    : 0;
}

/** Keep the composer and the terminal viewport on the same column boundary. */
export function workbenchMainWidth(columns: number) {
  return columns - (columns >= 80 ? leftColumnWidth(columns) + 1 : 0);
}

function WorkflowPanel({
  plan,
  tracked,
  outline,
  phaseIndex,
  taskOffset,
  width,
  maxRows,
  compact = false,
}: {
  plan: WorkPlan;
  tracked: ReturnType<typeof trackedWork>;
  outline: boolean;
  phaseIndex: number;
  taskOffset: number;
  width: number;
  maxRows: number;
  compact?: boolean;
}) {
  if (!outline && tracked && maxRows < 11)
    return (
      <Box width={width} flexDirection="column" flexShrink={0}>
        <Text bold wrap="truncate-end">
          Workflow
          <Text dimColor>
            {' '}
            · Phase{' '}
            {plan.phases.findIndex((phase) => phase.id === tracked.phase.id) +
              1}
            /{plan.phases.length}
          </Text>
        </Text>
        <Text color="cyan" wrap="truncate-end">
          &gt; {workflowLabels[tracked.task.stage]}
        </Text>
        <Text dimColor>o Roadmap</Text>
      </Box>
    );
  const content: { text: string; current?: boolean; muted?: boolean }[] = [];
  let footer: string[];
  if (outline) {
    const index = Math.max(0, Math.min(phaseIndex, plan.phases.length - 1));
    const phase = plan.phases[index];
    if (!compact) content.push({ text: plan.title });
    const position = `Phase ${index + 1}/${plan.phases.length}`;
    const status = phase?.id === plan.activePhaseId ? 'Current' : 'Viewing';
    content.push({
      text: `${position} · ${status}${compact ? ' · ' + (phase?.title ?? '') : ''}`,
      muted: true,
    });
    if (!compact) content.push({ text: phase?.title ?? '' }, { text: ' ' });
    footer = compact
      ? ['[/] Phases · {/} Tasks · Esc close']
      : ['[/] Phases · {/} Tasks', ':track P.T · Esc close'];
    const taskRows = Math.max(
      1,
      Math.min(6, maxRows - 3 - content.length - footer.length),
    );
    const offset = Math.max(
      0,
      Math.min(taskOffset, Math.max(0, (phase?.tasks.length ?? 0) - taskRows)),
    );
    const tasks = phase?.tasks.slice(offset, offset + taskRows) ?? [];
    content.push(
      ...(tasks.length
        ? tasks.map((task, taskIndex) => ({
            text: `${task.id === tracked?.task.id ? '>' : ' '} ${index + 1}.${offset + taskIndex + 1} ${task.title} · ${stageLabels[task.stage]}`,
            current: task.id === tracked?.task.id,
          }))
        : [{ text: 'No Tasks in this Phase', muted: true }]),
    );
  } else if (tracked) {
    content.push(
      {
        text: `Phase ${plan.phases.findIndex((phase) => phase.id === tracked.phase.id) + 1}/${plan.phases.length}`,
        muted: true,
      },
      { text: tracked.phase.title },
      { text: 'Current step', muted: true },
      ...Object.entries(workflowLabels).map(([stage, label]) => ({
        text: `${tracked.task.stage === stage ? '>' : ' '} ${label}`,
        current: tracked.task.stage === stage,
      })),
    );
    if (maxRows >= 13) {
      content.splice(2, 0, { text: ' ' });
      content.push({ text: ' ' });
    }
    footer = ['o Roadmap'];
  } else return null;
  return (
    <Box width={width} flexDirection="column" flexShrink={0}>
      <Text bold wrap="truncate-end">
        {compact && tracked
          ? `Workflow · ${workflowLabels[tracked.task.stage]}`
          : outline
            ? 'Roadmap'
            : 'Workflow'}
      </Text>
      <Box
        borderStyle="single"
        flexDirection="column"
        paddingX={1}
        overflow="hidden"
      >
        {content
          .slice(0, Math.max(0, maxRows - 3 - footer.length))
          .map((line, index) => (
            <Text
              key={index}
              {...tone(line.current ? 'cyan' : undefined)}
              bold={line.current === true}
              dimColor={line.muted === true}
              wrap="truncate-end"
            >
              {terminalText(line.text)}
            </Text>
          ))}
        {footer.map((text) => (
          <Text key={text} dimColor wrap="truncate-end">
            {text}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/** Pure terminal projection; it cannot start Runs or answer permissions. */
/** One key and what it does: the key reads as a control, the action as plain text. */
function KeyAction({
  name,
  action,
  primary = false,
}: {
  name: string;
  action: string;
  primary?: boolean;
}) {
  return (
    <>
      <Text inverse bold {...(primary ? { color: 'cyan' } : {})}>
        {` ${name} `}
      </Text>
      <Text> {terminalText(action)}</Text>
    </>
  );
}

/**
 * The selected Run's pending decision above the footer: a badge and title, what
 * it is about (a command, a path or steps), its keys, then secondary keys.
 */
function DecisionPanel({
  request,
  position,
  total,
  armed,
  height,
  shownSteps,
  compact,
}: {
  request: AttentionItem;
  position: number;
  total: number;
  armed: boolean;
  height: number;
  shownSteps: number;
  /** Short terminals: the subject joins the title and the keys absorb the help row. */
  compact: boolean;
}) {
  const badge =
    request.kind === 'permission'
      ? 'APPROVAL'
      : request.request === 'question'
        ? 'QUESTION'
        : 'NEEDS YOU';
  const select = <Text dimColor>Tab selects the next request</Text>;
  let actions: ReactNode = select;
  let help: string;
  if (request.kind === 'permission') {
    const allow = request.choices.find(
      (choice) => choice.kind === 'allow-once',
    );
    const reject = request.choices.find(
      (choice) => choice.kind === 'reject-once',
    );
    const others = request.choices.length - Number(!!allow) - Number(!!reject);
    if (armed)
      actions =
        allow || reject ? (
          <>
            {allow && <KeyAction name="a" action={allow.label} primary />}
            {allow && reject && <Text>{'   '}</Text>}
            {reject && <KeyAction name="r" action={reject.label} />}
          </>
        ) : (
          <Text>Choose with :answer N · d lists the choices</Text>
        );
    help = `d full details${others > 0 ? ' · :answer N for other choices' : ''} · Tab next request`;
  } else {
    const reply = <KeyAction name="i" action="Reply" />;
    const done = (
      <KeyAction
        name="y"
        action="Done"
        primary={request.request === 'action'}
      />
    );
    if (armed)
      actions =
        request.request === 'question' ? (
          <>
            {reply}
            <Text>{'   '}</Text>
            {done}
          </>
        ) : (
          <>
            {done}
            <Text>{'   '}</Text>
            {reply}
          </>
        );
    const hidden = request.steps.length - shownSteps;
    help = `${hidden > 0 ? `d all ${request.steps.length} steps · ` : ''}Done does not notify the agent · Tab next`;
  }
  const subject =
    request.kind === 'permission' && request.subject
      ? terminalText(request.subject)
      : undefined;
  return (
    <Box flexDirection="column" height={height} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text inverse bold color="yellow">
          {` ${badge} ${position}/${total} `}
        </Text>
        <Text color="yellow"> {terminalText(request.title)}</Text>
        {compact && subject && <Text bold> · {subject}</Text>}
      </Text>
      {!compact && subject && (
        <Text bold wrap="truncate-middle">
          {'  '}
          {subject}
        </Text>
      )}
      {request.kind === 'agent-request' &&
        request.steps.slice(0, shownSteps).map((step, index) => (
          <Text key={index} wrap="truncate-end">
            {'  '}
            {index + 1}. {terminalText(step)}
          </Text>
        ))}
      <Text wrap="truncate-end">
        {actions}
        {compact && <Text dimColor> · {help}</Text>}
      </Text>
      {!compact && (
        <Text dimColor wrap="truncate-end">
          {help}
        </Text>
      )}
    </Box>
  );
}

/** The most urgent state among a project's Runs, for its header glyph. */
function mostUrgent(
  runs: readonly RunSnapshot[],
  pending: readonly AttentionItem[],
  unread: ReadonlySet<RunId>,
  outcomes: ReadonlyMap<RunId, TurnOutcome>,
  flows: ReadonlyMap<RunId, FlowView> = NO_FLOWS,
): RunStatus | undefined {
  return runs
    .map((run) =>
      runStatus(
        run,
        pending,
        unread.has(run.id),
        outcomes.get(run.id),
        flows.get(run.id),
      ),
    )
    .reduce<
      RunStatus | undefined
    >((most, item) => (most && most.rank <= item.rank ? most : item), undefined);
}

/** herdr's subtle row highlight; 16-colour terminals keep the cyan title and cursor. */
const SELECTED_BG = '#20242c';

/**
 * The left column in herdr's style: unframed, lowercase section titles, a
 * "spaces" list of projects (glyph of the most urgent Run, bold name, next
 * action beneath) above "agents", two lines per Run (title; state · provider)
 * under a project label once Runs come from more than one project.
 */
function SidebarList({
  state,
  groups,
  runs,
  selectedId,
  pending,
  unread,
  outcomes,
  flows,
  navigating,
  filter,
  empty,
  width,
  height,
}: {
  state: WorkbenchState;
  groups: readonly RosterGroup[] | null;
  runs: readonly RunSnapshot[];
  selectedId: RunId | null;
  pending: readonly AttentionItem[];
  unread: ReadonlySet<RunId>;
  outcomes: ReadonlyMap<RunId, TurnOutcome>;
  flows: ReadonlyMap<RunId, FlowView>;
  navigating: boolean;
  filter: Filter;
  empty: string;
  width: number;
  height: number;
}) {
  const spaces = groups?.filter((group) => group.project) ?? [];
  // Projects take at most half the column; agents scroll in the rest.
  const spaceCount = Math.min(
    spaces.length,
    Math.floor((Math.floor(height / 2) - 2) / 2),
  );
  const spaceRows = spaceCount > 0 ? 2 + spaceCount * 2 : 0;
  const budget = Math.max(1, height - spaceRows - 1);
  // Each project's Runs sit under its label, so projects read apart.
  const labelled = groups !== null && groups.length > 1;
  const items: readonly RosterLine[] = labelled
    ? groups.flatMap((group) => [
        { group },
        ...group.runs.map((run) => ({ group, run })),
      ])
    : runs.map((run) => ({ run }));
  const rowsOf = (item: RosterLine | undefined) => (item?.run ? 2 : 1);
  const index = Math.max(
    0,
    runs.findIndex((run) => run.id === selectedId),
  );
  const selectedItem = Math.max(
    0,
    items.findIndex((item) => item.run?.id === selectedId),
  );
  // Scroll only as far as the selected Run needs.
  const startFor = (room: number) => {
    let start = selectedItem;
    let used = rowsOf(items[start]);
    while (start > 0 && used + rowsOf(items[start - 1]) <= room)
      used += rowsOf(items[--start]);
    return start;
  };
  let start = startFor(budget);
  // A project scrolled out of view stays named on top.
  let pinned: RosterGroup | undefined;
  if (labelled && items[start]?.run) {
    start = startFor(budget - 1);
    if (items[start]?.run) pinned = items[start]?.group;
  }
  let room = budget - (pinned ? 1 : 0);
  const shown = items.slice(start).filter((item) => {
    room -= rowsOf(item);
    return room >= 0;
  });
  // A label whose Runs are all cut off would name nothing.
  while (shown.length > 1 && !shown.at(-1)?.run) shown.pop();
  const scrolled =
    items.reduce((total, item) => total + rowsOf(item), 0) > budget;
  const count = `${filter === 'inbox' ? 'inbox · ' : ''}${
    scrolled ? `${index + 1}/` : ''
  }${runs.length} run${runs.length === 1 ? '' : 's'}`;
  const label = (group: RosterGroup) => {
    const name = groupHeader(state, group).name;
    return (
      <Box key={`project:${group.project?.id ?? ''}`} height={1} flexShrink={0}>
        <Text color="gray" wrap="truncate-end">
          {name} {'─'.repeat(Math.max(0, width - stringWidth(name) - 1))}
        </Text>
      </Box>
    );
  };
  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      flexShrink={0}
      overflow="hidden"
    >
      {spaceRows > 0 && (
        <>
          <Box height={1} flexShrink={0} justifyContent="space-between">
            <Text bold color="gray">
              spaces
            </Text>
            <Text color="gray">
              {spaces.length > spaceCount
                ? `${spaceCount}/${spaces.length}`
                : ''}
            </Text>
          </Box>
          {spaces.slice(0, spaceCount).map((group) => {
            const header = groupHeader(state, group);
            const rollup = mostUrgent(
              group.runs,
              pending,
              unread,
              outcomes,
              flows,
            );
            return (
              <Box
                key={group.project?.id}
                height={2}
                flexDirection="column"
                flexShrink={0}
              >
                <Text wrap="truncate-end">
                  <Text {...tone(rollup?.color)}>{rollup?.icon ?? ' '}</Text>{' '}
                  <Text bold>{header.name}</Text>
                </Text>
                <Text
                  {...tone(header.urgent ? 'yellow' : 'gray')}
                  wrap="truncate-end"
                >
                  {'  '}
                  {header.next.replace(/^next: /, '')}
                </Text>
              </Box>
            );
          })}
          <Text color="gray">{'─'.repeat(width)}</Text>
        </>
      )}
      <Box height={1} flexShrink={0} justifyContent="space-between">
        <Text bold color={navigating ? 'cyan' : 'gray'}>
          agents
        </Text>
        <Text color="gray">{count}</Text>
      </Box>
      {runs.length === 0 ? (
        <Text dimColor>{empty}</Text>
      ) : (
        [...(pinned ? [{ group: pinned }] : []), ...shown].map((item) => {
          const run = item.run;
          if (!run) return item.group ? label(item.group) : null;
          const active = run.id === selectedId;
          const status = runStatus(
            run,
            pending,
            unread.has(run.id),
            outcomes.get(run.id),
            flows.get(run.id),
          );
          return (
            <Box
              key={run.id}
              height={2}
              flexDirection="column"
              flexShrink={0}
              {...(active ? { backgroundColor: SELECTED_BG } : {})}
            >
              <Text wrap="truncate-end">
                <Text {...tone(status.color)}>{status.icon}</Text>{' '}
                <Text bold {...tone(active ? 'cyan' : undefined)}>
                  {active ? '> ' : '  '}Run{' '}
                  {state.runs.findIndex((item) => item.id === run.id) + 1} ·{' '}
                  {terminalText(
                    trackedWork(state, run.id)?.task.title ?? run.label,
                  )}
                </Text>
              </Text>
              <Text wrap="truncate-end">
                {'    '}
                <Text {...tone(status.color)}>
                  {status.short.toLowerCase()}
                </Text>
                <Text color="gray"> · {run.provider}</Text>
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

// Inline code sits on a faint block, so it reads as code without a new hue.
const CODE_BG = '#2b303b';

/** Rendered Markdown runs; an empty line keeps its row. */
function Spans(props: { spans: readonly Span[] }) {
  if (!props.spans.length) return <> </>;
  return (
    <>
      {props.spans.map((span, index) => (
        <Text
          key={index}
          bold={span.bold === true}
          italic={span.italic === true}
          dimColor={span.dim === true}
          underline={span.underline === true}
          strikethrough={span.strike === true}
          {...(span.code ? { backgroundColor: CODE_BG } : {})}
        >
          {span.text}
        </Text>
      ))}
    </>
  );
}

/** A frame's lower border carrying a short hint, like `└─ 1–20 of 57 ─┘`. */
function FrameEdge(props: {
  width: number;
  round: boolean;
  color: string | undefined;
  hint: string;
}) {
  const [left, right] = props.round ? ['╰', '╯'] : ['└', '┘'];
  const room = Math.max(0, props.width - 6);
  const hint =
    stringWidth(props.hint) <= room
      ? props.hint
      : room > 1
        ? props.hint.slice(0, room - 1) + '…'
        : '';
  const rule = Math.max(
    0,
    props.width - 2 - (hint ? stringWidth(hint) + 3 : 0),
  );
  return (
    <Box height={1} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text {...tone(props.color)}>{hint ? left + '─ ' : left}</Text>
        <Text dimColor>{hint}</Text>
        <Text {...tone(props.color)}>
          {(hint ? ' ' : '') + '─'.repeat(rule) + right}
        </Text>
      </Text>
    </Box>
  );
}

export function WorkbenchScreen(props: ScreenProps) {
  const {
    state,
    selectedId,
    filter,
    view,
    request,
    connected,
    busy,
    note,
    columns,
    rows,
  } = props;
  const runs = visibleRuns(state, filter);
  const selected = state.runs.find((run) => run.id === selectedId);
  const workspaceAction = workspaceNeedsAction(selected);
  const provider = selected?.provider ?? state.launch?.provider ?? 'fixture';
  const environment =
    selected?.environment.kind ??
    state.launch?.kind ??
    'trusted-fixture-directory';
  const fixture = provider === 'fixture';
  const pending = state.attention.filter((item) => item.status === 'pending');
  const unread = props.unread ?? NO_UNREAD;
  const outcomes = useMemo(
    () => latestOutcomes(state.events, state.attention),
    [state.events, state.attention],
  );
  const flows = useMemo(() => flowViews(state), [state]);
  const ownPending = pending.filter((item) => item.runId === selectedId);
  const tracked = trackedWork(state, selectedId);
  const plan = state.work?.kind === 'ready' ? state.work.plan : null;
  const mainWidth = workbenchMainWidth(columns);
  const sidebar = mainWidth < columns;
  const sidebarWidth = columns - mainWidth - 1;
  const width = Math.max(1, mainWidth - 4);
  const worktreeDiff = props.worktreeDiff ?? NO_WORKTREE;
  const ownEvents = useMemo(
    () => state.events.filter((event) => event.runId === selectedId),
    [state.events, selectedId],
  );
  const entries = useMemo(
    () => timelineEntries(ownEvents, state.attention),
    [ownEvents, state.attention],
  );
  const lines = useMemo(
    () =>
      detailLines(state.events, selectedId, view, width, entries, worktreeDiff),
    [state.events, entries, selectedId, view, width, worktreeDiff],
  );
  const replies = useMemo(() => turnReplies(ownEvents), [ownEvents]);
  const peekTurn = props.peek && replies.get(props.peek.turn);
  const peekLines = useMemo(
    () => (peekTurn ? markdownLines(peekTurn.reply, width) : []),
    [peekTurn, width],
  );
  // The scroll shown goes back to the app after each render.
  const viewport = useRef<{ offset: number; peek: number } | undefined>(
    undefined,
  );
  viewport.current = undefined;
  useEffect(() => {
    if (viewport.current) props.onViewport?.(viewport.current);
  });
  if (columns < 60 || rows < 20) {
    return (
      <Box
        flexDirection="column"
        width={columns}
        height={rows}
        overflow="hidden"
      >
        <Text wrap="truncate-end">workbench · resize to 60×20</Text>
        {rows > 1 && (
          <Text wrap="truncate-end">
            Current {columns}×{rows} · q detaches; Runs continue
          </Text>
        )}
      </Box>
    );
  }
  // A one-row roster shows only the selected Run, without its project line.
  const compactRoster = props.outline && !sidebar;
  const groups = compactRoster ? null : rosterGroups(state, filter);
  const rosterLines: readonly RosterLine[] = groups
    ? groups.flatMap((group) => [
        { group },
        ...group.runs.map((run) => ({ group, run })),
      ])
    : runs.map((run) => ({ run }));
  const listed = rosterLines.length || 1;
  // The left column holds spaces and agents above the Workflow; a tracked
  // Task's four stages show when every Run keeps its two lines, an open
  // Roadmap takes half.
  const sideRows = rows - 3;
  const spaceCount = groups?.filter((group) => group.project).length ?? 0;
  const stagesRoom =
    sideRows -
    (spaceCount ? 2 + spaceCount * 2 : 0) -
    1 -
    (groups && groups.length > 1 ? groups.length : 0) -
    2 * Math.max(1, runs.length);
  const sideWorkflowRows =
    !sidebar || !plan
      ? 0
      : props.outline
        ? Math.min(14, Math.floor(sideRows / 2))
        : !tracked
          ? 0
          : stagesRoom >= 11
            ? Math.min(13, stagesRoom)
            : 3;
  const rosterRows = Math.max(
    1,
    Math.min(
      compactRoster ? 1 : groups ? 6 : 5,
      listed,
      Math.floor(rows / 6) + (groups ? 1 : 0),
    ),
  );
  // Rows outside the viewport: header, note, status bar and the viewport's
  // border, plus the Run title with tabs, or the stacked roster and tabs.
  const chrome = 5 + (sidebar ? 1 : rosterRows + 4);
  const selectedIndex = Math.max(
    0,
    runs.findIndex((run) => run.id === selectedId),
  );
  const selectedLine = Math.max(
    0,
    rosterLines.findIndex((line) => line.run?.id === selectedId),
  );
  const rosterStart = Math.max(
    0,
    Math.min(rosterLines.length - rosterRows, selectedLine - rosterRows + 1),
  );
  const shownLines = rosterLines.slice(rosterStart, rosterStart + rosterRows);
  // Keep a project named at the top when its header scrolls out of view.
  const top = shownLines[0];
  if (rosterRows > 1 && top?.run && top.group)
    shownLines[0] = { group: top.group };
  const disclosures: string[] = [];
  // An agent request shows its first steps inline; d lists every step.
  const shownSteps =
    request?.kind === 'agent-request'
      ? Math.min(request.steps.length, rows >= 24 ? 3 : 1)
      : 0;
  // Below 24 rows the decision keeps its former two-row footprint.
  const compactDecision = rows < 24;
  const decisionRows = !request
    ? 0
    : request.kind === 'agent-request'
      ? (compactDecision ? 2 : 3) + shownSteps
      : compactDecision
        ? 2
        : 3 + (request.subject ? 1 : 0);
  // New Session takes the detail viewport's place instead of adding rows.
  const form = props.mode === 'new-session' && props.composer !== undefined;
  const inputLabel =
    props.mode === 'reply'
      ? 'Reply · Enter send · Esc keep draft'
      : props.mode === 'command'
        ? 'Command · Enter run · Esc close'
        : '';
  // Below 24 rows the input drops its lower rule and keeps two rows, like the decision.
  const inputRows = !inputLabel ? 0 : compactDecision ? 2 : 3;
  // Keys move through the roster unless an input line has them.
  const navigating = props.mode === 'normal';
  const compactWorkflowRows =
    props.outline && plan && !sidebar
      ? Math.min(
          rows >= 24 ? 9 : 6,
          rows - rosterRows - decisionRows - inputRows - 10,
        )
      : 0;
  const extraCapacity = Math.max(
    0,
    rows - chrome - compactWorkflowRows - decisionRows - inputRows - 3,
  );
  // The input adapter opens one group at a time; decision details also take priority here.
  if (props.details && request?.kind === 'agent-request') {
    disclosures.push(
      ...request.steps.flatMap((step, index) =>
        wrapAnsi(`${index + 1}. ${terminalText(step)}`, width, {
          hard: true,
          trim: false,
        }).split('\n'),
      ),
      'y marks it done · the agent is not told · i reply',
    );
  } else if (props.details && request?.kind === 'permission') {
    disclosures.push(
      ...request.choices.map(
        (choice, index) =>
          `:answer ${index + 1} · ${choice.label} (${choice.kind})`,
      ),
    );
    disclosures.push(
      ...wrapAnsi(terminalText(request.detail), width, {
        hard: true,
        trim: false,
      })
        .split('\n')
        .slice(0, Math.max(1, Math.floor(rows / 5))),
    );
  } else if (
    props.options &&
    selected?.state.kind === 'authentication-required'
  )
    disclosures.push(
      ...selected.state.methods.map(
        (method) => `:auth ${method.id} · ${method.label}`,
      ),
    );
  else if (props.options)
    disclosures.push(
      state.work
        ? state.work.plan
          ? 'o Roadmap · :track P.T attach · :direct detach'
          : ':roadmap <title> enables optional planning'
        : '',
      ...(fixture
        ? [
            'i prompts: fix / question / reply:name / wait / crash',
            'two-permissions · x cancel · :active/:inbox',
          ]
        : [
            'Enter new prompt · a/r approval · x cancel',
            environment === 'local'
              ? selected?.worktree
                ? 'x stops, commits changes to its branch and removes the Run'
                : 'Local code copies are retained'
              : 'x cancel Run',
            selected?.worktree && state.features?.verify
              ? 'v verify on a clean copy · :check <command> sets it'
              : '',
          ]),
    );
  else if (props.help)
    disclosures.push(
      'j/k agent · w waiting/unread · Tab request · a/r allow/deny',
      'h/l or 1–3 views · ↑↓ lines, Timeline rows · Space reply',
      'Ctrl+U/D or PgUp/PgDn page · g/G top/end',
      'n new · Enter/i reply · Esc keep draft · s actions',
      ': command · q / Ctrl+C detach; Runs keep running',
      ':active all agents · :inbox pending approvals',
      'o Roadmap · :roadmap title · :track P.T · :direct',
      ':spec requirements · :confirm · :stage development',
      'Stopped worktree: c / :commit message saves all changes',
      'm / :map open the Run’s Change map in the browser',
      'v verify: freeze the Run’s code, run the project check on a clean copy',
      ':check <command> sets the check · :check shows it',
      'Human Review: :accept on passing checks · :changes <what to fix>',
    );
  // Bound every optional region to leave a readable timeline at the minimum size.
  const extras = disclosures.filter(Boolean).slice(0, extraCapacity);
  const logRows = Math.max(
    1,
    rows -
      chrome -
      extras.length -
      decisionRows -
      compactWorkflowRows -
      inputRows,
  );
  const selectedRow =
    view === 'timeline' ? cursorRow(entries, props.cursor) : -1;
  const start = scrollStart(lines, logRows, props.offset, selectedRow);
  const log = lines.slice(start, start + logRows);
  const offset = Math.max(0, lines.length - logRows - start);
  // An open reply keeps its request on the first row and scrolls beneath it.
  const peekRows = Math.max(1, logRows - 1);
  const peekStart = Math.max(
    0,
    Math.min(props.peek?.offset ?? 0, peekLines.length - peekRows),
  );
  viewport.current = { offset, peek: peekStart };
  const span = (first: number, shown: number, total: number) =>
    `${first + 1}–${first + shown} of ${total}`;
  // Where the view is and which keys move it, on the frame's lower edge.
  const frameHint = props.peek
    ? [
        peekLines.length > peekRows
          ? span(
              peekStart,
              Math.min(peekRows, peekLines.length - peekStart),
              peekLines.length,
            )
          : '',
        peekLines.length > peekRows ? '↑↓ scroll' : '',
        'Esc close',
      ]
    : view === 'timeline'
      ? [
          selectedRow >= 0
            ? `row ${selectedRow + 1} of ${entries.length}`
            : lines.length > logRows
              ? span(start, log.length, lines.length)
              : '',
          entries.length && selectedRow < 0 ? '↑↓ select' : '',
          [...replies.values()].some((turn) => turn.reply) ? 'Space reply' : '',
          selectedRow >= 0 ? 'G latest' : '',
        ]
      : lines.length > logRows
        ? [span(start, log.length, lines.length), '↑↓ scroll', 'g/G top/end']
        : [];
  const frameColor = props.peek ? 'cyan' : request ? 'yellow' : undefined;
  // New Session floats centered in front of the dimmed workspace.
  const modalWidth = Math.min(columns - 6, 96);
  const modalHeight = Math.min(rows - 4, 16);
  const empty = selected
    ? view === 'diff'
      ? 'No file changes yet'
      : view === 'timeline'
        ? 'No milestones yet · 1 Live for full output'
        : fixture
          ? 'Enter to prompt · s for fixture scenarios'
          : 'Enter to prompt when idle · s actions'
    : 'n new Run';
  const counts = ` · ${filter} · ${runs.length} run${runs.length === 1 ? '' : 's'}${
    rosterLines.length > rosterRows
      ? ` · ${selectedIndex + 1}/${runs.length}`
      : ''
  }`;
  const connection = !connected
    ? 'Disconnected · reconnecting'
    : busy
      ? 'Sending'
      : 'Connected';
  const isolation = fixture
    ? 'FIXTURE / no model'
    : environment === 'local'
      ? 'LOCAL / no OS isolation'
      : 'CONTAINER';
  const pendingCount = pending.length ? ` · ${pending.length} pending` : '';
  // A background notice takes the header's free space beside the left column,
  // or shares the stacked roster's title, whose counts give way whole.
  const noticeRoom = sidebar
    ? columns -
      stringWidth(`workbench · ${isolation} · ${connection}${pendingCount}`) -
      1
    : mainWidth - 'agents'.length - 1;
  const noticeWidth =
    props.notice && noticeRoom >= 12
      ? Math.min(stringWidth(props.notice.text), noticeRoom)
      : 0;
  const notice = props.notice && noticeWidth > 0 && (
    <Box width={noticeWidth} flexShrink={0}>
      <Text color={props.notice.color} wrap="truncate-end">
        {props.notice.text}
      </Text>
    </Box>
  );
  const rosterCounts =
    sidebar ||
    !noticeWidth ||
    'agents'.length + counts.length + 1 + noticeWidth <= mainWidth
      ? counts
      : '';
  const selectedStatus =
    selected &&
    runStatus(
      selected,
      pending,
      false,
      outcomes.get(selected.id),
      flows.get(selected.id),
    );
  // Typing to the selected Run: its title takes the focus color from the roster.
  const replying = props.mode === 'reply';
  const tabNames = views.map(
    (name, index) =>
      ` ${index + 1} ${name === 'live' ? 'Live' : name === 'diff' ? 'Diff' : 'Timeline'} `,
  );
  const paused =
    offset > 0 ? (mainWidth >= 70 ? ' · follow paused' : ' · paused') : '';
  const tabsText = tabNames.join('') + paused;
  const tabs = (
    <>
      {views.map((name, index) => (
        <Text
          key={name}
          {...tone(view === name ? 'cyan' : undefined)}
          bold={view === name}
        >
          {tabNames[index]}
        </Text>
      ))}
      <Text dimColor>{paused}</Text>
    </>
  );
  const roster = (
    <>
      <Box height={1} flexShrink={0} columnGap={1}>
        <Box flexGrow={1} flexBasis={0} minWidth={0}>
          <Text wrap="truncate-end">
            <Text {...tone(navigating ? 'cyan' : undefined)}>agents</Text>
            <Text dimColor>{rosterCounts}</Text>
          </Text>
        </Box>
        {!sidebar && notice}
      </Box>
      <Box
        borderStyle="single"
        {...(navigating ? { borderColor: 'cyan' } : {})}
        flexDirection="column"
        height={rosterRows + 2}
        flexShrink={0}
        paddingX={1}
      >
        {runs.length === 0 ? (
          <Text dimColor>{empty}</Text>
        ) : (
          shownLines.map((line) => {
            const run = line.run;
            if (!run) {
              const header = groupHeader(state, line.group);
              // Groups always hold a visible Run; the header shows the most urgent.
              const rollup = mostUrgent(
                line.group.runs,
                pending,
                unread,
                outcomes,
                flows,
              );
              return (
                <Box
                  key={`project-${line.group.project?.id ?? 'other'}`}
                  height={1}
                  flexShrink={0}
                >
                  <Text wrap="truncate-end">
                    <Text {...tone(rollup?.color)}>{rollup?.icon ?? ' '} </Text>
                    <Text bold>{header.name}</Text>
                    <Text
                      {...tone(header.urgent ? 'yellow' : undefined)}
                      dimColor={!header.urgent}
                    >
                      {header.next ? ` · ${header.next}` : ''}
                    </Text>
                    <Text dimColor>{header.phase}</Text>
                  </Text>
                </Box>
              );
            }
            const active = run.id === selectedId;
            const status = runStatus(
              run,
              pending,
              unread.has(run.id),
              outcomes.get(run.id),
              flows.get(run.id),
            );
            // The left column is narrow; the Run title on the right spells it out.
            const label = sidebar ? status.short : status.label;
            return (
              <Box key={run.id} height={1} flexShrink={0} columnGap={1}>
                <Box width={1} flexShrink={0}>
                  <Text {...tone(status.color)}>{status.icon}</Text>
                </Box>
                <Box flexGrow={1} flexBasis={0} minWidth={0}>
                  <Text
                    {...tone(active ? 'cyan' : undefined)}
                    inverse={active && navigating}
                    wrap="truncate-end"
                  >
                    {active ? '> ' : '  '}Run{' '}
                    {state.runs.findIndex((item) => item.id === run.id) + 1} ·{' '}
                    {terminalText(
                      trackedWork(state, run.id)?.task.title ?? run.label,
                    )}
                  </Text>
                </Box>
                <Box width={label.length} flexShrink={0}>
                  <Text {...tone(status.color)} wrap="truncate-end">
                    {label}
                  </Text>
                </Box>
              </Box>
            );
          })
        )}
      </Box>
    </>
  );
  return (
    <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
      <Backdrop.Provider value={form}>
        <Box height={1} flexShrink={0} justifyContent="space-between">
          <Box flexShrink={0}>
            <Text bold>workbench</Text>
            <Text> · {isolation} · </Text>
            <Text color={connected ? 'cyan' : 'yellow'}>{connection}</Text>
            <Text color="yellow">{pendingCount}</Text>
          </Box>
          {sidebar && notice}
        </Box>
        <Box height={rows - 3} flexShrink={0} columnGap={sidebar ? 1 : 0}>
          {/* Agents and Workflow sit on the left like an editor's sidebar;
              the selected Run fills the right. */}
          {sidebar && (
            <Box width={sidebarWidth} flexDirection="column" flexShrink={0}>
              <SidebarList
                state={state}
                groups={groups}
                runs={runs}
                selectedId={selectedId}
                pending={pending}
                unread={unread}
                outcomes={outcomes}
                flows={flows}
                navigating={navigating}
                filter={filter}
                empty={empty}
                width={sidebarWidth}
                height={sideRows - sideWorkflowRows}
              />
              {sideWorkflowRows > 0 && plan && (
                <WorkflowPanel
                  plan={plan}
                  tracked={tracked}
                  outline={props.outline === true}
                  phaseIndex={props.outlinePhase ?? 0}
                  taskOffset={props.outlineOffset ?? 0}
                  width={sidebarWidth}
                  maxRows={sideWorkflowRows}
                />
              )}
            </Box>
          )}
          <Box width={mainWidth} flexDirection="column" flexShrink={0}>
            {/* Beside the left column the Run's title shares the tabs' row,
                so both columns' frames start on the same line. */}
            {sidebar ? (
              <Box height={1} flexShrink={0} columnGap={1}>
                <Box flexGrow={1} flexBasis={0} minWidth={0} columnGap={1}>
                  <Box flexShrink={0}>
                    <Text bold {...tone(replying ? 'cyan' : undefined)}>
                      {selected
                        ? `Run ${state.runs.indexOf(selected) + 1}`
                        : 'No Run selected'}
                    </Text>
                  </Box>
                  {selected && (
                    <Box flexShrink={1} minWidth={0}>
                      <Text
                        bold
                        {...tone(replying ? 'cyan' : undefined)}
                        wrap="truncate-end"
                      >
                        ·{' '}
                        {terminalText(
                          trackedWork(state, selected.id)?.task.title ??
                            selected.label,
                        )}
                      </Text>
                    </Box>
                  )}
                  {selectedStatus && (
                    <Box flexShrink={0}>
                      <Text {...tone(selectedStatus.color)}>
                        {mainWidth - stringWidth(tabsText) - 10 >=
                        selectedStatus.label.length + 8
                          ? selectedStatus.label
                          : selectedStatus.short}
                      </Text>
                    </Box>
                  )}
                </Box>
                <Box flexShrink={0}>{tabs}</Box>
              </Box>
            ) : (
              <>
                {roster}
                <Box height={1} flexShrink={0}>
                  <Box flexGrow={1} minWidth={0}>
                    {tabs}
                  </Box>
                  {tracked && (
                    <Box flexShrink={0}>
                      <Text dimColor>o Workflow</Text>
                    </Box>
                  )}
                </Box>
              </>
            )}
            {compactWorkflowRows > 0 && plan && (
              <WorkflowPanel
                plan={plan}
                tracked={tracked}
                outline
                phaseIndex={props.outlinePhase ?? 0}
                taskOffset={props.outlineOffset ?? 0}
                width={mainWidth}
                maxRows={compactWorkflowRows}
                compact
              />
            )}
            <Box
              borderStyle={props.peek ? 'round' : 'single'}
              borderBottom={false}
              {...(frameColor ? { borderColor: frameColor } : {})}
              height={logRows + 1}
              flexShrink={0}
              paddingX={1}
              flexDirection="column"
              overflow="hidden"
            >
              {props.peek ? (
                <>
                  <Text wrap="truncate-end">
                    <Text color="cyan" bold>
                      Reply
                    </Text>
                    <Text dimColor>
                      {peekTurn
                        ? peekTurn.request
                          ? ' · ' +
                            terminalText(peekTurn.request).replace(/\s+/g, ' ')
                          : ''
                        : ' · no longer retained · 1 Live'}
                    </Text>
                  </Text>
                  {peekLines
                    .slice(peekStart, peekStart + peekRows)
                    .map((spans, index) => (
                      <Text key={index} wrap="truncate-end">
                        <Spans spans={spans} />
                      </Text>
                    ))}
                </>
              ) : log.length ? (
                log.map((line, index) => (
                  <Box
                    key={index}
                    height={1}
                    flexShrink={0}
                    {...(line.row !== undefined && line.row === selectedRow
                      ? { backgroundColor: SELECTED_BG }
                      : {})}
                  >
                    <Text
                      {...tone(line.color)}
                      bold={line.bold === true}
                      wrap="truncate-end"
                    >
                      {line.timeline ? (
                        <>
                          <Text dimColor>{line.timeline.time} </Text>
                          <Text color={line.timeline.entry.color} bold>
                            {line.timeline.entry.label}
                          </Text>
                          {line.timeline.entry.detail ? (
                            <Text bold={line.timeline.entry.detailBold}>
                              {' · '}
                              {line.timeline.entry.detail}
                            </Text>
                          ) : null}
                        </>
                      ) : line.spans ? (
                        <Spans spans={line.spans} />
                      ) : (
                        line.text || ' '
                      )}
                    </Text>
                  </Box>
                ))
              ) : (
                <Text dimColor>{empty}</Text>
              )}
            </Box>
            <FrameEdge
              width={mainWidth}
              round={props.peek !== undefined}
              color={frameColor}
              hint={frameHint.filter(Boolean).join(' · ')}
            />
            {request && (
              <DecisionPanel
                request={request}
                position={
                  ownPending.findIndex((item) => item.id === request.id) + 1
                }
                total={ownPending.length}
                armed={props.armed}
                height={decisionRows}
                shownSteps={shownSteps}
                compact={compactDecision}
              />
            )}
            {extras.map((line, index) => (
              <Box key={index} height={1} flexShrink={0}>
                <Text dimColor wrap="truncate-middle">
                  {terminalText(line)}
                </Text>
              </Box>
            ))}
            {inputLabel && (
              // Rules above and below set the input apart from the viewport and footer.
              <Box flexDirection="column" height={inputRows} flexShrink={0}>
                <Text wrap="truncate-end">
                  <Text dimColor>── </Text>
                  <Text color="cyan">{inputLabel}</Text>
                  <Text dimColor>
                    {' '}
                    {'─'.repeat(
                      Math.max(0, mainWidth - stringWidth(inputLabel) - 4),
                    )}
                  </Text>
                </Text>
                <Box height={1}>
                  <Text color="cyan" bold>
                    {props.mode === 'command' ? ': ' : '> '}
                  </Text>
                  {props.input}
                </Box>
                {inputRows > 2 && <Text dimColor>{'─'.repeat(mainWidth)}</Text>}
              </Box>
            )}
            <Box flexGrow={1} />
          </Box>
        </Box>
        <Box height={1} flexShrink={0}>
          <Text
            {...tone(!connected ? 'yellow' : undefined)}
            wrap="truncate-end"
          >
            {terminalText(
              workspaceAction &&
                props.mode === 'normal' &&
                connected &&
                !props.actionFailed
                ? selected?.worktree?.status.kind === 'commit-required'
                  ? 'Commit required · c commit with a message · x commit and remove · 1 Live for details'
                  : 'Worktree retained · x removes the Run, the folder stays · 1 Live for details'
                : note,
            )}
          </Text>
        </Box>
        <Box height={1} flexShrink={0} columnGap={1}>
          <Box flexShrink={0}>
            <Text dimColor>
              {selected
                ? `Run ${state.runs.indexOf(selected) + 1} · ${selected.provider}`
                : 'workbench'}
            </Text>
          </Box>
          {selected?.worktree && (
            <Box width={Math.floor(columns / 4)} flexShrink={0}>
              <Text color="cyan" wrap="truncate-middle">
                {terminalText(selected.worktree.branch)}
              </Text>
            </Box>
          )}
          <Box flexGrow={1} flexBasis={0} minWidth={0}>
            <Text color="cyan" wrap="truncate-middle">
              {selected
                ? selected.environment.location === 'pending'
                  ? 'Workspace pending'
                  : terminalText(selected.environment.location).replace(
                      /[\r\n\t]/g,
                      ' ',
                    )
                : 'No Run selected'}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>? help · q quit</Text>
          </Box>
        </Box>
      </Backdrop.Provider>
      {form && (
        // A full-screen layer that only centers the form; it draws nothing itself.
        <Box
          position="absolute"
          top={0}
          left={0}
          width={columns}
          height={rows}
          justifyContent="center"
          alignItems="center"
        >
          <Box width={modalWidth + 2} flexShrink={0} overflow="hidden">
            {/* Blank cells first: nothing behind shows through the gutter or the form. */}
            <Box position="absolute" top={0} left={0} flexDirection="column">
              {Array.from({ length: rows }, (_, row) => (
                <Text key={row}>{' '.repeat(modalWidth + 2)}</Text>
              ))}
            </Box>
            <Box
              margin={1}
              width={modalWidth}
              flexShrink={0}
              borderStyle="round"
              borderColor="cyan"
              paddingX={1}
              flexDirection="column"
            >
              {props.composer?.({
                width: modalWidth - 4,
                maxHeight: modalHeight - 2,
              })}
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}

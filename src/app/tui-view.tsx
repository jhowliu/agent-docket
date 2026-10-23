import { basename } from 'node:path';
import { useMemo } from 'react';
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
import { checkEnded, readableEvents, timelineEntries } from './tui-timeline.js';
import type { TimelineEntry } from './tui-timeline.js';
import { stageLabels, trackedWork } from './workbench-work.js';
import { ProjectPanel } from './tui-project.js';
import type { ProjectTreeView } from './tui-project.js';

export type View = 'live' | 'diff' | 'timeline';
export type Filter = 'active' | 'inbox';
export type PaneFocus = 'workspace' | 'project';
export type Line = {
  text: string;
  color?: string;
  timeline?: { time: string; entry: TimelineEntry };
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
  /** One ASCII column of a different shape per state; the label stays readable. */
  icon: string;
  color: string | undefined;
  /** Lower is more urgent; a project header shows its most urgent Run's icon. */
  rank: number;
}>;
/** A roster row's state; unread is this client's view of a finished turn. */
function runStatus(
  run: RunSnapshot,
  pending: readonly AttentionItem[],
  unread: boolean,
): RunStatus {
  const own = pending.filter((item) => item.runId === run.id);
  // Approvals block the agent; agent requests only wait on the person.
  if (own.length)
    return {
      label: own.some((item) => item.kind === 'permission')
        ? `Awaiting approval (${own.length})`
        : `Needs you (${own.length})`,
      icon: '!',
      color: 'yellow',
      rank: 0,
    };
  if (workspaceNeedsAction(run))
    return {
      label:
        run.worktree?.status.kind === 'commit-required'
          ? 'Commit required'
          : 'Worktree retained',
      icon: '!',
      color: 'yellow',
      rank: 0,
    };
  const label = states[run.state.kind];
  switch (run.state.kind) {
    case 'authentication-required':
      return { label, icon: '!', color: 'yellow', rank: 0 };
    case 'failed':
    case 'interrupted':
      return { label, icon: 'x', color: 'red', rank: 1 };
    case 'idle':
      return unread
        ? { label: 'Unread', icon: '*', color: 'magenta', rank: 2 }
        : { label, icon: '-', color: 'gray', rank: 4 };
    case 'starting':
    case 'running':
      return { label, icon: '~', color: 'blue', rank: 3 };
    case 'cancelling':
      return { label, icon: '~', color: undefined, rank: 3 };
    case 'cancelled':
    case 'closed':
      return { label, icon: ' ', color: undefined, rank: 5 };
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
      ['approve', 'respond', 'sign-in', 'commit', 'worktree'].includes(next),
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
      return 'Progress · ' + event.summary;
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
  attention: readonly AttentionItem[],
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
      if (
        event.type === 'agent.message' ||
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
    for (const entry of timelineEntries(ownEvents, attention)) {
      const date = new Date(entry.at);
      const time = Number.isNaN(date.getTime())
        ? '--:--:--'
        : date.toLocaleTimeString('en-GB', { hour12: false });
      if (entry.wrap) {
        const prefix = `${time} ${entry.label} · `;
        const wrapped = wrapAnsi(
          prefix + entry.detail,
          Math.max(1, width - 2),
          {
            hard: true,
            trim: false,
          },
        ).split('\n');
        for (const [index, part] of wrapped.entries())
          lines.push(
            index === 0
              ? {
                  text: part,
                  timeline: {
                    time,
                    entry: { ...entry, detail: part.slice(prefix.length) },
                  },
                }
              : { text: '  ' + part },
          );
        continue;
      }
      // Timeline groups observations; full output remains in Live.
      lines.push({
        text: `${time}  ${terminalText(entry.text).replace(/\s+/g, ' ')}`,
        timeline: { time, entry },
      });
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
  project: boolean;
  focus?: PaneFocus;
  tree?: ProjectTreeView;
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
};

/** Keep the composer and the terminal viewport on the same column boundary. */
export function workbenchMainWidth(columns: number) {
  return columns - (columns >= 80 ? 33 : 0);
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
        <Text bold>Workflow</Text>
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
  const ownPending = pending.filter((item) => item.runId === selectedId);
  const tracked = trackedWork(state, selectedId);
  const plan = state.work?.kind === 'ready' ? state.work.plan : null;
  const mainWidth = workbenchMainWidth(columns);
  const sidebar = mainWidth < columns;
  const sidebarWidth = columns - mainWidth - 1;
  const width = Math.max(1, mainWidth - 4);
  const worktreeDiff = props.worktreeDiff ?? NO_WORKTREE;
  const lines = useMemo(
    () =>
      detailLines(
        state.events,
        selectedId,
        view,
        width,
        state.attention,
        worktreeDiff,
      ),
    [state.events, state.attention, selectedId, view, width, worktreeDiff],
  );
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
  const compactRoster = (props.outline || props.project) && !sidebar;
  const groups = compactRoster ? null : rosterGroups(state, filter);
  const rosterLines: readonly RosterLine[] = groups
    ? groups.flatMap((group) => [
        { group },
        ...group.runs.map((run) => ({ group, run })),
      ])
    : runs.map((run) => ({ run }));
  const rosterRows = Math.max(
    1,
    Math.min(
      compactRoster ? 1 : groups ? 6 : 5,
      rosterLines.length || 1,
      Math.floor(rows / 6) + (groups ? 1 : 0),
    ),
  );
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
  const inputRows =
    props.mode === 'normal' || props.mode === 'new-session' ? 0 : 2;
  const projectOpen =
    props.project && !props.outline && !(props.details && request);
  const focus = props.focus ?? (projectOpen ? 'project' : 'workspace');
  const projectFocused =
    projectOpen && focus === 'project' && props.mode === 'normal';
  const workspaceFocused = focus === 'workspace' && props.mode === 'normal';
  const inlineCapacity = Math.min(
    rows >= 24 ? 10 : 6,
    rows - rosterRows - decisionRows - inputRows - 10,
  );
  const compactProjectRows = !sidebar && projectOpen ? inlineCapacity : 0;
  const projectRows = sidebar
    ? projectOpen
      ? Math.min(
          Math.max(6, (props.tree?.rows.length ?? 0) + 4),
          rows - 3 - (tracked ? 3 : 0),
        )
      : 6
    : 0;
  const compactWorkflowRows =
    props.outline && plan && !sidebar
      ? Math.min(
          rows >= 24 ? 9 : 6,
          rows - rosterRows - decisionRows - inputRows - 10,
        )
      : 0;
  const extraCapacity = Math.max(
    0,
    rows -
      rosterRows -
      compactWorkflowRows -
      compactProjectRows -
      decisionRows -
      inputRows -
      12,
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
            'i new prompt · a/r approval · x cancel',
            environment === 'local'
              ? selected?.worktree
                ? 'x close/recheck · :commit message saves all changes'
                : 'Local code copies are retained · p paths'
              : 'p environment paths · x cancel Run',
            selected?.worktree && state.features?.verify
              ? 'v verify on a clean copy · :check <command> sets it'
              : '',
          ]),
    );
  else if (props.help)
    disclosures.push(
      'Ctrl+W h/l focus Project/workspace · p browse',
      'Project: j/k move · h/l folders · g/G first/last',
      'j/k agent · w waiting/unread · Tab request · a/r allow/deny',
      'h/l or 1–3 views · PgUp/PgDn scroll · g/G top/end',
      'n new · i reply · Esc keep draft · p paths · s actions',
      ': command · q / Ctrl+C detach; Runs keep running',
      ':active all agents · :inbox pending approvals',
      'o Roadmap · :roadmap title · :track P.T · :direct',
      ':spec requirements · :confirm · :stage development',
      'Stopped worktree: c / :commit message saves all changes',
      'm / :map open the Run’s Change map in the browser',
      'v verify: freeze the Run’s code, run the project check on a clean copy',
      ':check <command> sets the check · :check shows it',
    );
  // Bound every optional region to leave a readable timeline at the minimum size.
  const extras = disclosures.filter(Boolean).slice(0, extraCapacity);
  const logRows = Math.max(
    1,
    rows -
      rosterRows -
      extras.length -
      decisionRows -
      compactWorkflowRows -
      compactProjectRows -
      inputRows -
      9,
  );
  const offset = Math.min(props.offset, Math.max(0, lines.length - logRows));
  const end = Math.max(0, lines.length - offset);
  const log = lines.slice(Math.max(0, end - logRows), end);
  // New Session floats centered in front of the dimmed workspace.
  const modalWidth = Math.min(columns - 6, 96);
  const modalHeight = Math.min(rows - 4, 16);
  const empty = selected
    ? view === 'diff'
      ? 'No file changes yet'
      : view === 'timeline'
        ? 'No milestones yet · 1 Live for full output'
        : fixture
          ? 'i to prompt · s for fixture scenarios'
          : 'i to prompt when idle · s actions'
    : 'n new Run';
  const counts = ` · ${filter} · ${runs.length} runs${workspaceFocused ? ' · focus' : ''}${
    rosterLines.length > rosterRows
      ? ` · ${selectedIndex + 1}/${runs.length}`
      : ''
  }`;
  const noticeWidth = props.notice
    ? Math.min(stringWidth(props.notice.text), mainWidth - 'agents'.length - 1)
    : 0;
  // Counts give way whole rather than truncating the title next to a notice.
  const rosterCounts =
    !props.notice ||
    'agents'.length + counts.length + 1 + noticeWidth <= mainWidth
      ? counts
      : '';
  const connection = !connected
    ? 'Disconnected · reconnecting'
    : busy
      ? 'Sending'
      : 'Connected';
  return (
    <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
      <Backdrop.Provider value={form}>
        <Box height={1} flexShrink={0}>
          <Text bold>workbench</Text>
          <Text>
            {' '}
            ·{' '}
            {fixture
              ? 'FIXTURE / no model'
              : environment === 'local'
                ? 'LOCAL / no OS isolation'
                : 'CONTAINER'}{' '}
            ·{' '}
          </Text>
          <Text color={connected ? 'cyan' : 'yellow'}>{connection}</Text>
          <Text color="yellow">
            {pending.length ? ` · ${pending.length} pending` : ''}
          </Text>
        </Box>
        <Box height={rows - 3} flexShrink={0} columnGap={sidebar ? 1 : 0}>
          {/* Project and Workflow sit on the left, like an editor's file tree. */}
          {sidebar && (
            <Box width={sidebarWidth} flexDirection="column" flexShrink={0}>
              <ProjectPanel
                tree={props.tree}
                expanded={projectOpen}
                focused={projectFocused}
                width={sidebarWidth}
                height={projectRows}
              />
              {plan && (
                <WorkflowPanel
                  plan={plan}
                  tracked={tracked}
                  outline={props.outline === true}
                  phaseIndex={props.outlinePhase ?? 0}
                  taskOffset={props.outlineOffset ?? 0}
                  width={sidebarWidth}
                  maxRows={rows - 3 - projectRows}
                />
              )}
            </Box>
          )}
          <Box width={mainWidth} flexDirection="column" flexShrink={0}>
            <Box height={1} flexShrink={0} columnGap={1}>
              <Box flexGrow={1} flexBasis={0} minWidth={0}>
                <Text wrap="truncate-end">
                  <Text {...tone(workspaceFocused ? 'cyan' : undefined)}>
                    agents
                  </Text>
                  <Text dimColor>{rosterCounts}</Text>
                </Text>
              </Box>
              {/* A background notice outranks the roster's counts while it shows. */}
              {props.notice && (
                <Box width={noticeWidth} flexShrink={0}>
                  <Text color={props.notice.color} wrap="truncate-end">
                    {props.notice.text}
                  </Text>
                </Box>
              )}
            </Box>
            <Box
              borderStyle="single"
              {...(workspaceFocused ? { borderColor: 'cyan' } : {})}
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
                    const rollup = line.group.runs
                      .map((item) =>
                        runStatus(item, pending, unread.has(item.id)),
                      )
                      .reduce<
                        RunStatus | undefined
                      >((most, item) => (most && most.rank <= item.rank ? most : item), undefined);
                    return (
                      <Box
                        key={`project-${line.group.project?.id ?? 'other'}`}
                        height={1}
                        flexShrink={0}
                      >
                        <Text wrap="truncate-end">
                          <Text {...tone(rollup?.color)}>
                            {rollup?.icon ?? ' '}{' '}
                          </Text>
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
                  const status = runStatus(run, pending, unread.has(run.id));
                  return (
                    <Box key={run.id} height={1} flexShrink={0} columnGap={1}>
                      <Box width={1} flexShrink={0}>
                        <Text {...tone(status.color)}>{status.icon}</Text>
                      </Box>
                      <Box flexGrow={1} flexBasis={0} minWidth={0}>
                        <Text
                          {...tone(active ? 'cyan' : undefined)}
                          inverse={active && workspaceFocused}
                          wrap="truncate-end"
                        >
                          {active ? '> ' : '  '}Run{' '}
                          {state.runs.findIndex((item) => item.id === run.id) +
                            1}{' '}
                          ·{' '}
                          {terminalText(
                            trackedWork(state, run.id)?.task.title ?? run.label,
                          )}
                        </Text>
                      </Box>
                      <Box width={status.label.length} flexShrink={0}>
                        <Text {...tone(status.color)} wrap="truncate-end">
                          {status.label}
                        </Text>
                      </Box>
                    </Box>
                  );
                })
              )}
            </Box>
            <Box height={1} flexShrink={0}>
              <Box flexGrow={1} minWidth={0}>
                {views.map((name, index) => (
                  <Text
                    key={name}
                    {...tone(view === name ? 'cyan' : undefined)}
                    bold={view === name}
                  >
                    {' '}
                    {index + 1}{' '}
                    {name === 'live'
                      ? 'Live'
                      : name === 'diff'
                        ? 'Diff'
                        : 'Timeline'}{' '}
                  </Text>
                ))}
                <Text dimColor>
                  {offset > 0
                    ? mainWidth >= 70
                      ? ' · follow paused'
                      : ' · paused'
                    : ''}
                </Text>
              </Box>
              {!sidebar && (
                <Box columnGap={1} flexShrink={0}>
                  <Text dimColor>p Project</Text>
                  {tracked && <Text dimColor>o Workflow</Text>}
                </Box>
              )}
            </Box>
            {compactProjectRows > 0 && (
              <ProjectPanel
                tree={props.tree}
                expanded
                focused={projectFocused}
                width={mainWidth}
                height={compactProjectRows}
              />
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
              borderStyle="single"
              borderColor={request ? 'yellow' : undefined}
              height={logRows + 2}
              flexShrink={0}
              paddingX={1}
              flexDirection="column"
              overflow="hidden"
            >
              {log.length ? (
                log.map((line, index) => (
                  <Text key={index} {...tone(line.color)} wrap="truncate-end">
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
                    ) : (
                      line.text || ' '
                    )}
                  </Text>
                ))
              ) : (
                <Text dimColor>{empty}</Text>
              )}
            </Box>
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
            {props.mode !== 'normal' && props.mode !== 'new-session' && (
              <Box flexDirection="column" height={2} flexShrink={0}>
                <Text color="cyan">
                  {props.mode === 'reply'
                    ? 'Reply · Enter send / Esc keep draft'
                    : 'Command · Enter run / Esc close'}
                </Text>
                <Box height={1}>
                  <Text color="cyan">
                    {props.mode === 'command' ? ': ' : '> '}
                  </Text>
                  {props.input}
                </Box>
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
                  ? 'Commit required · c commit all changes · x recheck'
                  : 'Worktree retained · x recheck · 1 Live for details'
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

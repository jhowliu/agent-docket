import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import wrapAnsi from 'wrap-ansi';
import type { AttentionItem } from '../attention/index.js';
import type {
  RunEvent,
  RunId,
  RunSnapshot,
  RunState,
} from '../execution/index.js';
import type { WorkbenchState } from './workbench-protocol.js';
import { terminalText } from './tui-input.js';
import { readableEvents, timelineEntries } from './tui-timeline.js';
import type { TimelineEntry } from './tui-timeline.js';

export type View = 'live' | 'diff' | 'timeline';
export type Filter = 'active' | 'inbox' | 'history';
export type Line = {
  text: string;
  color?: string;
  timeline?: { time: string; entry: TimelineEntry };
};
const views: readonly View[] = ['live', 'diff', 'timeline'];
const tone = (color: string | undefined) => (color ? { color } : {});
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
export function visibleRuns(
  state: WorkbenchState,
  filter: Filter,
): readonly RunSnapshot[] {
  return state.runs.filter((run) =>
    filter === 'history'
      ? ended.has(run.state.kind)
      : filter === 'inbox'
        ? state.attention.some(
            (item) => item.runId === run.id && item.status === 'pending',
          )
        : !ended.has(run.state.kind),
  );
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
  }
}
function eventColor(event: RunEvent): string | undefined {
  return event.type === 'attention'
    ? 'yellow'
    : event.type === 'diagnostic' ||
        (event.type === 'tool' && event.status === 'failed')
      ? 'red'
      : undefined;
}
function detailLines(
  events: readonly RunEvent[],
  runId: RunId | null,
  view: View,
  width: number,
  attention: readonly AttentionItem[],
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
  if (view === 'diff') {
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
        event.type === 'turn.end'
      )
        append(eventSummary(event), eventColor(event));
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
  note: string;
  project: boolean;
  options: boolean;
  help: boolean;
  details: boolean;
  mode: 'normal' | 'reply' | 'command';
  columns: number;
  rows: number;
  input?: ReactNode;
};

/** Pure terminal projection; it cannot start Runs or answer permissions. */
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
  const width = Math.max(1, columns - 4);
  const runs = visibleRuns(state, filter);
  const selected = state.runs.find((run) => run.id === selectedId);
  const provider = selected?.provider ?? state.launch?.provider ?? 'fixture';
  const environment =
    selected?.environment.kind ??
    state.launch?.kind ??
    'trusted-fixture-directory';
  const fixture = provider === 'fixture';
  const pending = state.attention.filter((item) => item.status === 'pending');
  const ownPending = pending.filter((item) => item.runId === selectedId);
  const lines = useMemo(
    () => detailLines(state.events, selectedId, view, width, state.attention),
    [state.events, state.attention, selectedId, view, width],
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
  const rosterRows = Math.max(
    1,
    Math.min(5, runs.length || 1, Math.floor(rows / 6)),
  );
  const selectedIndex = Math.max(
    0,
    runs.findIndex((run) => run.id === selectedId),
  );
  const rosterStart = Math.max(
    0,
    Math.min(runs.length - rosterRows, selectedIndex - rosterRows + 1),
  );
  const disclosures: string[] = [];
  // The input adapter opens one group at a time; decision details also take priority here.
  if (props.details && request) {
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
  } else if (props.project)
    disclosures.push(
      'Source · ' + state.source,
      'Environment · ' +
        (selected?.environment.location ?? 'Select a Run first'),
    );
  else if (props.options && selected?.state.kind === 'authentication-required')
    disclosures.push(
      ...selected.state.methods.map(
        (method) => `:auth ${method.id} · ${method.label}`,
      ),
    );
  else if (props.options)
    disclosures.push(
      ...(fixture
        ? [
            'i prompts: fix / question / reply:name / wait / crash',
            'two-permissions · x cancel · :active/:inbox/:history',
          ]
        : [
            'i new prompt · a/r approval · x cancel',
            environment === 'local'
              ? 'Local code copies are retained · p paths'
              : 'p environment paths · x cancel Run',
          ]),
    );
  else if (props.help)
    disclosures.push(
      'j/k agent · w waiting · Tab request · a/r allow/deny',
      'h/l or 1–3 views · PgUp/PgDn scroll · g/G top/end',
      'n new · i reply · Esc keep draft · p paths · s actions',
      ': command · q / Ctrl+C detach; Runs keep running',
    );
  // Bound every optional region to leave a readable timeline at the minimum size.
  const extras = disclosures.slice(0, Math.max(0, rows - rosterRows - 14));
  const decisionRows = request ? 2 : 0;
  const logRows = Math.max(
    1,
    rows -
      rosterRows -
      extras.length -
      decisionRows -
      (props.mode === 'normal' ? 0 : 2) -
      9,
  );
  const offset = Math.min(props.offset, Math.max(0, lines.length - logRows));
  const end = Math.max(0, lines.length - offset);
  const log = lines.slice(Math.max(0, end - logRows), end);
  const empty = selected
    ? view === 'diff'
      ? 'No file changes yet'
      : view === 'timeline'
        ? 'No milestones yet · 1 Live for full output'
        : fixture
          ? 'i to prompt · s for fixture scenarios'
          : 'i to prompt when idle · s actions'
    : 'n new Run · :history for past Runs';
  const connection = !connected
    ? 'Disconnected · reconnecting'
    : busy
      ? 'Sending'
      : 'Connected';
  return (
    <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
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
      <Box height={1} flexShrink={0}>
        <Text color="cyan">agents</Text>
        <Text dimColor>
          {' '}
          · {filter} · {runs.length} runs
          {runs.length > rosterRows
            ? ` · ${selectedIndex + 1}/${runs.length}`
            : ''}
        </Text>
      </Box>
      <Box
        borderStyle="single"
        borderColor="cyan"
        flexDirection="column"
        height={rosterRows + 2}
        flexShrink={0}
        paddingX={1}
      >
        {runs.length === 0 ? (
          <Text dimColor>{empty}</Text>
        ) : (
          runs.slice(rosterStart, rosterStart + rosterRows).map((run) => {
            const count = pending.filter(
              (item) => item.runId === run.id,
            ).length;
            const active = run.id === selectedId;
            return (
              <Box key={run.id} height={1} flexShrink={0}>
                <Box width="55%">
                  <Text
                    {...tone(active ? 'cyan' : undefined)}
                    inverse={active}
                    wrap="truncate-end"
                  >
                    {active ? '> ' : '  '}Run{' '}
                    {state.runs.findIndex((item) => item.id === run.id) + 1} ·{' '}
                    {terminalText(run.label)}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text
                    {...tone(
                      count
                        ? 'yellow'
                        : ['failed', 'interrupted'].includes(run.state.kind)
                          ? 'red'
                          : run.state.kind === 'authentication-required'
                            ? 'yellow'
                            : ['starting', 'running'].includes(run.state.kind)
                              ? 'blue'
                              : run.state.kind === 'idle'
                                ? 'gray'
                                : undefined,
                    )}
                    wrap="truncate-end"
                  >
                    {count
                      ? `Awaiting approval (${count})`
                      : states[run.state.kind]}
                  </Text>
                </Box>
              </Box>
            );
          })
        )}
      </Box>
      <Box height={1} flexShrink={0}>
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
        <Text dimColor>{offset > 0 ? ' · follow paused' : ''}</Text>
      </Box>
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
        <Box flexDirection="column" height={2} flexShrink={0}>
          <Text color="yellow" wrap="truncate-end">
            Approval{' '}
            {ownPending.findIndex((item) => item.id === request.id) + 1}/
            {ownPending.length} · {terminalText(request.title)}
          </Text>
          <Text wrap="truncate-end">
            {props.armed
              ? request.choices
                  .filter(
                    (choice) =>
                      choice.kind === 'allow-once' ||
                      choice.kind === 'reject-once',
                  )
                  .map(
                    (choice) =>
                      `${choice.kind === 'allow-once' ? 'a' : 'r'} ${terminalText(choice.label)}`,
                  )
                  .join('  ')
              : 'Tab to select another request'}{' '}
            · d details · Tab next
          </Text>
        </Box>
      )}
      {extras.map((line, index) => (
        <Box key={index} height={1} flexShrink={0}>
          <Text dimColor wrap="truncate-middle">
            {terminalText(line)}
          </Text>
        </Box>
      ))}
      {props.mode !== 'normal' && (
        <Box flexDirection="column" height={2} flexShrink={0}>
          <Text color="cyan">
            {props.mode === 'reply'
              ? 'Reply · Enter send / Esc keep draft'
              : 'Command · Enter run / Esc close'}
          </Text>
          <Box height={1}>
            <Text color="cyan">{props.mode === 'command' ? ': ' : '> '}</Text>
            {props.input}
          </Box>
        </Box>
      )}
      <Box flexGrow={1} />
      <Box height={1} flexShrink={0}>
        <Text {...tone(!connected ? 'yellow' : undefined)} wrap="truncate-end">
          {terminalText(note)}
        </Text>
      </Box>
      <Box height={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          j/k agents · i reply · a/r approve · ? help · q quit
        </Text>
      </Box>
    </Box>
  );
}

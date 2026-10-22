import { spawn } from 'node:child_process';
import { useEffect, useRef, useState } from 'react';
import { useApp, useInput, useWindowSize } from 'ink';
import type { AttentionId, AttentionItem } from '../attention/index.js';
import type { RunId, RunSnapshot } from '../execution/index.js';
import type { WorkbenchClient } from './workbench-client.js';
import { WorkbenchError } from './workbench-client.js';
import type { WorkbenchCommand, WorkbenchState } from './workbench-protocol.js';
import { PromptInput, terminalText } from './tui-input.js';
import {
  WorkbenchScreen,
  visibleRuns,
  workbenchMainWidth,
  workspaceNeedsAction,
} from './tui-view.js';
import type { Filter, PaneFocus, View } from './tui-view.js';
import {
  roadmapCommand,
  trackedWork,
  stateForRun,
  projectForRun,
} from './workbench-work.js';
import { useProjectTree } from './tui-project.js';
import { useWorktreeDiff } from './tui-diff.js';
import { NewSession } from './tui-session.js';

type Mode =
  | { kind: 'normal' }
  | { kind: 'reply'; runId: RunId }
  | { kind: 'command' }
  | { kind: 'new-session' };
const views: readonly View[] = ['live', 'diff', 'timeline'];
const message = (error: unknown) =>
  terminalText(
    error instanceof Error
      ? error.message
      : 'Action failed; check the connection',
  );

const NOTE_MS = 8000;
const AGENT_NAMES = { codex: 'Codex', claude: 'Claude', fixture: 'The agent' };
/** What the selected Run is doing and the keys that matter now. */
function stateHint(
  state: WorkbenchState,
  run: RunSnapshot | undefined,
  request: AttentionItem | undefined,
): string {
  if (!run) return 'n new Run · ? help · q detach; Runs keep running';
  // The decision panel above lists the keys; the footer only says who is waiting.
  // An agent request does not pause the agent, so the Run's own state follows.
  if (request?.kind === 'permission')
    return `${AGENT_NAMES[run.provider]} is waiting for your approval`;
  const changes =
    state.features?.changeMap &&
    run.worktree &&
    run.worktree.status.kind !== 'removed'
      ? ' · m changes'
      : '';
  switch (run.state.kind) {
    case 'running':
      return `${AGENT_NAMES[run.provider]} is working · x stop · 1 Live`;
    case 'starting':
      return 'Starting the agent…';
    case 'cancelling':
      return 'Stopping the agent…';
    case 'authentication-required':
      return 'Sign-in required · s actions';
    case 'idle':
      return `Idle · i message${changes} · n new Run`;
    case 'failed':
    case 'interrupted':
      return `Run ${run.state.kind}${changes} · n new Run`;
    case 'cancelled':
    case 'closed':
      return `Run ended${changes} · n new Run`;
  }
}

/** Hands a loopback URL to the platform's browser opener; the URL is also shown in the footer. */
function openInBrowser(url: string) {
  const opener =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer'
        : 'xdg-open';
  try {
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The footer still shows the URL to open by hand.
  }
}

/** Input/rendering adapter. Server domains remain authoritative for every mutation. */
export function WorkbenchApp({
  client,
  initial,
  pollInterval = 400,
  projectPath = process.cwd(),
  openUrl = openInBrowser,
}: {
  client: WorkbenchClient;
  initial: WorkbenchState;
  pollInterval?: number;
  projectPath?: string;
  openUrl?: (url: string) => void;
}) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const tooSmall = columns < 60 || rows < 20;
  const [snapshot, setState] = useState(initial);
  const [selectedId, setSelectedId] = useState<RunId | null>(
    initial.runs[0]?.id ?? null,
  );
  const [filter, setFilter] = useState<Filter>('active');
  const [view, setView] = useState<View>('timeline');
  const [offset, setOffset] = useState(0);
  const [focusedId, setFocusedId] = useState<AttentionId | null>(null);
  const [needsSelection, setNeedsSelection] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: 'normal' });
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [commandText, setCommandText] = useState('');
  const [project, setProject] = useState(false);
  const [focus, setFocus] = useState<PaneFocus>('workspace');
  const windowCommand = useRef(false);
  const [options, setOptions] = useState(false);
  const [help, setHelp] = useState(false);
  const [details, setDetails] = useState(false);
  const [outline, setOutline] = useState(false);
  const [outlinePhase, setOutlinePhase] = useState(0);
  const [outlineOffset, setOutlineOffset] = useState(0);
  const [connected, setConnected] = useState(true);
  const connectedRef = useRef(true);
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const inFlight = useRef(false);
  const heldAction = useRef<string | null>(null);
  const mounted = useRef(true);
  // An action's receipt shows briefly; after that the footer describes the selected Run.
  const [noted, setNoted] = useState({ text: '', at: 0 });
  const note = noted.text;
  function setNote(text: string) {
    setNoted({ text, at: Date.now() });
  }
  const [receipt, setReceipt] = useState<AttentionId | null>(null);
  const epoch = useRef(initial.instanceId);
  const lastTurnEnd = (state: WorkbenchState) =>
    Math.max(
      0,
      ...state.events
        .filter((event) => event.type === 'turn.end')
        .map((event) => event.sequence),
    );
  // Turns that ended before this TUI saw them are not announced again.
  const announcedTurn = useRef(lastTurnEnd(initial));
  const runs = visibleRuns(snapshot, filter);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const selectedRef = useRef<RunId | null>(null);
  selectedRef.current = selected?.id ?? null;
  const state = stateForRun(snapshot, selected?.id ?? null);
  const pending = state.attention.filter(
    (item) => item.status === 'pending' && item.runId === selected?.id,
  );
  const request = pending.find((item) => item.id === focusedId) ?? pending[0];
  const worktreeDiff = useWorktreeDiff(
    client,
    state,
    selected?.id ?? null,
    view === 'diff',
  );
  const projectTree = useProjectTree(
    client,
    state,
    selected?.id ?? null,
    columns >= 80 || project,
  );
  const answered = state.attention.find((item) => item.id === receipt);
  const fresh = note !== '' && Date.now() - noted.at < NOTE_MS;
  const footer = !connected
    ? note
    : !fresh
      ? stateHint(snapshot, selected, request)
      : answered?.status === 'delivered'
        ? 'Response delivered to agent'
        : answered?.status === 'stale'
          ? 'Approval expired · ' + answered.reason
          : answered?.status === 'accepted'
            ? 'Response accepted; awaiting delivery to agent'
            : note;

  function apply(snapshot: WorkbenchState) {
    if (!mounted.current) return;
    if (!connectedRef.current && snapshot.instanceId === epoch.current)
      setNote('Reconnected; state refreshed');
    if (snapshot.instanceId !== epoch.current) {
      epoch.current = snapshot.instanceId;
      setFocusedId(null);
      setNeedsSelection(true);
      setReceipt(null);
      setMode({ kind: 'normal' });
      setOffset(0);
      setOutline(false);
      setProject(false);
      setFocus('workspace');
      windowCommand.current = false;
      setFilter('active');
      setNote('Server restarted; fresh state loaded');
      announcedTurn.current = lastTurnEnd(snapshot);
    }
    // When the selected Run finishes a turn in a worktree, point at the Change map.
    const ended = snapshot.events.filter(
      (event) =>
        event.type === 'turn.end' && event.sequence > announcedTurn.current,
    );
    if (ended.length) {
      announcedTurn.current = lastTurnEnd(snapshot);
      const run = snapshot.runs.find((item) => item.id === selectedRef.current);
      if (
        snapshot.features?.changeMap &&
        run?.worktree &&
        run.worktree.status.kind !== 'removed' &&
        ended.some((event) => event.runId === run.id)
      )
        setNote('Turn finished · m see what changed');
    }
    setState(snapshot);
    connectedRef.current = true;
    setConnected(true);
  }
  async function refresh() {
    try {
      apply(await client.poll());
    } catch (error: unknown) {
      if (!mounted.current) return;
      connectedRef.current = false;
      setConnected(false);
      setNote(message(error));
    }
  }
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      await refresh();
      if (!stopped)
        timer = setTimeout(() => {
          void tick();
        }, pollInterval);
    }
    timer = setTimeout(() => {
      void tick();
    }, pollInterval);
    return () => {
      stopped = true;
      mounted.current = false;
      clearTimeout(timer);
    };
    // client and interval are stable for the lifetime of this mounted transport.
  }, [client, pollInterval]);

  function select(id: RunId | null) {
    setFocus('workspace');
    setSelectedId(id);
    setFocusedId(null);
    setNeedsSelection(false);
    setReceipt(null);
    setDetails(false);
    setOffset(0);
    setOutline(false);
    setOutlineOffset(0);
  }
  async function execute(command: WorkbenchCommand): Promise<boolean> {
    if (!connectedRef.current) {
      setNote('Not connected; wait for reconnection');
      return false;
    }
    if (inFlight.current) return false;
    inFlight.current = true;
    setActionFailed(false);
    setBusy(true);
    setReceipt(null);
    try {
      const project = projectForRun(snapshot, selected?.id ?? null);
      const scoped =
        'expectedRevision' in command && project
          ? { kind: 'project-work' as const, projectId: project.id, command }
          : command;
      const result = await client.command(scoped);
      if (!mounted.current) return true;
      if ('runId' in result) {
        setFilter('active');
        select(result.runId);
        setNote(
          command.kind === 'new-session'
            ? 'Session requested · i prompt when idle · s actions'
            : state.launch?.provider && state.launch.provider !== 'fixture'
              ? 'Run requested · i prompt when idle · s actions'
              : 'Run started · i prompt · s scenarios',
        );
      } else if (command.kind === 'answer') {
        setReceipt(command.id);
        setNote('Last response accepted');
      } else if (command.kind === 'complete-request')
        setNote('Marked done · the agent was not told; i to reply');
      else if (command.kind === 'prompt')
        setNote('Message accepted · watch Timeline');
      else if (command.kind === 'authenticate')
        setNote('Sign-in requested · waiting for agent');
      else if (command.kind === 'cancel')
        setNote(
          result.branch && result.workspaceRemoved
            ? `Run closed · branch kept: ${result.branch}`
            : 'Run cancelled · n starts a new Run',
        );
      else if (command.kind === 'commit-workspace')
        setNote(
          result.branch
            ? `Saved ${result.branch} · worktree ${result.workspaceRemoved ? 'removed' : 'retained'}`
            : 'Changes saved to local branch · worktree cleanup checked',
        );
      else if ('expectedRevision' in command)
        setNote(
          command.kind === 'work.detach'
            ? 'Direct Run · project plan kept'
            : command.kind === 'work.confirm'
              ? 'Requirements confirmed · Development ready'
              : command.kind === 'work.stage'
                ? 'Working stage updated · review remains unverified'
                : 'Roadmap updated · o outline',
        );
      await refresh();
      return true;
    } catch (error: unknown) {
      if (mounted.current) {
        setActionFailed(true);
        setNote(message(error));
        if (error instanceof WorkbenchError && error.kind === 'unavailable') {
          connectedRef.current = false;
          setConnected(false);
        }
      }
      return false;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function answer(kind: 'allow-once' | 'reject-once', index?: number) {
    setFocus('workspace');
    if (!request || needsSelection) {
      setNote('Press Tab to select a pending request first');
      return;
    }
    if (request.kind !== 'permission') {
      setNote('a/r answer approvals · y marks this request done');
      return;
    }
    const choice =
      index === undefined
        ? request.choices.find((item) => item.kind === kind)
        : request.choices[index];
    if (!choice) {
      setNote('No matching option; d shows available choices');
      return;
    }
    // Legacy terminals cannot report key-up. Require deliberate navigation between decisions.
    setNeedsSelection(true);
    void execute({ kind: 'answer', id: request.id, choiceId: choice.id });
  }
  /** Marks the visibly selected agent request done; the agent is not told. */
  function complete() {
    setFocus('workspace');
    if (!request || needsSelection) {
      setNote('Press Tab to select a pending request first');
      return;
    }
    if (request.kind !== 'agent-request') {
      setNote('y marks agent requests done · a/r answer approvals');
      return;
    }
    setNeedsSelection(true);
    void execute({ kind: 'complete-request', id: request.id });
  }
  function setTab(tab: View) {
    setFocus('workspace');
    setView(tab);
    setOffset(0);
  }
  function changeFilter(next: Filter) {
    setFilter(next);
    select(visibleRuns(state, next)[0]?.id ?? null);
  }
  function focusPane(next: PaneFocus) {
    setFocus(next);
    if (next === 'project') {
      setProject(true);
      setOutline(false);
      setOptions(false);
      setHelp(false);
      setDetails(false);
    }
    setNote(
      next === 'project'
        ? 'Project focused · j/k move · h/l folders · Esc back'
        : 'Workspace focused · j/k Runs · h/l views',
    );
  }
  /** The server reads the Run's own worktree; the TUI only names the Run. */
  function openChangeMap() {
    const worktree = selected?.worktree;
    if (!selected) setNote('Select a Run to open its Change map');
    else if (!snapshot.features?.changeMap)
      setNote('Change map needs an updated server; restart the daemon');
    else if (!worktree)
      setNote('Change map needs a Run with a local Git worktree');
    else if (worktree.status.kind === 'removed')
      setNote(`Worktree removed; its commits stay on ${worktree.branch}`);
    else {
      const url = client.changeMapUrl(selected.id);
      openUrl(url);
      setNote(`Change map: ${url}`);
    }
  }
  function runCommand(text: string) {
    const [name = '', ...parts] = text.trim().split(/\s+/);
    const argument = parts.join(' ');
    setMode({ kind: 'normal' });
    setCommandText('');
    try {
      const workCommand = roadmapCommand(text, state, selected?.id ?? null);
      if (workCommand) {
        void execute(workCommand);
        return;
      }
      if (name === 'roadmap' && !argument) {
        setFocus('workspace');
        setProject(false);
        setOutline(!outline);
        return;
      }
    } catch (error) {
      setNote(message(error));
      return;
    }
    if (name === 'new' && !argument) {
      newSession();
      return;
    }
    if ((name === 'active' || name === 'inbox') && !argument) {
      changeFilter(name);
      return;
    }
    if (
      (name === 'live' || name === 'diff' || name === 'timeline') &&
      !argument
    ) {
      setTab(name);
      return;
    }
    if (name === 'use' && /^\d+$/.test(argument)) {
      const run = runs[Number(argument) - 1];
      if (run) select(run.id);
      else setNote('Run number not found; use j/k to select');
      return;
    }
    if (name === 'cancel' && !argument && selected) {
      void execute({ kind: 'cancel', runId: selected.id });
      return;
    }
    if (name === 'commit' && selected) {
      if (!argument)
        setNote(
          'Use :commit <message> to commit all changes to the local branch and remove the worktree',
        );
      else
        void execute({
          kind: 'commit-workspace',
          runId: selected.id,
          message: argument,
        });
      return;
    }
    if (name === 'auth' && argument && selected) {
      void execute({
        kind: 'authenticate',
        runId: selected.id,
        methodId: argument,
      });
      return;
    }
    if (name === 'answer' && /^\d+$/.test(argument)) {
      answer('allow-once', Number(argument) - 1);
      return;
    }
    if (name === 'prompt' && argument && selected) {
      void execute({ kind: 'prompt', runId: selected.id, text: argument });
      return;
    }
    if (name === 'map' && !argument) {
      openChangeMap();
      return;
    }
    if (name === 'help' && !argument) {
      setFocus('workspace');
      setProject(false);
      setOptions(false);
      setDetails(false);
      setHelp(true);
      return;
    }
    if (name === 'quit' && !argument) {
      exit();
      return;
    }
    setNote('Unknown command · :new / :use 2 / :inbox / :prompt fix / :cancel');
  }
  function newSession() {
    if (state.features?.newSession && state.sessionOptions) {
      setFocus('workspace');
      setReceipt(null);
      setMode({ kind: 'new-session' });
    } else void execute({ kind: 'start' });
  }
  useInput((input, key) => {
    // Keep the workspace listener/raw-mode subscription mounted across composer
    // transitions. A render can reach the terminal before passive effects run.
    if (mode.kind !== 'normal' && !tooSmall) return;
    if (key.eventType === 'release') {
      if (heldAction.current === input) heldAction.current = null;
      return;
    }
    if (key.ctrl || key.meta || key.super || key.hyper) {
      windowCommand.current =
        key.ctrl &&
        !key.meta &&
        !key.super &&
        !key.hyper &&
        input === 'w' &&
        !tooSmall;
      if (windowCommand.current) {
        heldAction.current = null;
        setReceipt(null);
        setNote('Focus · h workspace · l Project · w switch · Esc cancel');
      }
      return;
    }
    if (input === 'q') {
      exit();
      return;
    }
    if (columns < 60 || rows < 20) return;
    if (input.length > 1) return;
    if (windowCommand.current) {
      windowCommand.current = false;
      if (input === 'h' || key.leftArrow) focusPane('workspace');
      else if (input === 'l' || key.rightArrow) focusPane('project');
      else if (input === 'w')
        focusPane(focus === 'project' ? 'workspace' : 'project');
      else setNote('Focus unchanged · Ctrl+W h/l switches panes');
      return;
    }
    const action = ['n', 'a', 'r', 'x'].includes(input);
    if (action) {
      if (
        key.eventType === 'repeat' ||
        heldAction.current === input ||
        inFlight.current
      )
        return;
      heldAction.current = input;
    } else heldAction.current = null;
    if (focus === 'project' && project) {
      let navigated = true;
      if (input === 'j' || key.downArrow || input === ']') projectTree.move(1);
      else if (input === 'k' || key.upArrow || input === '[')
        projectTree.move(-1);
      else if (input === 'h' || key.leftArrow) projectTree.left();
      else if (input === 'l' || key.rightArrow) projectTree.right();
      else if (input === 'g' || key.home) projectTree.first();
      else if (input === 'G' || key.end) projectTree.last();
      else if (key.pageUp || key.pageDown)
        projectTree.move(
          (key.pageUp ? -1 : 1) * Math.max(1, Math.floor(rows / 2)),
        );
      else if (key.return || input === ' ') projectTree.toggle();
      else if (input === 'R') projectTree.refresh();
      else navigated = false;
      if (navigated) return;
    }
    if (input === 'j' || key.downArrow || input === 'k' || key.upArrow) {
      const index = runs.findIndex((run) => run.id === selected?.id);
      const direction = input === 'j' || key.downArrow ? 1 : -1;
      select(
        runs[Math.max(0, Math.min(runs.length - 1, index + direction))]?.id ??
          null,
      );
    } else if (input === 'w') {
      const waiting = runs.filter((run) =>
        state.attention.some(
          (item) => item.status === 'pending' && item.runId === run.id,
        ),
      );
      select(
        waiting[
          (waiting.findIndex((run) => run.id === selected?.id) + 1) %
            waiting.length
        ]?.id ??
          selected?.id ??
          null,
      );
    } else if (key.tab) {
      setFocus('workspace');
      const index = pending.findIndex((item) => item.id === request?.id);
      setFocusedId(
        pending[(index + (key.shift ? pending.length - 1 : 1)) % pending.length]
          ?.id ?? null,
      );
      setNeedsSelection(false);
      setReceipt(null);
    } else if (input === 'y') complete();
    else if (input === 'a') answer('allow-once');
    else if (input === 'r') answer('reject-once');
    else if (input === 'n') {
      newSession();
    } else if (input === 'm') {
      openChangeMap();
    } else if (input === 'x' && selected) {
      setFocus('workspace');
      void execute({ kind: 'cancel', runId: selected.id });
    } else if (input === 'c' && workspaceNeedsAction(selected)) {
      setFocus('workspace');
      setReceipt(null);
      setCommandText('commit ');
      setMode({ kind: 'command' });
      setNote(
        'Commit all non-ignored changes to the local branch, then remove the worktree',
      );
    } else if (input === 'i' && selected) {
      setFocus('workspace');
      setReceipt(null);
      if (selected.state.kind === 'idle')
        setMode({ kind: 'reply', runId: selected.id });
      else setNote('Run is busy; a/r answers approval, x cancels');
    } else if (input === ':') {
      setMode({ kind: 'command' });
      setReceipt(null);
    } else if (input === 'o') {
      if (!state.work || state.work.kind === 'unavailable')
        setNote(state.work?.reason ?? 'This server does not support Roadmaps');
      else if (!state.work.plan)
        setNote('Optional Roadmap · :roadmap <title> starts tracking');
      else {
        const current = trackedWork(state, selected?.id ?? null);
        setOutlinePhase(
          Math.max(
            0,
            state.work.plan.phases.findIndex(
              (phase) =>
                phase.id ===
                (current?.phase.id ?? state.work?.plan?.activePhaseId),
            ),
          ),
        );
        setOutline(!outline);
        setOutlineOffset(
          Math.max(
            0,
            current?.phase.tasks.findIndex(
              (task) => task.id === current.task.id,
            ) ?? 0,
          ),
        );
        setProject(false);
        setFocus('workspace');
        setOptions(false);
        setHelp(false);
        setDetails(false);
      }
    } else if (outline && (input === '[' || input === ']')) {
      const count = state.work?.plan?.phases.length ?? 0;
      setOutlinePhase((value) =>
        Math.max(0, Math.min(count - 1, value + (input === ']' ? 1 : -1))),
      );
      setOutlineOffset(0);
    } else if (outline && (input === '{' || input === '}')) {
      const count = state.work?.plan?.phases[outlinePhase]?.tasks.length ?? 0;
      setOutlineOffset((value) =>
        Math.max(0, Math.min(count - 1, value + (input === '}' ? 1 : -1))),
      );
    } else if (
      input === 'p' ||
      input === 's' ||
      input === '?' ||
      input === 'd'
    ) {
      if (input === 'p' && (!project || focus !== 'project'))
        focusPane('project');
      else {
        setProject(false);
        focusPane('workspace');
      }
      setOptions(input === 's' ? !options : false);
      setHelp(input === '?' ? !help : false);
      setDetails(input === 'd' ? !details : false);
      setOutline(false);
    } else if (/^[1-3]$/.test(input))
      setTab(views[Number(input) - 1] ?? 'timeline');
    else if (
      input === 'h' ||
      key.leftArrow ||
      input === 'l' ||
      key.rightArrow
    ) {
      setTab(
        views[
          (views.indexOf(view) + (input === 'h' || key.leftArrow ? 2 : 1)) % 3
        ] ?? 'timeline',
      );
    } else if (key.pageUp)
      setOffset((value) =>
        Math.min(1_000_000, value + Math.max(1, Math.floor(rows / 2))),
      );
    else if (key.pageDown)
      setOffset((value) =>
        Math.max(0, value - Math.max(1, Math.floor(rows / 2))),
      );
    else if (input === 'g' || key.home) setOffset(1_000_000);
    else if (input === 'G' || key.end) setOffset(0);
    else if (key.escape) {
      if (focus === 'project') focusPane('workspace');
      setProject(false);
      setOptions(false);
      setHelp(false);
      setDetails(false);
      setOutline(false);
    }
  });

  const value =
    mode.kind === 'command'
      ? commandText
      : mode.kind === 'reply'
        ? (drafts[mode.runId] ?? '')
        : '';
  const input = (
    <PromptInput
      id={mode.kind === 'reply' ? mode.runId : mode.kind}
      active={(mode.kind === 'command' || mode.kind === 'reply') && !tooSmall}
      value={value}
      width={Math.max(1, workbenchMainWidth(columns) - 3)}
      onChange={(next) => {
        if (mode.kind === 'command') setCommandText(next);
        else if (mode.kind === 'reply')
          setDrafts((previous) => ({ ...previous, [mode.runId]: next }));
      }}
      onEscape={() => {
        setMode({ kind: 'normal' });
        heldAction.current = null;
      }}
      onSubmit={() => {
        if (inFlight.current) return;
        if (mode.kind === 'command') {
          runCommand(commandText);
          return;
        }
        if (mode.kind !== 'reply') return;
        const runId = mode.runId;
        const sent = value;
        if (!sent.trim()) {
          setNote('Enter a message first');
          return;
        }
        void execute({ kind: 'prompt', runId, text: sent }).then((accepted) => {
          if (
            !accepted ||
            !mounted.current ||
            draftsRef.current[runId] !== sent
          )
            return;
          setDrafts((previous) => ({ ...previous, [runId]: '' }));
          setMode((current) =>
            current.kind === 'reply' && current.runId === runId
              ? { kind: 'normal' }
              : current,
          );
        });
      }}
    />
  );
  return (
    <>
      <WorkbenchScreen
        state={state}
        selectedId={selected?.id ?? null}
        worktreeDiff={worktreeDiff}
        filter={filter}
        view={view}
        offset={offset}
        request={request}
        armed={!needsSelection}
        connected={connected}
        busy={busy}
        actionFailed={actionFailed}
        note={footer}
        project={project}
        focus={focus}
        tree={projectTree.view}
        options={options}
        help={help}
        details={details}
        outline={outline}
        outlinePhase={outlinePhase}
        outlineOffset={outlineOffset}
        mode={tooSmall ? 'normal' : mode.kind}
        composer={
          mode.kind === 'new-session' && !tooSmall && state.sessionOptions ? (
            <NewSession
              client={client}
              options={state.sessionOptions}
              initialPath={projectPath}
              width={workbenchMainWidth(columns)}
              enabled={connected && !tooSmall}
              folderCompletion={state.features?.folderCompletion === true}
              onCreate={execute}
              onClose={() => {
                setMode({ kind: 'normal' });
                heldAction.current = null;
              }}
            />
          ) : undefined
        }
        columns={columns}
        rows={rows}
        input={
          mode.kind === 'normal' || mode.kind === 'new-session' || tooSmall
            ? undefined
            : input
        }
      />
      {/* Remain mounted in navigation so pasted shortcut text is consumed, never executed. */}
      {(mode.kind === 'normal' || tooSmall) && input}
    </>
  );
}

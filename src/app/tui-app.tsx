import { useEffect, useRef, useState } from 'react';
import { useApp, useInput, useWindowSize } from 'ink';
import type { AttentionId } from '../attention/index.js';
import type { RunId } from '../execution/index.js';
import type { WorkbenchClient } from './workbench-client.js';
import { WorkbenchError } from './workbench-client.js';
import type { WorkbenchCommand, WorkbenchState } from './workbench-protocol.js';
import { PromptInput, terminalText } from './tui-input.js';
import { WorkbenchScreen, visibleRuns } from './tui-view.js';
import type { Filter, View } from './tui-view.js';

type Mode =
  | { kind: 'normal' }
  | { kind: 'reply'; runId: RunId }
  | { kind: 'command' };
const views: readonly View[] = ['live', 'diff', 'timeline'];
const message = (error: unknown) =>
  terminalText(
    error instanceof Error
      ? error.message
      : 'Action failed; check the connection',
  );

/** Input/rendering adapter. Server domains remain authoritative for every mutation. */
export function WorkbenchApp({
  client,
  initial,
  pollInterval = 400,
}: {
  client: WorkbenchClient;
  initial: WorkbenchState;
  pollInterval?: number;
}) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const tooSmall = columns < 60 || rows < 20;
  const [state, setState] = useState(initial);
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
  const [options, setOptions] = useState(false);
  const [help, setHelp] = useState(false);
  const [details, setDetails] = useState(false);
  const [connected, setConnected] = useState(true);
  const connectedRef = useRef(true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const heldAction = useRef<string | null>(null);
  const mounted = useRef(true);
  const [note, setNote] = useState(
    'n new Run · i reply · q detach; Runs keep running',
  );
  const [receipt, setReceipt] = useState<AttentionId | null>(null);
  const epoch = useRef(initial.instanceId);
  const runs = visibleRuns(state, filter);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const pending = state.attention.filter(
    (item) => item.status === 'pending' && item.runId === selected?.id,
  );
  const request = pending.find((item) => item.id === focusedId) ?? pending[0];
  const answered = state.attention.find((item) => item.id === receipt);
  const footer = !connected
    ? note
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
      setNote('Server restarted; fresh state loaded, previous Runs lost');
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
    setSelectedId(id);
    setFocusedId(null);
    setNeedsSelection(false);
    setReceipt(null);
    setDetails(false);
    setOffset(0);
  }
  async function execute(command: WorkbenchCommand): Promise<boolean> {
    if (!connectedRef.current) {
      setNote('Not connected; wait for reconnection');
      return false;
    }
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setReceipt(null);
    try {
      const result = await client.command(command);
      if (!mounted.current) return true;
      if ('runId' in result) {
        setFilter('active');
        select(result.runId);
        setNote(
          state.launch?.provider && state.launch.provider !== 'fixture'
            ? 'Run requested · i prompt when idle · s actions'
            : 'Run started · i prompt · s scenarios',
        );
      } else if (command.kind === 'answer') {
        setReceipt(command.id);
        setNote('Last response accepted');
      } else if (command.kind === 'prompt') setNote('Last message accepted');
      else if (command.kind === 'authenticate')
        setNote('Sign-in requested · waiting for agent');
      else if (command.kind === 'cancel')
        setNote('Run cancelled · :history shows past Runs');
      await refresh();
      return true;
    } catch (error: unknown) {
      if (mounted.current) {
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
    if (!request || needsSelection) {
      setNote('Press Tab to select a pending request first');
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
  function setTab(tab: View) {
    setView(tab);
    setOffset(0);
  }
  function changeFilter(next: Filter) {
    setFilter(next);
    select(visibleRuns(state, next)[0]?.id ?? null);
  }
  function runCommand(text: string) {
    const [name = '', ...parts] = text.trim().split(/\s+/);
    const argument = parts.join(' ');
    setMode({ kind: 'normal' });
    setCommandText('');
    if (name === 'new' && !argument) {
      void execute({ kind: 'start' });
      return;
    }
    if (
      (name === 'active' || name === 'inbox' || name === 'history') &&
      !argument
    ) {
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
    if (name === 'help' && !argument) {
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
    setNote(
      'Unknown command · :new / :use 2 / :inbox / :history / :prompt fix / :cancel',
    );
  }
  useInput(
    (input, key) => {
      if (key.eventType === 'release') {
        if (heldAction.current === input) heldAction.current = null;
        return;
      }
      if (key.ctrl || key.meta || key.super || key.hyper) return;
      if (input === 'q') {
        exit();
        return;
      }
      if (columns < 60 || rows < 20) return;
      if (input.length > 1) return;
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
        const index = pending.findIndex((item) => item.id === request?.id);
        setFocusedId(
          pending[
            (index + (key.shift ? pending.length - 1 : 1)) % pending.length
          ]?.id ?? null,
        );
        setNeedsSelection(false);
        setReceipt(null);
      } else if (input === 'a') answer('allow-once');
      else if (input === 'r') answer('reject-once');
      else if (input === 'n') {
        void execute({ kind: 'start' });
      } else if (input === 'x' && selected) {
        void execute({ kind: 'cancel', runId: selected.id });
      } else if (input === 'i' && selected) {
        setReceipt(null);
        if (selected.state.kind === 'idle')
          setMode({ kind: 'reply', runId: selected.id });
        else setNote('Run is busy; a/r answers approval, x cancels');
      } else if (input === ':') {
        setMode({ kind: 'command' });
        setReceipt(null);
      } else if (
        input === 'p' ||
        input === 's' ||
        input === '?' ||
        input === 'd'
      ) {
        setProject(input === 'p' ? !project : false);
        setOptions(input === 's' ? !options : false);
        setHelp(input === '?' ? !help : false);
        setDetails(input === 'd' ? !details : false);
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
        setProject(false);
        setOptions(false);
        setHelp(false);
        setDetails(false);
      }
    },
    { isActive: mode.kind === 'normal' || tooSmall },
  );

  const value =
    mode.kind === 'command'
      ? commandText
      : mode.kind === 'reply'
        ? (drafts[mode.runId] ?? '')
        : '';
  const input = (
    <PromptInput
      id={mode.kind === 'reply' ? mode.runId : mode.kind}
      active={mode.kind !== 'normal' && !tooSmall}
      value={value}
      width={Math.max(1, columns - 3)}
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
        filter={filter}
        view={view}
        offset={offset}
        request={request}
        armed={!needsSelection}
        connected={connected}
        busy={busy}
        note={footer}
        project={project}
        options={options}
        help={help}
        details={details}
        mode={tooSmall ? 'normal' : mode.kind}
        columns={columns}
        rows={rows}
        input={mode.kind === 'normal' || tooSmall ? undefined : input}
      />
      {/* Remain mounted in navigation so pasted shortcut text is consumed, never executed. */}
      {(mode.kind === 'normal' || tooSmall) && input}
    </>
  );
}

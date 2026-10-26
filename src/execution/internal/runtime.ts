import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { AttentionId, Choice } from '../../attention/index.js';
import type {
  Candidate,
  CheckResult,
  Execution,
  ExecutionOptions,
  Launch,
  RunEvent,
  RunEventPayload,
  RunId,
  RunSnapshot,
  RunState,
  Worker,
  WorktreeSnapshot,
} from '../index.js';
import { launchManaged } from './worker.js';
import type { ManagedProcess } from './worker.js';
import { createProgressChannel } from './progress.js';
import type { ProgressChannel } from './progress.js';
import { workbenchInstructions } from './progress-protocol.js';
import { directoryPathSchema, readWorkspaceDirectory } from './directory.js';
import { runCheck } from './check.js';
import type { CheckRun } from './check.js';

const workerFields = {
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,200}$/),
  envFile: z
    .string()
    .regex(/^\/[a-zA-Z0-9_./-]+$/)
    .optional(),
};
const workerSchema = z.discriminatedUnion('transport', [
  z
    .object({
      transport: z.literal('local'),
      workspaceRoot: z
        .string()
        .min(1)
        .refine(isAbsolute, 'Use an absolute workspaceRoot'),
      authFile: z
        .string()
        .min(1)
        .refine(isAbsolute, 'Use an absolute authFile')
        .optional(),
      adapter: z
        .object({
          file: z
            .string()
            .min(1)
            .refine((value) => !value.includes('\0')),
          args: z
            .array(z.string().refine((value) => !value.includes('\0')))
            .max(40),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ transport: z.literal('docker'), ...workerFields }).strict(),
  z
    .object({
      transport: z.literal('ssh'),
      host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,200}$/),
      ...workerFields,
    })
    .strict(),
]);
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixture') }).strict(),
  z
    .object({
      kind: z.literal('directory'),
      path: z.string().min(1).refine(isAbsolute, 'Use an absolute source path'),
      base: z
        .object({
          branch: z
            .string()
            .min(1)
            .max(255)
            .refine((value) => !value.includes('\0'))
            .optional(),
          revision: z.string().regex(/^[a-f0-9]{40,64}$/),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('git'),
      revision: z.string().regex(/^[a-f0-9]{40}$/i),
      url: z
        .string()
        .url()
        .refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        }, 'Use an HTTPS URL without embedded credentials; revision must be an immutable SHA'),
    })
    .strict(),
]);
const launchSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('fixture'),
      label: z.string().min(1).max(120).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.enum(['codex', 'claude']),
      worker: workerSchema,
      source: sourceSchema,
      label: z.string().min(1).max(120).optional(),
    })
    .strict(),
]);
export function parseLaunch(input: unknown): Launch {
  const parsed = launchSchema.parse(input);
  const label = parsed.label === undefined ? {} : { label: parsed.label };
  if (parsed.provider === 'fixture') return { provider: 'fixture', ...label };
  if (parsed.worker.transport === 'local' && parsed.provider !== 'codex')
    throw new Error('Local mode currently supports Codex only');
  if (parsed.worker.transport !== 'local' && parsed.source.kind === 'directory')
    throw new Error('Directory sources require explicit local mode');
  const configured = parsed.worker;
  const worker: Worker =
    configured.transport === 'local'
      ? {
          transport: 'local',
          workspaceRoot: configured.workspaceRoot,
          ...(configured.authFile === undefined
            ? {}
            : { authFile: configured.authFile }),
          ...(configured.adapter === undefined
            ? {}
            : { adapter: configured.adapter }),
        }
      : configured.transport === 'ssh'
        ? {
            transport: 'ssh',
            host: configured.host,
            image: configured.image,
            ...(configured.envFile === undefined
              ? {}
              : { envFile: configured.envFile }),
          }
        : {
            transport: 'docker',
            image: configured.image,
            ...(configured.envFile === undefined
              ? {}
              : { envFile: configured.envFile }),
          };
  return { provider: parsed.provider, worker, source: parsed.source, ...label };
}
type Slot = {
  snapshot: RunSnapshot;
  managed: ManagedProcess | null;
  launchTask: Promise<ManagedProcess> | null;
  connection: acp.ClientConnection | null;
  sessionId: string | null;
  authMethods: { id: string; label: string }[];
  epoch: number;
  responses: Map<acp.JsonRpcId, AttentionId>;
  tools: Map<string, Extract<RunEventPayload, { type: 'tool' }>>;
  promptTask: Promise<acp.PromptResponse> | null;
  cancelTask: Promise<void> | null;
  cleanup: Promise<void> | null;
  progress: ProgressChannel | null;
  progressTask: Promise<ProgressChannel> | null;
  stopped: boolean;
  /** Last measured content identity; undefined while a turn may change it. */
  tree: string | undefined;
  treeEpoch: number;
  check: { abort: AbortController; task: Promise<CheckResult> } | null;
  /** The person cancelled it or saved its changes: removed once nothing is left to save. */
  dismissed: boolean;
  /** When the agent last did something in the current turn. */
  activeAt: number;
  /** Permission requests waiting on the person; the turn's idle clock stops meanwhile. */
  awaiting: number;
};
const terminal = (state: RunState) =>
  ['cancelled', 'closed', 'failed', 'interrupted'].includes(state.kind);
const cancelling = (slot: Slot) =>
  ['cancelling', 'cancelled'].includes(slot.snapshot.state.kind);
const isClosed = (slot: Slot) => slot.snapshot.state.kind === 'closed';
const isStopping = (slot: Slot) => slot.snapshot.state.kind === 'cancelling';
const redact = (text: string) =>
  text.replace(
    /\b(?:sk-[a-zA-Z0-9_-]{12,}|Bearer\s+[a-zA-Z0-9._-]{12,})\b/g,
    '[redacted]',
  );
function safeText(text: string): string {
  return redact(text.slice(0, 8000));
}
const withTree = (
  worktree: WorktreeSnapshot,
  tree: string | undefined,
): WorktreeSnapshot => {
  const { tree: _previous, ...rest } = worktree;
  return tree ? { ...rest, tree } : rest;
};
const errorText = (error: unknown) =>
  safeText(error instanceof Error ? error.message : String(error));
const AUTO_COMMIT = 'Save the work of a cancelled Run (Agent Workbench)';
const duration = (ms: number) =>
  ms % 60_000 === 0
    ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`
    : `${ms / 1000} seconds`;
async function deadline<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('ACP operation timed out')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const shellCommand = z.union([z.string(), z.array(z.string())]);
const commandInput = z.object({ command: shellCommand });
/**
 * What a permission request would act on, for display beside its title: the
 * command line (adapters may JSON-encode it, or pass `bash -lc <script>`) or
 * the first file location. Provider shapes stay inside execution.
 */
function subjectOf(toolCall: {
  rawInput?: unknown;
  locations?: readonly { path: string }[] | null;
}): { subject?: string } {
  const input = commandInput.safeParse(toolCall.rawInput);
  if (input.success) {
    let command: unknown = input.data.command;
    if (typeof command === 'string')
      try {
        command = JSON.parse(command);
      } catch {
        // A plain command line is already readable.
      }
    const parsed = shellCommand.safeParse(command);
    if (parsed.success) {
      const parts = parsed.data;
      const text =
        typeof parts === 'string'
          ? parts
          : parts.length === 3 && /^-l?c$/.test(parts[1] ?? '')
            ? (parts[2] ?? '')
            : parts.join(' ');
      if (text.trim()) return { subject: safeText(text).slice(0, 500) };
    }
  }
  const path = toolCall.locations?.[0]?.path;
  return path ? { subject: safeText(path).slice(0, 500) } : {};
}

export function createExecution(options: ExecutionOptions): Execution {
  const { attention } = options;
  const maxEvents = options.maxEvents ?? 2000;
  if (!Number.isInteger(maxEvents) || maxEvents < 5 || maxEvents > 10000)
    throw new Error('maxEvents must be between 5 and 10000');
  const idleTurnMs = options.idleTurnMs ?? 10 * 60_000;
  if (
    !Number.isInteger(idleTurnMs) ||
    idleTurnMs < 100 ||
    idleTurnMs > 24 * 60 * 60_000
  )
    throw new Error('idleTurnMs must be between 100 and 86400000');
  const slots = new Map<RunId, Slot>();
  const listeners = new Set<(event: RunEvent) => void>();
  const journal: RunEvent[] = [];
  let sequence = 0;
  let closing = false;
  let closed = false;
  let closeTask: Promise<void> | null = null;
  function emit(slot: Slot, payload: RunEventPayload): void {
    if (closed) return;
    const event: RunEvent = {
      ...structuredClone(payload),
      sequence: ++sequence,
      runId: slot.snapshot.id,
      at: new Date().toISOString(),
    };
    journal.push(event);
    if (journal.length > maxEvents) journal.shift();
    for (const listener of listeners) {
      try {
        listener(structuredClone(event));
      } catch {
        /* Observers are outside execution control. */
      }
    }
  }
  function setState(slot: Slot, state: RunState): void {
    slot.snapshot = { ...slot.snapshot, state };
    emit(slot, { type: 'run.state', state });
  }
  function get(id: RunId): Slot {
    const slot = slots.get(id);
    if (!slot) throw new Error('Unknown Run');
    return slot;
  }
  /**
   * A dismissed Run leaves once nothing is left to save. Changes still in its
   * worktree go to its own branch first; a worktree Git would not remove
   * (locked, branch changed) stays on disk for the person.
   */
  async function release(slot: Slot): Promise<void> {
    if (!slot.dismissed || closing || !terminal(slot.snapshot.state)) return;
    const worktree = slot.managed?.worktree;
    if (slot.snapshot.worktree?.status.kind === 'commit-required' && worktree)
      try {
        recordWorktree(slot, await worktree.commit(AUTO_COMMIT));
      } catch (error) {
        emit(slot, {
          type: 'diagnostic',
          message: `Automatic commit failed: ${errorText(error)}. :commit <message> saves the changes.`,
        });
        return;
      }
    if (!closing) slots.delete(slot.snapshot.id);
  }
  function interrupt(slot: Slot, reason: string): void {
    if (
      terminal(slot.snapshot.state) ||
      slot.snapshot.state.kind === 'cancelling'
    )
      return;
    slot.epoch++;
    attention.invalidate(slot.snapshot.id, reason, { includeRequests: true });
    setState(slot, { kind: 'interrupted', reason });
    void clean(slot).catch((error: unknown) =>
      emit(slot, {
        type: 'diagnostic',
        message: 'Managed environment cleanup failed: ' + errorText(error),
      }),
    );
  }
  function recordWorktree(slot: Slot, worktree: WorktreeSnapshot): void {
    const status =
      worktree.status.kind === 'retained'
        ? { ...worktree.status, reason: safeText(worktree.status.reason) }
        : worktree.status;
    const before = slot.snapshot.worktree;
    const next = withTree({ ...worktree, status }, slot.tree);
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    slot.snapshot = { ...slot.snapshot, worktree: next };
    // A new content identity alone is not news for the Timeline.
    if (before && JSON.stringify(before.status) === JSON.stringify(status))
      return;
    emit(slot, {
      type: 'diagnostic',
      message:
        status.kind === 'removed'
          ? `Worktree removed. Local branch kept: ${worktree.branch}`
          : status.kind === 'commit-required'
            ? `Commit required: ${status.changes} changed paths. Commit all changes to ${worktree.branch} with :commit <message>, then remove the worktree. No remote push.`
            : status.kind === 'retained'
              ? `Worktree retained: ${status.reason}`
              : `Local worktree branch: ${worktree.branch}`,
    });
  }
  function recordTree(slot: Slot, tree: string | undefined): void {
    slot.treeEpoch++;
    slot.tree = tree;
    const worktree = slot.snapshot.worktree;
    if (worktree)
      slot.snapshot = { ...slot.snapshot, worktree: withTree(worktree, tree) };
  }
  /** Records what the worktree holds now; failures leave the content unknown. */
  async function measure(slot: Slot): Promise<void> {
    const worktree = slot.managed?.worktree;
    if (!worktree || slot.snapshot.worktree?.status.kind === 'removed') return;
    const epoch = slot.treeEpoch;
    try {
      const tree = await worktree.measure();
      if (epoch === slot.treeEpoch) recordTree(slot, tree);
    } catch {
      if (epoch === slot.treeEpoch) recordTree(slot, undefined);
    }
  }
  async function clean(slot: Slot): Promise<void> {
    slot.check?.abort.abort();
    if (!slot.cleanup)
      slot.cleanup = (async () => {
        slot.connection?.close();
        attention.invalidate(slot.snapshot.id, 'Run environment closed', {
          includeRequests: true,
        });
        const managed =
          slot.managed ?? (await slot.launchTask?.catch(() => null));
        const progress =
          slot.progress ?? (await slot.progressTask?.catch(() => null));
        try {
          await managed?.stop();
          slot.stopped = true;
        } finally {
          await progress?.close();
        }
      })().catch((error: unknown) => {
        slot.cleanup = null;
        throw error;
      });
    await slot.cleanup;
    if (slot.managed?.worktree) {
      // The agent may have changed files after its last turn ended.
      await measure(slot);
      recordWorktree(slot, await slot.managed.worktree.collect());
    }
  }
  function streamFor(slot: Slot, managed: ManagedProcess): acp.Stream {
    const base = acp.ndJsonStream(
      Writable.toWeb(managed.child.stdin),
      Readable.toWeb(managed.child.stdout),
      { maxMessageBytes: 1024 * 1024 },
    );
    const writer = base.writable.getWriter();
    return {
      readable: base.readable,
      writable: new WritableStream<acp.AnyMessage>({
        async write(message) {
          const isResponse =
            'id' in message && ('result' in message || 'error' in message);
          const responseId = 'id' in message ? message.id : undefined;
          const itemId =
            isResponse && responseId !== undefined
              ? slot.responses.get(responseId)
              : undefined;
          let outbound = message;
          if (itemId) {
            const item = attention
              .list(slot.snapshot.id)
              .find((i) => i.id === itemId);
            if (
              (item?.status !== 'accepted' ||
                terminal(slot.snapshot.state) ||
                slot.snapshot.state.kind === 'cancelling') &&
              responseId !== undefined
            )
              outbound = {
                jsonrpc: '2.0',
                id: responseId,
                result: { outcome: { outcome: 'cancelled' } },
              };
          }
          try {
            await writer.write(outbound);
            if (itemId) attention.delivered(itemId);
          } finally {
            if (isResponse && responseId !== undefined)
              slot.responses.delete(responseId);
          }
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      }),
    };
  }
  function receive(slot: Slot, notification: acp.SessionNotification): void {
    if (
      terminal(slot.snapshot.state) ||
      slot.snapshot.state.kind === 'cancelling'
    )
      return;
    if (slot.sessionId && notification.sessionId !== slot.sessionId) {
      emit(slot, {
        type: 'diagnostic',
        message: 'Discarded update for a different Session',
      });
      return;
    }
    slot.activeAt = Date.now();
    const update = notification.update;
    if (
      update.sessionUpdate === 'agent_message_chunk' &&
      update.content.type === 'text'
    )
      emit(slot, {
        type: 'agent.message',
        text: safeText(update.content.text),
      });
    if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      const previous = slot.tools.get(update.toolCallId);
      const tool = {
        type: 'tool',
        id: update.toolCallId,
        title: safeText(update.title ?? previous?.title ?? 'Tool update'),
        status: update.status ?? previous?.status ?? 'unknown',
      } as const;
      slot.tools.set(tool.id, tool);
      if (slot.tools.size > maxEvents) {
        const oldest = slot.tools.keys().next().value;
        if (oldest !== undefined) slot.tools.delete(oldest);
      }
      emit(slot, tool);
      for (const content of update.content ?? [])
        if (content.type === 'diff')
          emit(slot, {
            type: 'diff',
            path: safeText(content.path),
            oldText: safeText(content.oldText ?? ''),
            newText: safeText(content.newText),
          });
    }
  }
  async function newSession(slot: Slot): Promise<void> {
    if (!slot.connection || !slot.managed)
      throw new Error('Run connection not ready');
    try {
      const response = await deadline(
        slot.connection.agent.request(acp.methods.agent.session.new, {
          cwd: slot.managed.cwd,
          mcpServers: slot.progress ? [slot.progress.server] : [],
        }),
        20_000,
      );
      if (
        terminal(slot.snapshot.state) ||
        slot.snapshot.state.kind === 'cancelling'
      )
        return;
      slot.sessionId = response.sessionId;
      setState(slot, { kind: 'idle' });
    } catch (error) {
      if (terminal(slot.snapshot.state) || cancelling(slot)) return;
      if (
        error instanceof acp.RequestError &&
        error.code === acp.RequestError.authRequired().code
      ) {
        setState(slot, {
          kind: 'authentication-required',
          methods: slot.authMethods,
        });
        return;
      }
      throw error;
    }
  }
  const unsubscribe = attention.subscribe((item) => {
    const slot = slots.get(item.runId);
    if (slot)
      emit(slot, { type: 'attention', id: item.id, status: item.status });
  });
  function reserve(input: Launch) {
    if (closing) throw new Error('Execution is closing');
    if (slots.size >= 64) throw new Error('M0 capacity is 64 Runs per process');
    const launch = parseLaunch(input);
    const id: RunId = `run-${randomUUID()}`;
    const slot: Slot = {
      snapshot: {
        id,
        provider: launch.provider,
        label: safeText(launch.label ?? launch.provider),
        state: { kind: 'starting' },
        environment: {
          kind:
            launch.provider === 'fixture'
              ? 'trusted-fixture-directory'
              : launch.worker.transport,
          location: 'pending',
        },
        capabilities: null,
      },
      managed: null,
      launchTask: null,
      connection: null,
      sessionId: null,
      authMethods: [],
      epoch: 0,
      responses: new Map(),
      tools: new Map(),
      promptTask: null,
      cancelTask: null,
      cleanup: null,
      progress: null,
      progressTask: null,
      stopped: false,
      tree: undefined,
      treeEpoch: 0,
      check: null,
      dismissed: false,
      activeAt: 0,
      awaiting: 0,
    };
    slots.set(id, slot);
    emit(slot, { type: 'run.state', state: { kind: 'starting' } });
    return { slot, launch };
  }
  async function initialize(slot: Slot, launch: Launch): Promise<RunSnapshot> {
    const id = slot.snapshot.id;
    try {
      slot.launchTask = launchManaged(launch, id);
      const managed = await slot.launchTask;
      slot.managed = managed;
      slot.snapshot = { ...slot.snapshot, environment: managed.environment };
      if (managed.worktree) recordWorktree(slot, managed.worktree.snapshot());
      if (closing || terminal(slot.snapshot.state) || cancelling(slot))
        throw new Error('Run startup was cancelled');
      if (
        ['local', 'trusted-fixture-directory'].includes(
          managed.environment.kind,
        )
      ) {
        slot.progressTask = createProgressChannel({
          report: (summary, finished) => {
            if (slot.snapshot.state.kind !== 'running') return;
            slot.activeAt = Date.now();
            emit(slot, {
              type: 'agent.progress',
              summary: safeText(summary),
              ...(finished ? { finished: true as const } : {}),
            });
          },
          // The agent asked the person to act or answer; attention keeps it past the turn.
          request: (request) => {
            if (slot.snapshot.state.kind !== 'running') return;
            slot.activeAt = Date.now();
            try {
              attention.ask({
                runId: slot.snapshot.id,
                request: request.kind,
                title: safeText(request.title),
                steps: request.steps.map(safeText),
              });
            } catch (error) {
              emit(slot, {
                type: 'diagnostic',
                message: `Agent request was not recorded: ${errorText(error)}`,
              });
            }
          },
          failed: () => {
            if (!terminal(slot.snapshot.state) && !cancelling(slot))
              emit(slot, {
                type: 'diagnostic',
                message: 'Agent progress reporting became unavailable.',
              });
          },
        });
        slot.progress = await slot.progressTask;
        if (closing || terminal(slot.snapshot.state) || cancelling(slot))
          throw new Error('Run startup was cancelled');
      }
      if (managed.environment.kind === 'local')
        emit(slot, {
          type: 'diagnostic',
          message: managed.worktree
            ? 'Local Git worktree: no OS isolation. Closing collects clean files; commit changes to keep them on the local branch.'
            : 'Local process: no OS isolation. The code copy is retained when this Run stops.',
        });
      managed.child.on('error', () => {
        interrupt(slot, 'Adapter process failed');
      });
      managed.child.on('exit', (code, signal) => {
        interrupt(slot, `Adapter exited (${code ?? signal ?? 'unknown'})`);
      });
      managed.child.stderr.on('data', () => {
        /* Drain stderr; credentials and arbitrary adapter diagnostics are not persisted. */
      });
      const connection = acp
        .client({ name: 'agent-workbench' })
        .onNotification(acp.methods.client.session.update, ({ params }) =>
          receive(slot, params),
        )
        .onRequest(
          acp.methods.client.session.requestPermission,
          async ({ params, requestId, signal }) => {
            if (
              params.sessionId !== slot.sessionId ||
              slot.snapshot.state.kind !== 'running' ||
              signal.aborted
            )
              return { outcome: { outcome: 'cancelled' } };
            const epoch = slot.epoch;
            const optionIds = new Map(
              params.options.map((option, index) => [
                `choice-${index}`,
                option.optionId,
              ]),
            );
            const kinds = {
              allow_once: 'allow-once',
              allow_always: 'allow-always',
              reject_once: 'reject-once',
              reject_always: 'reject-always',
            } as const;
            const choices: Choice[] = params.options.map((option, index) => ({
              id: `choice-${index}`,
              label: safeText(option.name),
              kind: kinds[option.kind],
            }));
            const request = attention.request({
              runId: id,
              title: safeText(
                params.toolCall.title ?? 'Agent needs permission',
              ),
              detail: safeText(JSON.stringify(params.toolCall)),
              ...subjectOf(params.toolCall),
              choices,
            });
            slot.responses.set(requestId, request.id);
            const aborted = () =>
              attention.invalidate(
                request.id,
                'Permission request cancelled by adapter',
              );
            signal.addEventListener('abort', aborted, { once: true });
            slot.awaiting++;
            try {
              const decision = await request.decision;
              if (
                decision.kind === 'cancelled' ||
                slot.epoch !== epoch ||
                signal.aborted ||
                slot.snapshot.state.kind !== 'running'
              )
                return { outcome: { outcome: 'cancelled' } };
              const optionId = optionIds.get(decision.choiceId);
              if (!optionId) return { outcome: { outcome: 'cancelled' } };
              return { outcome: { outcome: 'selected', optionId } };
            } finally {
              slot.awaiting--;
              slot.activeAt = Date.now();
              signal.removeEventListener('abort', aborted);
            }
          },
        )
        .connect(streamFor(slot, managed));
      slot.connection = connection;
      void connection.closed
        .then(() => interrupt(slot, 'ACP transport closed'))
        .catch(() => interrupt(slot, 'ACP transport failed'));
      const init = await deadline(
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: { name: 'agent-workbench', version: '0.1.0' },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
        15_000,
      );
      if (init.protocolVersion !== acp.PROTOCOL_VERSION)
        throw new Error('Adapter negotiated an unsupported protocol version');
      slot.authMethods = (init.authMethods ?? []).map((method) => ({
        id: method.id,
        label: safeText(method.name),
      }));
      const capabilities = {
        protocolVersion: init.protocolVersion,
        agent: safeText(init.agentInfo?.name ?? launch.provider),
        version: safeText(init.agentInfo?.version ?? 'unknown'),
        loadSessionAdvertised: init.agentCapabilities?.loadSession === true,
        clientFilesystem: false,
        clientTerminal: false,
        structuredQuestions: false,
        resumeImplemented: false,
      } as const;
      slot.snapshot = { ...slot.snapshot, capabilities };
      emit(slot, { type: 'capabilities', capabilities });
      await newSession(slot);
      return structuredClone(slot.snapshot);
    } catch (error) {
      attention.invalidate(id, 'Run startup failed', { includeRequests: true });
      if (!terminal(slot.snapshot.state) && !cancelling(slot))
        setState(slot, { kind: 'failed', reason: errorText(error) });
      await clean(slot);
      throw error;
    }
  }
  function acceptPrompt(id: RunId, text: string) {
    const slot = get(id);
    if (
      slot.snapshot.state.kind !== 'idle' ||
      !slot.connection ||
      !slot.sessionId
    )
      throw new Error('Run must be idle; live steering is not implemented');
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000)
      throw new Error('Prompt must contain 1–100000 characters');
    setState(slot, { kind: 'running' });
    slot.tools.clear();
    emit(slot, { type: 'turn.start', text: safeText(text) });
    if (slot.snapshot.worktree) recordTree(slot, undefined);
    return { slot, epoch: slot.epoch };
  }
  /**
   * Settles with the turn, or rejects once the agent has done nothing for
   * `idleTurnMs`. A permission decision the person owes stops the clock.
   */
  function whileActive<T>(slot: Slot, task: Promise<T>): Promise<T> {
    slot.activeAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      const check = () => {
        if (slot.awaiting > 0) slot.activeAt = Date.now();
        const left = slot.activeAt + idleTurnMs - Date.now();
        if (left > 0) timer = setTimeout(check, left);
        else reject(new Error(`No agent activity for ${duration(idleTurnMs)}`));
      };
      timer = setTimeout(check, idleTurnMs);
    });
    return Promise.race([task, idle]).finally(() => clearTimeout(timer));
  }
  async function runPrompt(
    slot: Slot,
    text: string,
    epoch: number,
    context?: string,
  ) {
    const id = slot.snapshot.id;
    try {
      await slot.progress?.beginTurn();
      if (epoch !== slot.epoch) return { stopReason: 'cancelled' };
      if (!slot.connection || !slot.sessionId)
        throw new Error('Run connection is unavailable');
      const task = slot.connection.agent.request(
        acp.methods.agent.session.prompt,
        {
          sessionId: slot.sessionId,
          prompt: [
            // Provider slash commands are dispatched from the first block.
            { type: 'text', text },
            ...(context ? [{ type: 'text' as const, text: context }] : []),
            ...(slot.progress
              ? [{ type: 'text' as const, text: workbenchInstructions }]
              : []),
          ],
        },
      );
      slot.promptTask = task;
      const result = await whileActive(slot, task);
      await slot.progress?.endTurn();
      if (epoch !== slot.epoch) return { stopReason: 'cancelled' };
      attention.invalidate(id, 'Prompt turn ended');
      emit(slot, { type: 'turn.end', reason: result.stopReason });
      if (!terminal(slot.snapshot.state)) setState(slot, { kind: 'idle' });
      void measure(slot);
      return { stopReason: result.stopReason };
    } catch (error) {
      if (cancelling(slot)) return { stopReason: 'cancelled' };
      try {
        attention.invalidate(id, 'Prompt interrupted');
        if (!terminal(slot.snapshot.state))
          setState(slot, { kind: 'interrupted', reason: errorText(error) });
      } finally {
        await clean(slot);
      }
      throw error;
    } finally {
      slot.promptTask = null;
    }
  }
  const execution: Execution = {
    async start(input) {
      const { slot, launch } = reserve(input);
      return initialize(slot, launch);
    },
    launch(input) {
      const { slot, launch } = reserve(input);
      void initialize(slot, launch).catch(() => {});
      return structuredClone(slot.snapshot);
    },
    async authenticate(id, methodId) {
      const slot = get(id);
      if (
        slot.snapshot.state.kind !== 'authentication-required' ||
        !slot.connection
      )
        throw new Error('Run does not need authentication');
      if (!slot.authMethods.some((method) => method.id === methodId))
        throw new Error('Unsupported authentication method');
      setState(slot, { kind: 'starting' });
      try {
        await deadline(
          slot.connection.agent.request(acp.methods.agent.authenticate, {
            methodId,
          }),
          120_000,
        );
        await newSession(slot);
      } catch (error) {
        if (!terminal(slot.snapshot.state) && !cancelling(slot))
          setState(slot, { kind: 'failed', reason: errorText(error) });
        await clean(slot);
        throw error;
      }
      return structuredClone(slot.snapshot);
    },
    async prompt(id, text) {
      const { slot, epoch } = acceptPrompt(id, text);
      return runPrompt(slot, text, epoch);
    },
    submit(id, text, context) {
      if (
        context !== undefined &&
        (typeof context !== 'string' || context.length > 12_000)
      )
        throw new Error('Run context must contain at most 12000 characters');
      const { slot, epoch } = acceptPrompt(id, text);
      void runPrompt(slot, text, epoch, context).catch(() => {});
    },
    async cancel(id) {
      const slot = get(id);
      if (slot.cancelTask) {
        await slot.cancelTask;
        return structuredClone(slot.snapshot);
      }
      slot.dismissed = true;
      slot.cancelTask = Promise.resolve().then(async () => {
        if (
          slot.snapshot.state.kind === 'closed' ||
          slot.snapshot.state.kind === 'cancelled'
        ) {
          slot.epoch++;
          try {
            await clean(slot);
            await release(slot);
          } finally {
            slot.cancelTask = null;
          }
          return;
        }
        slot.epoch++;
        attention.invalidate(id, 'Run cancelled', { includeRequests: true });
        setState(slot, { kind: 'cancelling' });
        try {
          if (slot.connection && slot.sessionId) {
            await deadline(
              slot.connection.agent.notify(acp.methods.agent.session.cancel, {
                sessionId: slot.sessionId,
              }),
              1000,
            ).catch(() => {});
            if (slot.promptTask)
              await deadline(slot.promptTask, 1000).catch(() => {});
          }
          await clean(slot);
          if (!isClosed(slot)) setState(slot, { kind: 'cancelled' });
          await release(slot);
        } catch (error) {
          setState(slot, {
            kind: 'interrupted',
            reason: 'Managed environment cleanup failed: ' + errorText(error),
          });
          throw error;
        } finally {
          slot.cancelTask = null;
        }
      });
      await slot.cancelTask;
      return structuredClone(slot.snapshot);
    },
    async commitWorkspace(id, message) {
      const slot = get(id);
      if (closing) throw new Error('Execution is closing');
      if (slot.cancelTask) await slot.cancelTask;
      if (!terminal(slot.snapshot.state) || !slot.stopped)
        throw new Error('Close this Run before committing its worktree');
      const worktree = slot.managed?.worktree;
      if (!worktree) throw new Error('This Run has no managed Git worktree');
      slot.epoch++;
      recordWorktree(slot, await worktree.commit(message));
      slot.dismissed = true;
      await release(slot);
      return structuredClone(slot.snapshot);
    },
    async createCandidate(id) {
      const slot = get(id);
      if (closing) throw new Error('Execution is closing');
      const worktree = slot.managed?.worktree;
      if (!worktree)
        throw new Error('Checks need a Run with a local Git worktree');
      const epoch = slot.treeEpoch;
      const frozen = await worktree.freeze(`refs/workbench/candidates/${id}`);
      // During a turn the files may change again, so the content stays unknown.
      if (epoch === slot.treeEpoch && slot.snapshot.state.kind !== 'running')
        recordTree(slot, frozen.tree);
      return {
        runId: id,
        ...frozen,
        createdAt: new Date().toISOString(),
      } satisfies Candidate;
    },
    startCheck(id, candidate, command) {
      const slot = get(id);
      if (closing) throw new Error('Execution is closing');
      const worktree = slot.managed?.worktree;
      if (!worktree)
        throw new Error('Checks need a Run with a local Git worktree');
      if (candidate.runId !== id)
        throw new Error('This Candidate belongs to another Run');
      const text = typeof command === 'string' ? command.trim() : '';
      if (!text || text.length > 1000 || text.includes('\0'))
        throw new Error('Enter a check command between 1 and 1000 characters');
      if (slot.check)
        throw new Error('Checks are already running for this Run');
      const abort = new AbortController();
      const startedAt = new Date().toISOString();
      const started = Date.now();
      emit(slot, {
        type: 'check.start',
        command: safeText(text),
        candidate: candidate.sha,
      });
      const task = (async (): Promise<CheckResult> => {
        let run: CheckRun;
        try {
          const checkout = await worktree.checkout(candidate.sha);
          try {
            run = await runCheck(checkout.path, text, {
              timeoutMs: 10 * 60_000,
              signal: abort.signal,
            });
          } finally {
            await checkout.release().catch((error: unknown) =>
              emit(slot, {
                type: 'diagnostic',
                message: 'Check checkout cleanup failed: ' + errorText(error),
              }),
            );
          }
        } catch (error) {
          run = {
            outcome: 'failed-to-start',
            exitCode: null,
            output: errorText(error),
            truncated: false,
          };
        }
        const result: CheckResult = {
          command: text,
          candidate: candidate.sha,
          ...run,
          output: redact(run.output),
          startedAt,
          durationMs: Date.now() - started,
        };
        const { startedAt: _startedAt, ...ended } = result;
        emit(slot, { type: 'check.end', ...ended, command: safeText(text) });
        return result;
      })().finally(() => {
        slot.check = null;
      });
      slot.check = { abort, task };
      return task;
    },
    snapshot(id) {
      return structuredClone(get(id).snapshot);
    },
    list() {
      return [...slots.values()].map((slot) => structuredClone(slot.snapshot));
    },
    async listDirectory(id, input = '') {
      const path = directoryPathSchema.parse(input);
      const slot = get(id);
      const epoch = slot.epoch;
      const managed = slot.managed;
      const unavailable = (reason: string) => ({
        kind: 'unavailable' as const,
        runId: id,
        path,
        reason,
      });
      const retained =
        slot.snapshot.worktree &&
        ['commit-required', 'retained'].includes(
          slot.snapshot.worktree.status.kind,
        );
      if (
        closing ||
        (terminal(slot.snapshot.state) && !retained) ||
        isStopping(slot)
      )
        return unavailable('This Run workspace is no longer active');
      if (!managed) return unavailable('Workspace is still starting');
      if (
        !['local', 'trusted-fixture-directory'].includes(
          managed.environment.kind,
        )
      )
        return unavailable(
          'Folder browsing is unavailable for this environment',
        );
      try {
        const listing = await readWorkspaceDirectory(managed.cwd, id, path);
        return epoch === slot.epoch &&
          !closing &&
          (!terminal(slot.snapshot.state) || retained) &&
          !isStopping(slot) &&
          slot.snapshot.worktree?.status.kind !== 'removed'
          ? listing
          : unavailable('This Run workspace is no longer active');
      } catch {
        return unavailable('Cannot read this folder; links are not expanded');
      }
    },
    events(after) {
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0))
        throw new Error('Invalid event cursor');
      if (after !== undefined && journal[0] && after < journal[0].sequence - 1)
        throw new Error(
          'Event cursor expired; get fresh snapshots before replay',
        );
      return journal
        .filter((event) => after === undefined || event.sequence > after)
        .map((event) => structuredClone(event));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closeTask) return closeTask;
      closing = true;
      closeTask = (async () => {
        const results = await Promise.allSettled(
          [...slots.values()].map(async (slot) => {
            slot.epoch++;
            try {
              attention.invalidate(slot.snapshot.id, 'Execution closed', {
                includeRequests: true,
              });
              if (!terminal(slot.snapshot.state))
                setState(slot, { kind: 'closed' });
            } finally {
              await clean(slot);
            }
          }),
        );
        // Checks were cancelled by cleanup; wait for their checkouts to go.
        await Promise.allSettled(
          [...slots.values()].flatMap((slot) =>
            slot.check ? [slot.check.task] : [],
          ),
        );
        unsubscribe();
        closed = true;
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (errors.length)
          throw new AggregateError(
            errors,
            `Some managed environments could not be removed: ${errors.map(errorText).join('; ')}`,
          );
      })();
      return closeTask;
    },
  };
  return execution;
}

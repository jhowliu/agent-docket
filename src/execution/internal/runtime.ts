import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { AttentionId, Choice } from '../../attention/index.js';
import type {
  Execution,
  ExecutionOptions,
  Launch,
  RunEvent,
  RunEventPayload,
  RunId,
  RunSnapshot,
  RunState,
  Worker,
} from '../index.js';
import { launchManaged } from './worker.js';
import type { ManagedProcess } from './worker.js';

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
  promptTask: Promise<acp.PromptResponse> | null;
  cancelTask: Promise<void> | null;
  cleanup: Promise<void> | null;
};
const terminal = (state: RunState) =>
  ['cancelled', 'closed', 'failed', 'interrupted'].includes(state.kind);
const cancelling = (slot: Slot) =>
  ['cancelling', 'cancelled'].includes(slot.snapshot.state.kind);
const isClosed = (slot: Slot) => slot.snapshot.state.kind === 'closed';
function safeText(text: string): string {
  return text
    .slice(0, 8000)
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]{12,}|Bearer\s+[a-zA-Z0-9._-]{12,})\b/g,
      '[redacted]',
    );
}
const errorText = (error: unknown) =>
  safeText(error instanceof Error ? error.message : String(error));
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
export function createExecution(options: ExecutionOptions): Execution {
  const { attention } = options;
  const maxEvents = options.maxEvents ?? 2000;
  if (!Number.isInteger(maxEvents) || maxEvents < 5 || maxEvents > 10000)
    throw new Error('maxEvents must be between 5 and 10000');
  const slots = new Map<RunId, Slot>();
  const listeners = new Set<(event: RunEvent) => void>();
  const journal: RunEvent[] = [];
  let sequence = 0;
  let closing = false;
  function emit(slot: Slot, payload: RunEventPayload): void {
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
  function interrupt(slot: Slot, reason: string): void {
    if (
      terminal(slot.snapshot.state) ||
      slot.snapshot.state.kind === 'cancelling'
    )
      return;
    slot.epoch++;
    attention.invalidate(slot.snapshot.id, reason);
    setState(slot, { kind: 'interrupted', reason });
    void clean(slot).catch((error: unknown) =>
      emit(slot, {
        type: 'diagnostic',
        message: 'Managed environment cleanup failed: ' + errorText(error),
      }),
    );
  }
  async function clean(slot: Slot): Promise<void> {
    if (!slot.cleanup)
      slot.cleanup = (async () => {
        attention.invalidate(slot.snapshot.id, 'Run environment closed');
        slot.connection?.close();
        const managed =
          slot.managed ?? (await slot.launchTask?.catch(() => null));
        await managed?.stop();
      })().catch((error: unknown) => {
        slot.cleanup = null;
        throw error;
      });
    return slot.cleanup;
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
      emit(slot, {
        type: 'tool',
        id: update.toolCallId,
        title: safeText(update.title ?? 'Tool update'),
        status: update.status ?? 'unknown',
      });
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
          mcpServers: [],
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
        label: launch.label ?? launch.provider,
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
      promptTask: null,
      cancelTask: null,
      cleanup: null,
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
      if (closing || terminal(slot.snapshot.state) || cancelling(slot))
        throw new Error('Run startup was cancelled');
      if (managed.environment.kind === 'local')
        emit(slot, {
          type: 'diagnostic',
          message:
            'Local process: no OS isolation. The code copy is retained when this Run stops.',
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
              choices,
            });
            slot.responses.set(requestId, request.id);
            const aborted = () =>
              attention.invalidate(
                request.id,
                'Permission request cancelled by adapter',
              );
            signal.addEventListener('abort', aborted, { once: true });
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
        label: method.name,
      }));
      const capabilities = {
        protocolVersion: init.protocolVersion,
        agent: init.agentInfo?.name ?? launch.provider,
        version: init.agentInfo?.version ?? 'unknown',
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
      attention.invalidate(id, 'Run startup failed');
      if (!terminal(slot.snapshot.state) && !cancelling(slot))
        setState(slot, { kind: 'failed', reason: errorText(error) });
      await clean(slot);
      throw error;
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
      const epoch = slot.epoch;
      try {
        const task = slot.connection.agent.request(
          acp.methods.agent.session.prompt,
          { sessionId: slot.sessionId, prompt: [{ type: 'text', text }] },
        );
        slot.promptTask = task;
        const result = await deadline(task, 10 * 60_000);
        if (epoch !== slot.epoch) return { stopReason: 'cancelled' };
        attention.invalidate(id, 'Prompt turn ended');
        emit(slot, { type: 'turn.end', reason: result.stopReason });
        if (!terminal(slot.snapshot.state)) setState(slot, { kind: 'idle' });
        return { stopReason: result.stopReason };
      } catch (error) {
        if (cancelling(slot)) return { stopReason: 'cancelled' };
        attention.invalidate(id, 'Prompt interrupted');
        if (!terminal(slot.snapshot.state))
          setState(slot, { kind: 'interrupted', reason: errorText(error) });
        await clean(slot);
        throw error;
      } finally {
        slot.promptTask = null;
      }
    },
    async cancel(id) {
      const slot = get(id);
      if (slot.cancelTask) return slot.cancelTask;
      slot.cancelTask = Promise.resolve().then(async () => {
        if (
          slot.snapshot.state.kind === 'closed' ||
          slot.snapshot.state.kind === 'cancelled'
        )
          return;
        slot.epoch++;
        attention.invalidate(id, 'Run cancelled');
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
      return slot.cancelTask;
    },
    snapshot(id) {
      return structuredClone(get(id).snapshot);
    },
    list() {
      return [...slots.values()].map((slot) => structuredClone(slot.snapshot));
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
    async close() {
      closing = true;
      const results = await Promise.allSettled(
        [...slots.values()].map(async (slot) => {
          slot.epoch++;
          attention.invalidate(slot.snapshot.id, 'Execution closed');
          if (!terminal(slot.snapshot.state))
            setState(slot, { kind: 'closed' });
          await clean(slot);
        }),
      );
      unsubscribe();
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(
          errors,
          'Some managed environments could not be removed',
        );
    },
  };
  return execution;
}

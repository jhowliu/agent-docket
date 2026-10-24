import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Trusted deterministic protocol peer, not a model or OS sandbox.
const sessions = new Map();
let counter = 0;
const app = agent({ name: 'workbench-fixture' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'workbench-fixture', version: '1.0.0' },
    agentCapabilities: { loadSession: false },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      cwd: params.cwd,
      abort: null,
      mcpServers: params.mcpServers,
    });
    return { sessionId };
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.abort?.abort();
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error('Unknown fixture session');
    const abort = new AbortController();
    session.abort = abort;
    const update = (update) =>
      client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update,
      });
    const message = (text) =>
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      });
    // Codex dispatches slash commands from the first prompt block.
    const first = params.prompt[0];
    const text = first?.type === 'text' ? first.text : '';
    if (text === 'task-context') {
      await message(
        params.prompt
          .slice(1)
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n'),
      );
      return { stopReason: 'end_turn' };
    }
    if (
      text === '/mcp' ||
      text === 'progress' ||
      text.startsWith('progress:') ||
      text === 'progress-wait' ||
      text.startsWith('done:') ||
      text.startsWith('needs:')
    ) {
      const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/stdio.js'),
      ]);
      const configured = session.mcpServers.find(
        (server) => server.name === 'workbench_progress',
      );
      if (!configured || !('command' in configured))
        throw new Error('Fixture progress tool missing');
      const transport = new StdioClientTransport({
        command: configured.command,
        args: configured.args,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([, value]) => value !== undefined,
            ),
          ),
          ...Object.fromEntries(
            configured.env.map(({ name, value }) => [name, value]),
          ),
        },
        stderr: 'pipe',
      });
      const progress = new Client({
        name: 'workbench-fixture',
        version: '1.0.0',
      });
      try {
        await progress.connect(transport);
        const tools = await progress.listTools();
        if (!tools.tools.some((tool) => tool.name === 'report_progress'))
          throw new Error('Fixture could not discover progress reporting');
        if (text.startsWith('needs:')) {
          // needs:<JSON request or array of requests>, sent as given.
          const input = JSON.parse(text.slice(6));
          const outcomes = [];
          for (const request of Array.isArray(input) ? input : [input]) {
            const result = await progress.callTool({
              name: 'request_user',
              arguments: request,
            });
            outcomes.push(result.isError ? 'rejected' : 'recorded');
          }
          await message(
            `Request ${outcomes.join(', ')}. Restart the panel with --write, then reply here.`,
          );
          return { stopReason: 'end_turn' };
        }
        if (text === '/mcp') {
          await message(
            'workbench_progress: ' +
              tools.tools.map((tool) => tool.name).join(', '),
          );
          return { stopReason: 'end_turn' };
        }
        // done:<summary> reports the work finished.
        const finished = text.startsWith('done:');
        const summary = text.startsWith('progress:')
          ? text.slice(9)
          : finished
            ? text.slice(5)
            : 'Located the theme configuration and its entry point. I am checking how the setting reaches the rendered page; no changes have been made yet.';
        const result = await progress.callTool({
          name: 'report_progress',
          arguments: finished ? { summary, finished: true } : { summary },
        });
        await message(
          result.isError
            ? 'Progress report rejected.'
            : 'Progress report submitted. Full conversation remains here.',
        );
        if (text === 'progress-wait' && !abort.signal.aborted)
          await new Promise((resolve) =>
            abort.signal.addEventListener('abort', resolve, { once: true }),
          );
      } finally {
        await progress.close();
      }
      return { stopReason: abort.signal.aborted ? 'cancelled' : 'end_turn' };
    }
    if (text === 'crash') process.exit(17);
    if (text === 'question') {
      await message('What name should this check use? Reply in the next turn.');
      return { stopReason: 'end_turn' };
    }
    if (text === 'stream') {
      for (const chunk of ['sum', 'marize', ' its', ' pur', 'pose', '.']) {
        if (abort.signal.aborted) break;
        await message(chunk);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { stopReason: abort.signal.aborted ? 'cancelled' : 'end_turn' };
    }
    if (text === 'wait') {
      await message('Fixture is waiting for cancellation.');
      if (!abort.signal.aborted)
        await new Promise((resolve) =>
          abort.signal.addEventListener('abort', resolve, { once: true }),
        );
      await message('Cancellation received.');
      return { stopReason: 'cancelled' };
    }
    if (text === 'exit-idle') {
      await message('Fixture will exit after this turn.');
      setTimeout(() => process.exit(17), 40);
      return { stopReason: 'end_turn' };
    }
    if (text === 'unsupported-files') {
      try {
        await client.request(methods.client.fs.readTextFile, {
          sessionId: params.sessionId,
          path: '/etc/passwd',
        });
        await message('ERROR: unexpected host file capability');
      } catch {
        await message('Client filesystem callback rejected as expected.');
      }
      return { stopReason: 'end_turn' };
    }
    if (text === 'command-permission') {
      // Shaped like the pinned Codex adapter: a JSON-encoded `bash -lc` command.
      const allow = `opaque-allow-${randomUUID()}`;
      const result = await client.request(
        methods.client.session.requestPermission,
        {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: `tool-${++counter}-command`,
            title: 'Run command',
            kind: 'execute',
            status: 'pending',
            rawInput: {
              command: JSON.stringify([
                'bash',
                '-lc',
                'npm test -- --watch=false',
              ]),
              cwd: session.cwd,
            },
          },
          options: [
            { optionId: allow, name: 'Yes, proceed', kind: 'allow_once' },
            {
              optionId: `opaque-reject-${randomUUID()}`,
              name: 'No, and tell Codex what to do differently',
              kind: 'reject_once',
            },
          ],
        },
      );
      await message(
        result.outcome.outcome === 'selected' &&
          result.outcome.optionId === allow
          ? 'Command allowed.'
          : 'Command not run.',
      );
      return { stopReason: 'end_turn' };
    }
    if (text.startsWith('reply:')) {
      await message('Answer received: ' + text.slice(6));
      return { stopReason: 'end_turn' };
    }
    const permission = async (suffix) => {
      const toolCallId = `tool-${++counter}-${suffix}`;
      await update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Fix token expiry boundary ' + suffix,
        kind: 'edit',
        status: 'pending',
      });
      const optionId = `opaque-allow-${randomUUID()}`;
      const rejectId = `opaque-reject-${randomUUID()}`;
      const result = await client.request(
        methods.client.session.requestPermission,
        {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId,
            title: 'Edit fixture token.mjs',
            kind: 'edit',
            status: 'pending',
          },
          options: [
            { optionId, name: 'Allow once', kind: 'allow_once' },
            { optionId: rejectId, name: 'Reject once', kind: 'reject_once' },
          ],
        },
      );
      if (abort.signal.aborted || result.outcome.outcome === 'cancelled')
        return false;
      const allowed = result.outcome.optionId === optionId;
      if (
        result.outcome.optionId !== optionId &&
        result.outcome.optionId !== rejectId
      )
        throw new Error('Wrong provider option correlation');
      if (allowed) {
        const path = join(session.cwd, 'token.mjs');
        const oldText = await readFile(path, 'utf8');
        const newText = oldText.replace('expiry < now', 'expiry <= now');
        await writeFile(path, newText);
        await update({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          content: [{ type: 'diff', path, oldText, newText }],
        });
      } else
        await update({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
        });
      await message(
        allowed
          ? 'Fixture edit complete; this is not model-generated verification.'
          : 'Rejected; fixture was not changed.',
      );
      return allowed;
    };
    await message('Starting deterministic ACP fixture; no model connected.');
    if (text === 'two-permissions')
      await Promise.all([permission('one'), permission('two')]);
    else await permission('single');
    return { stopReason: abort.signal.aborted ? 'cancelled' : 'end_turn' };
  });
app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commandSchema } from './workbench-protocol.js';
import { createAttention } from '../attention/index.js';
import { createExecution, parseLaunch } from '../execution/index.js';
import type { Launch } from '../execution/index.js';
import { launchFingerprint } from './launch-config.js';

const assets: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'runtime.html', type: 'text/html; charset=utf-8' },
  '/runtime.html': { file: 'runtime.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/runtime.css': { file: 'runtime.css', type: 'text/css; charset=utf-8' },
  '/runtime.js': { file: 'runtime.js', type: 'text/javascript; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/services.js': {
    file: 'services.js',
    type: 'text/javascript; charset=utf-8',
  },
};

function previewDirectory(): URL {
  for (const relative of ['../../preview/', '../../../preview/']) {
    const path = new URL(relative, import.meta.url);
    if (existsSync(new URL('runtime.html', path))) return path;
  }
  throw new Error('Workbench UI assets missing');
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

/** Browser transport/composition only. All Run and permission rules stay in their domains. */
export function createWebWorkbench(
  origin: string,
  options: { onShutdown?: () => void; launch?: Launch } = {},
) {
  const address = new URL(origin);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1')
    throw new Error('The test workbench must use an HTTP loopback origin');
  const token = randomBytes(32).toString('hex');
  const instanceId = randomBytes(16).toString('hex');
  const attention = createAttention();
  const execution = createExecution({ attention });
  const directory = previewDirectory();
  const launch = parseLaunch(options.launch ?? { provider: 'fixture' });
  const configurationId = launchFingerprint(launch);
  const source =
    launch.provider === 'fixture' || launch.source.kind === 'fixture'
      ? fileURLToPath(new URL('../fixtures/project/', directory))
      : launch.source.kind === 'directory'
        ? launch.source.path
        : `${launch.source.url}@${launch.source.revision}`;
  let closing = false;
  let closingTask: Promise<void> | null = null;
  let launchPending = false;
  let counter = 0;

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== address.origin)
      return json({ error: 'Unknown host' }, 403);
    if (request.headers.get('sec-fetch-site') === 'cross-site')
      return json({ error: 'Cross-site requests are not allowed' }, 403);
    if (closing) return json({ error: 'Workbench is stopping' }, 503);

    if (request.method === 'GET' && url.pathname === '/api/state') {
      const rawCursor = url.searchParams.get('after') ?? '0';
      if (!/^\d{1,12}$/.test(rawCursor))
        return json({ error: 'Invalid cursor' }, 400);
      const after = Number(rawCursor);
      let reset = after === 0;
      let events;
      try {
        events = execution.events(after);
      } catch {
        events = execution.events();
        reset = true;
      }
      const latest = execution.events().at(-1)?.sequence ?? 0;
      if (after > latest) {
        events = execution.events();
        reset = true;
      }
      return json({
        instanceId,
        runs: execution.list(),
        attention: attention.list(),
        events,
        cursor: latest,
        reset,
        source,
        configurationId,
        launch: {
          provider: launch.provider,
          kind:
            launch.provider === 'fixture'
              ? 'trusted-fixture-directory'
              : launch.worker.transport,
        },
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/commands') {
      if (
        request.headers.get('x-workbench-token') !== token ||
        (request.headers.has('origin') &&
          request.headers.get('origin') !== address.origin)
      )
        return json(
          { error: 'Reload this workbench before sending a command' },
          403,
        );
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        return json({ error: 'Expected application/json' }, 415);
      const text = await request.text();
      if (Buffer.byteLength(text) > 8192)
        return json({ error: 'Command is too large' }, 413);
      let input: unknown;
      try {
        input = JSON.parse(text);
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      const parsed = commandSchema.safeParse(input);
      if (!parsed.success)
        return json({ error: 'Invalid workbench command' }, 400);
      const command = parsed.data;
      try {
        if (command.kind === 'shutdown') {
          if (!options.onShutdown)
            return json(
              { error: 'This server does not support shutdown' },
              409,
            );
          setImmediate(options.onShutdown);
          return json({ result: 'accepted' }, 202);
        }
        if (command.kind === 'start') {
          if (launchPending)
            return json({ error: 'A Run is already starting' }, 409);
          // Bound both retained history and concurrent child processes in this test UI.
          if (execution.list().length >= 20)
            return json(
              {
                error:
                  '20 Runs reached; restart the test server for a fresh session',
              },
              409,
            );
          if (
            execution
              .list()
              .filter((run) =>
                [
                  'starting',
                  'idle',
                  'running',
                  'cancelling',
                  'authentication-required',
                ].includes(run.state.kind),
              ).length >= 4
          )
            return json(
              {
                error:
                  '4 active Runs reached; cancel one before starting another',
              },
              409,
            );
          launchPending = true;
          try {
            const run =
              launch.provider === 'fixture'
                ? await execution.start({
                    ...launch,
                    label: launch.label ?? `fixture / run-${++counter}`,
                  })
                : execution.launch({
                    ...launch,
                    label:
                      launch.label ?? `${launch.provider} / run-${++counter}`,
                  });
            return json({ runId: run.id }, 201);
          } finally {
            launchPending = false;
          }
        }
        if (command.kind === 'answer') {
          const id = attention
            .list()
            .find((item) => item.id === command.id)?.id;
          if (!id) return json({ error: 'Unknown attention item' }, 404);
          const result = attention.answer(id, command.choiceId);
          return json({ result }, result === 'accepted' ? 202 : 409);
        }
        const id = execution.list().find((run) => run.id === command.runId)?.id;
        if (!id) return json({ error: 'Unknown Run' }, 404);
        if (command.kind === 'cancel') {
          await execution.cancel(id);
          return json({ result: 'cancelled' });
        }
        if (command.kind === 'authenticate') {
          const state = execution.snapshot(id).state;
          if (
            state.kind !== 'authentication-required' ||
            !state.methods.some((method) => method.id === command.methodId)
          )
            return json(
              { error: 'Select an advertised sign-in method for this Run' },
              409,
            );
          void execution.authenticate(id, command.methodId).catch(() => {});
          return json({ result: 'accepted' }, 202);
        }
        if (execution.snapshot(id).state.kind !== 'idle')
          return json(
            { error: 'This Run must be idle before accepting a new prompt' },
            409,
          );
        // Do not hold the request open while the prompt waits for an approval.
        // Execution records asynchronous failures and owns cancellation/cleanup.
        void execution.prompt(id, command.text).catch(() => {});
        return json({ result: 'accepted' }, 202);
      } catch (error: unknown) {
        return json(
          { error: error instanceof Error ? error.message : 'Command failed' },
          409,
        );
      }
    }

    if (url.pathname.startsWith('/api/'))
      return json({ error: 'Unknown endpoint or method' }, 404);
    const asset = assets[url.pathname];
    if (request.method !== 'GET' || !asset)
      return json({ error: 'Not found' }, 404);
    let body = await readFile(new URL(asset.file, directory), 'utf8');
    if (asset.file === 'runtime.html')
      body = body.replace('content="WORKBENCH_TOKEN"', `content="${token}"`);
    return new Response(body, { headers: { 'content-type': asset.type } });
  }

  return {
    async fetch(request: Request): Promise<Response> {
      let response: Response;
      try {
        response = await route(request);
      } catch {
        response = json(
          { error: 'Workbench request failed; reload to retry' },
          500,
        );
      }
      response.headers.set('cache-control', 'no-store');
      response.headers.set('x-content-type-options', 'nosniff');
      response.headers.set('referrer-policy', 'no-referrer');
      response.headers.set(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      return response;
    },
    close(): Promise<void> {
      closing = true;
      closingTask ??= execution.close();
      return closingTask;
    },
  };
}

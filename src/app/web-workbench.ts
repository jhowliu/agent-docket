import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  changesRequestSchema,
  commandSchema,
  directoryRequestSchema,
  projectRequestSchema,
  initializeProjectRequestSchema,
  sessionOptionsSchema,
} from './workbench-protocol.js';
import { createAttention } from '../attention/index.js';
import {
  createExecution,
  parseLaunch,
  inspectLocalProject,
  initializeLocalProject,
  ProjectInitializationRequired,
  listProjectFolders,
} from '../execution/index.js';
import type { Execution, Launch, LocalWorker } from '../execution/index.js';
import { describeChange } from '../delivery/index.js';
import type { ChangeMap } from '../delivery/index.js';
import { launchFingerprint } from './launch-config.js';
import { createProjectWorkspaces } from '../work/index.js';
import { basename, resolve } from 'node:path';

const assets: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'runtime.html', type: 'text/html; charset=utf-8' },
  '/runtime.html': { file: 'runtime.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/runtime.css': { file: 'runtime.css', type: 'text/css; charset=utf-8' },
  '/runtime.js': { file: 'runtime.js', type: 'text/javascript; charset=utf-8' },
  '/runtime-work.js': {
    file: 'runtime-work.js',
    type: 'text/javascript; charset=utf-8',
  },
  '/runtime-session.js': {
    file: 'runtime-session.js',
    type: 'text/javascript; charset=utf-8',
  },
  '/changes': { file: 'change-map.html', type: 'text/html; charset=utf-8' },
  '/change-map.js': {
    file: 'change-map.js',
    type: 'text/javascript; charset=utf-8',
  },
  '/change-map.css': {
    file: 'change-map.css',
    type: 'text/css; charset=utf-8',
  },
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
  options: {
    onShutdown?: () => void;
    launch?: Launch;
    maxEvents?: number;
    planDirectory?: string;
    /** Trusted settings only. Clients choose a project, never an executable/login/storage path. */
    localWorker?: LocalWorker;
    defaultProjectPath?: string;
  } = {},
) {
  const address = new URL(origin);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1')
    throw new Error('The test workbench must use an HTTP loopback origin');
  const token = randomBytes(32).toString('hex');
  const instanceId = randomBytes(16).toString('hex');
  const directory = previewDirectory();
  const launch = parseLaunch(options.launch ?? { provider: 'fixture' });
  const configurationId = launchFingerprint(launch);
  const changeTasks = new Map<string, Promise<ChangeMap>>();
  if ((options.maxEvents ?? 2000) > 2000)
    throw new Error('Workbench polling supports at most 2000 events');
  const attention = createAttention();
  let execution: Execution;
  try {
    execution = createExecution({
      attention,
      maxEvents: options.maxEvents ?? 2000,
    });
  } catch (error) {
    attention.close();
    throw error;
  }
  const source =
    launch.provider === 'fixture' || launch.source.kind === 'fixture'
      ? fileURLToPath(new URL('../fixtures/project/', directory))
      : launch.source.kind === 'directory'
        ? launch.source.path
        : `${launch.source.url}@${launch.source.revision}`;
  const work = createProjectWorkspaces({
    execution,
    ...(options.planDirectory ? { directory: options.planDirectory } : {}),
  });
  const defaultProjectId = work.register(
    launch.provider === 'fixture' || launch.source.kind === 'fixture'
      ? `fixture:${source}`
      : launch.source.kind === 'directory'
        ? `directory:${launch.source.path}`
        : `git:${launch.source.url}`,
    source,
  );
  const localWorker =
    launch.provider === 'codex' && launch.worker.transport === 'local'
      ? launch.worker
      : options.localWorker;
  const presets = [
    ...(localWorker
      ? [{ id: 'codex-local', label: 'Codex · local', kind: 'local' as const }]
      : []),
    ...(launch.provider !== 'fixture' &&
    !(
      launch.provider === 'codex' &&
      launch.worker.transport === 'local' &&
      launch.source.kind === 'directory'
    )
      ? [
          {
            id: 'configured',
            label: `${launch.provider} · configured`,
            kind: 'fixed' as const,
          },
        ]
      : []),
    { id: 'fixture', label: 'Fixture · no model', kind: 'fixture' as const },
  ];
  const sessionOptions = sessionOptionsSchema.parse({
    defaultPath: resolve(
      options.defaultProjectPath ??
        (launch.provider !== 'fixture' && launch.source.kind === 'directory'
          ? launch.source.path
          : process.cwd()),
    ),
    defaultPreset: localWorker
      ? 'codex-local'
      : launch.provider !== 'fixture'
        ? 'configured'
        : 'fixture',
    presets,
  });
  let closing = false;
  let closingTask: Promise<void> | null = null;
  let launchPending = false;
  let counter = execution.list().length;

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
      const projects = await work.snapshot();
      return json({
        instanceId,
        runs: execution.list(),
        attention: attention.list(),
        events,
        cursor: latest,
        reset,
        source,
        configurationId,
        work: projects.find((project) => project.id === defaultProjectId)?.work,
        projects,
        defaultProjectId,
        sessionOptions,
        features: {
          directoryTree: true,
          newSession: true,
          folderCompletion: true,
          projectInitialization: true,
          changeMap: true,
        },
        launch: {
          provider: launch.provider,
          kind:
            launch.provider === 'fixture'
              ? 'trusted-fixture-directory'
              : launch.worker.transport,
        },
      });
    }

    if (
      request.method === 'POST' &&
      (url.pathname === '/api/project' ||
        url.pathname === '/api/project/folders' ||
        url.pathname === '/api/project/initialize')
    ) {
      if (
        request.headers.get('x-workbench-token') !== token ||
        (request.headers.has('origin') &&
          request.headers.get('origin') !== address.origin)
      )
        return json({ error: 'Reconnect before choosing a project' }, 403);
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        return json({ error: 'Expected application/json' }, 415);
      const body = await request.text();
      if (Buffer.byteLength(body) > 16384)
        return json({ error: 'Project path is too large' }, 413);
      try {
        const input: unknown = JSON.parse(body);
        if (url.pathname === '/api/project/initialize') {
          const parsed = initializeProjectRequestSchema.safeParse(input);
          if (!parsed.success)
            return json(
              {
                error: 'Confirm the inspected project before initializing Git',
              },
              400,
            );
          return json(await initializeLocalProject(parsed.data.project));
        }
        const parsed = projectRequestSchema.safeParse(input);
        if (!parsed.success)
          return json({ error: 'Choose an absolute project folder' }, 400);
        return json(
          url.pathname === '/api/project/folders'
            ? await listProjectFolders(parsed.data.path)
            : await inspectLocalProject(parsed.data.path),
        );
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error ? error.message : 'Project is unavailable',
            ...(error instanceof ProjectInitializationRequired
              ? { initialization: error.project }
              : {}),
          },
          409,
        );
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/directory') {
      if (
        request.headers.get('x-workbench-token') !== token ||
        (request.headers.has('origin') &&
          request.headers.get('origin') !== address.origin)
      )
        return json({ error: 'Reconnect before browsing project files' }, 403);
      const parsed = directoryRequestSchema.safeParse({
        runId: url.searchParams.get('runId'),
        path: url.searchParams.get('path') ?? '',
      });
      if (!parsed.success)
        return json({ error: 'Invalid workspace directory' }, 400);
      try {
        const result = json(
          await execution.listDirectory(parsed.data.runId, parsed.data.path),
        );
        result.headers.set('cache-control', 'no-store');
        return result;
      } catch {
        return json({ error: 'Run workspace is unavailable' }, 404);
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/changes') {
      if (
        request.headers.get('x-workbench-token') !== token ||
        (request.headers.has('origin') &&
          request.headers.get('origin') !== address.origin)
      )
        return json({ error: 'Reconnect before opening the Change map' }, 403);
      const parsed = changesRequestSchema.safeParse({
        runId: url.searchParams.get('runId'),
        ...(url.searchParams.has('files')
          ? { files: url.searchParams.get('files') }
          : {}),
      });
      if (!parsed.success) return json({ error: 'Invalid Run' }, 400);
      const id = execution
        .list()
        .find((run) => run.id === parsed.data.runId)?.id;
      if (!id) return json({ error: 'Unknown Run' }, 404);
      // The checkout comes from execution's own Run record, never from the request.
      const worktree = execution.snapshot(id).worktree;
      if (!worktree)
        return json(
          { error: 'Change maps need a Run with a local Git worktree' },
          409,
        );
      if (worktree.status.kind === 'removed')
        return json(
          {
            error: `The worktree was removed; its commits stay on ${worktree.branch}`,
          },
          409,
        );
      // One analysis per Run and mode at a time; repeated opens share it.
      const filesOnly = parsed.data.files === 'only';
      const key = `${id}:${filesOnly ? 'files' : 'map'}`;
      let task = changeTasks.get(key);
      if (!task) {
        task = describeChange({
          directory: worktree.path,
          base: worktree.baseRevision,
          ...(filesOnly ? { analysis: false } : {}),
        }).finally(() => changeTasks.delete(key));
        changeTasks.set(key, task);
      }
      try {
        return json(await task);
      } catch {
        return json(
          { error: 'Change map is unavailable; retry after the Run settles' },
          409,
        );
      }
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
      if (Buffer.byteLength(text) > 32768)
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
        if ('expectedRevision' in command) {
          await work.apply(defaultProjectId, command);
          return json({ result: 'accepted' }, 202);
        }
        if (command.kind === 'project-work') {
          await work.apply(command.projectId, command.command);
          return json({ result: 'accepted' }, 202);
        }
        if (command.kind === 'shutdown') {
          if (!options.onShutdown)
            return json(
              { error: 'This server does not support shutdown' },
              409,
            );
          setImmediate(options.onShutdown);
          return json({ result: 'accepted' }, 202);
        }
        if (command.kind === 'start' || command.kind === 'new-session') {
          if (launchPending)
            return json({ error: 'A Run is already starting' }, 409);
          // Keep the current process's in-memory Run roster bounded.
          if (execution.list().length >= 64)
            return json(
              {
                error:
                  '64 Runs reached; restart the server for a fresh session',
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
            let selectedLaunch = launch;
            let projectId = defaultProjectId;
            if (command.kind === 'new-session') {
              const preset = presets.find(
                (preset) => preset.id === command.presetId,
              );
              if (!preset)
                throw new Error(
                  'Agent preset is unavailable; reopen New Session',
                );
              if (preset.kind === 'local') {
                if (!localWorker || !command.project)
                  throw new Error('Choose a Git project and starting branch');
                const base = command.project.base;
                const project = await inspectLocalProject(
                  command.project.path,
                  base,
                );
                selectedLaunch = {
                  provider: 'codex',
                  worker: localWorker,
                  source: { kind: 'directory', path: project.path, base },
                  label: basename(project.identityPath),
                };
                projectId = work.register(
                  `directory:${project.identityPath}`,
                  project.identityPath,
                );
              } else {
                if (command.project)
                  throw new Error(
                    'This agent preset uses its configured project',
                  );
                selectedLaunch =
                  preset.kind === 'fixture' ? { provider: 'fixture' } : launch;
                if (preset.kind === 'fixture') {
                  const fixture = fileURLToPath(
                    new URL('../fixtures/project/', directory),
                  );
                  projectId = work.register(`fixture:${fixture}`, fixture);
                }
              }
            }
            const run =
              selectedLaunch.provider === 'fixture'
                ? await execution.start({
                    ...selectedLaunch,
                    label: selectedLaunch.label ?? `fixture / run-${++counter}`,
                  })
                : execution.launch({
                    ...selectedLaunch,
                    label:
                      selectedLaunch.label ??
                      `${selectedLaunch.provider} / run-${++counter}`,
                  });
            work.associate(projectId, run.id);
            return json({ runId: run.id }, 201);
          } finally {
            launchPending = false;
          }
        }
        if (command.kind === 'complete-request') {
          const item = attention
            .list()
            .find((candidate) => candidate.id === command.id);
          if (!item) return json({ error: 'Unknown attention item' }, 404);
          if (item.kind !== 'agent-request')
            return json(
              { error: 'Only agent requests can be marked done' },
              409,
            );
          const result = attention.complete(item.id);
          if (result === 'done') return json({ result }, 202);
          return json(
            {
              error:
                result === 'already-done'
                  ? 'Already marked done'
                  : 'This request expired with its Run',
            },
            409,
          );
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
          const worktree = execution.snapshot(id).worktree;
          return json({
            result: 'cancelled',
            ...(worktree
              ? {
                  branch: worktree.branch,
                  workspaceRemoved: worktree.status.kind === 'removed',
                }
              : {}),
          });
        }
        if (command.kind === 'commit-workspace') {
          const { worktree } = await execution.commitWorkspace(
            id,
            command.message,
          );
          return json({
            result: 'accepted',
            ...(worktree
              ? {
                  branch: worktree.branch,
                  workspaceRemoved: worktree.status.kind === 'removed',
                }
              : {}),
          });
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
        await work.submit(id, command.text);
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
    if (asset.file === 'runtime.html' || asset.file === 'change-map.html')
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
      closingTask ??= work
        .close()
        .then(() => execution.close())
        .finally(() => attention.close());
      return closingTask;
    },
  };
}

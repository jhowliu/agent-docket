import { z } from 'zod';
import {
  changesRequestSchema,
  commandSchema,
  replySchema,
  stateSchema,
  workbenchOrigin,
  directoryRequestSchema,
  projectRequestSchema,
  initializeProjectRequestSchema,
} from './workbench-protocol.js';
import {
  directoryListingSchema,
  localProjectSchema,
  projectFoldersSchema,
  projectInitializationSchema,
  ProjectInitializationRequired,
} from '../execution/index.js';
import type {
  LocalProject,
  ProjectFolders,
  ProjectInitialization,
} from '../execution/index.js';
import type { RunId, DirectoryListing } from '../execution/index.js';
import type {
  WorkbenchCommand,
  WorkbenchReply,
  WorkbenchState,
} from './workbench-protocol.js';

export class WorkbenchError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'protocol' | 'rejected',
    message: string,
  ) {
    super(message);
  }
}

/** Local transport only: Run lifecycle and decision validity remain on the server. */
export function createWorkbenchClient(
  origin: string,
  request: (request: Request) => Promise<Response> = (input) => fetch(input),
) {
  const address = new URL(origin);
  if (
    address.protocol !== 'http:' ||
    address.hostname !== '127.0.0.1' ||
    address.origin !== origin
  )
    throw new Error('Workbench client requires an HTTP loopback origin');
  // Reject unusable ports before bootstrap can spawn a background server.
  workbenchOrigin(address.port);
  let token: string | null = null;
  let instance: string | null = null;
  let state: WorkbenchState | null = null;
  let polling: Promise<WorkbenchState> | null = null;

  async function send(
    path: string,
    options: RequestInit = {},
    timeout = 5000,
  ): Promise<Response> {
    try {
      return await request(
        new Request(origin + path, {
          ...options,
          signal: AbortSignal.timeout(timeout),
          redirect: 'error',
        }),
      );
    } catch {
      token = null;
      throw new WorkbenchError(
        'unavailable',
        'Cannot connect; retrying when the server is available',
      );
    }
  }
  async function readState(after: number): Promise<WorkbenchState> {
    const response = await send('/api/state?after=' + after);
    if (!response.ok)
      throw new WorkbenchError('unavailable', 'Server not ready; reconnecting');
    try {
      return stateSchema.parse(await response.json());
    } catch {
      token = null;
      throw new WorkbenchError(
        'protocol',
        'Incompatible server; check WORKBENCH_PORT',
      );
    }
  }
  async function connect(): Promise<WorkbenchState> {
    // Same bootstrap as the browser, including compatibility with the existing M0 server.
    token = null;
    const response = await send('/');
    const html = await response.text();
    const next = html.match(
      /name="workbench-token" content="([a-f0-9]{64})"/,
    )?.[1];
    if (!response.ok || !next)
      throw new WorkbenchError(
        'protocol',
        'This port is not Agent Workbench; check WORKBENCH_PORT',
      );
    const snapshot = await readState(0);
    instance = snapshot.instanceId ?? next;
    token = next;
    state = snapshot;
    return snapshot;
  }
  return {
    connect,
    async folders(path: string): Promise<ProjectFolders> {
      const query = projectRequestSchema.parse({ path });
      if (!token)
        throw new WorkbenchError(
          'unavailable',
          'Reconnect before browsing folders',
        );
      const response = await send('/api/project/folders', {
        method: 'POST',
        headers: {
          'x-workbench-token': token,
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify(query),
      });
      if (!response.ok) {
        const error = z
          .object({ error: z.string() })
          .safeParse(await response.json());
        throw new WorkbenchError(
          'rejected',
          error.success
            ? error.data.error
            : 'Folders are unavailable; retry the path',
        );
      }
      const listing = projectFoldersSchema.safeParse(await response.json());
      if (!listing.success || listing.data.input !== path)
        throw new WorkbenchError('protocol', 'Invalid folder response');
      return listing.data;
    },
    async project(path: string): Promise<LocalProject> {
      const query = projectRequestSchema.parse({ path });
      if (!token)
        throw new WorkbenchError(
          'unavailable',
          'Reconnect before choosing a project',
        );
      const response = await send('/api/project', {
        method: 'POST',
        headers: {
          'x-workbench-token': token,
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify(query),
      });
      if (!response.ok) {
        const body: unknown = await response.json();
        const initialization = z
          .object({ initialization: projectInitializationSchema })
          .safeParse(body);
        if (
          response.status === 409 &&
          initialization.success &&
          state?.features?.projectInitialization
        )
          throw new ProjectInitializationRequired(
            initialization.data.initialization,
          );
        const error = z.object({ error: z.string() }).safeParse(body);
        throw new WorkbenchError(
          'rejected',
          error.success
            ? error.data.error
            : 'Project is unavailable; choose a Git root',
        );
      }
      return localProjectSchema.parse(await response.json());
    },
    async initializeProject(
      project: ProjectInitialization,
    ): Promise<LocalProject> {
      const input = initializeProjectRequestSchema.parse({
        project,
        confirm: true,
      });
      if (!token || !state?.features?.projectInitialization)
        throw new WorkbenchError(
          'rejected',
          'Git initialization needs an updated connection/server',
        );
      // A mutation is sent once. On an uncertain result, inspect again before any retry.
      const response = await send(
        '/api/project/initialize',
        {
          method: 'POST',
          headers: {
            'x-workbench-token': token,
            origin,
            'content-type': 'application/json',
          },
          body: JSON.stringify(input),
        },
        120_000,
      ).catch(() => {
        throw new WorkbenchError(
          'unavailable',
          'Initialization result is uncertain; reload the folder before retrying',
        );
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const error = z.object({ error: z.string() }).safeParse(body);
        throw new WorkbenchError(
          'rejected',
          error.success
            ? error.data.error
            : 'Git initialization failed; reload the folder before retrying',
        );
      }
      const result = localProjectSchema.safeParse(body);
      if (!result.success || result.data.path !== project.path)
        throw new WorkbenchError(
          'protocol',
          'Invalid initialization response; reload the folder',
        );
      return result.data;
    },
    async directory(runId: RunId, path = ''): Promise<DirectoryListing> {
      const query = directoryRequestSchema.parse({ runId, path });
      if (!token)
        throw new WorkbenchError(
          'unavailable',
          'Reconnect before browsing project files',
        );
      const response = await send(
        '/api/directory?' + new URLSearchParams(query),
        {
          headers: { 'x-workbench-token': token, origin },
        },
      );
      if (!response.ok)
        throw new WorkbenchError(
          'rejected',
          'Project folders are unavailable; connect to an updated server',
        );
      const listing = directoryListingSchema.safeParse(await response.json());
      if (
        !listing.success ||
        listing.data.runId !== runId ||
        listing.data.path !== path
      )
        throw new WorkbenchError('protocol', 'Invalid directory response');
      return listing.data;
    },
    /** Browser page for one Run's Change map; the page fetches its own data. */
    changeMapUrl(runId: RunId): string {
      return `${origin}/changes?${new URLSearchParams({ run: changesRequestSchema.parse({ runId }).runId })}`;
    },
    poll(): Promise<WorkbenchState> {
      polling ??= (async () => {
        if (!token || !state) return connect();
        const page = await readState(state.cursor);
        if (page.instanceId && page.instanceId !== instance) return connect();
        state = {
          ...page,
          events: page.reset
            ? page.events
            : page.events.length
              ? [...state.events, ...page.events].slice(-2000)
              : state.events,
        };
        return state;
      })().finally(() => {
        polling = null;
      });
      return polling;
    },
    async command(input: WorkbenchCommand): Promise<WorkbenchReply> {
      const command = commandSchema.parse(input);
      if (!token)
        throw new WorkbenchError(
          'unavailable',
          'Not connected; wait for reconnection before acting',
        );
      const response = await send('/api/commands', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-workbench-token': token,
          origin,
        },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        // Never replay a mutation after reconnect: its first delivery may already have succeeded.
        if (response.status === 403) token = null;
        const body: unknown = await response.json().catch(() => null);
        const error = z.object({ error: z.string() }).safeParse(body);
        throw new WorkbenchError(
          'rejected',
          error.success
            ? error.data.error
            : 'Action not accepted; check the current state',
        );
      }
      try {
        return replySchema.parse(await response.json());
      } catch {
        throw new WorkbenchError(
          'protocol',
          'Unexpected response; check Timeline before retrying',
        );
      }
    },
  };
}
export type WorkbenchClient = ReturnType<typeof createWorkbenchClient>;

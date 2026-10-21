import { z } from 'zod';
import {
  commandSchema,
  replySchema,
  stateSchema,
  workbenchOrigin,
  directoryRequestSchema,
} from './workbench-protocol.js';
import { directoryListingSchema } from '../execution/index.js';
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
  ): Promise<Response> {
    try {
      return await request(
        new Request(origin + path, {
          ...options,
          signal: AbortSignal.timeout(5000),
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

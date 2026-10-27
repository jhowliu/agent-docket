import { createServer } from 'node:http';
import { createWebWorkbench } from './web-workbench.js';
import { workbenchOrigin } from './workbench-protocol.js';
import { loadLaunchConfig } from './launch-config.js';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { codeBuild } from './code-build.js';

const origin = workbenchOrigin();
const port = Number(new URL(origin).port);
const launchPath = process.env['WORKBENCH_LAUNCH'];
const configured = launchPath ? await loadLaunchConfig(launchPath) : undefined;
const workbench = createWebWorkbench(origin, {
  planDirectory: resolve(
    process.env['WORKBENCH_PLAN_DIRECTORY'] ?? '.workbench/plans',
  ),
  ...(configured ? { launch: configured.launch } : {}),
  defaultProjectPath: process.cwd(),
  build: await codeBuild(),
  localWorker: {
    transport: 'local',
    workspaceRoot: resolve('.workbench/local-runs'),
    ...(existsSync(resolve(homedir(), '.codex/auth.json'))
      ? { authFile: resolve(homedir(), '.codex/auth.json') }
      : {}),
    // Read at each Claude launch; a missing file fails that Run with a hint.
    claudeTokenFile: resolve(
      process.env['WORKBENCH_CLAUDE_TOKEN_FILE'] ??
        resolve(homedir(), '.config/agent-docket/claude-token'),
    ),
  },
  onShutdown: () => {
    void stop();
  },
});
const server = createServer(async (incoming, outgoing) => {
  incoming.setTimeout(10_000, () => incoming.destroy());
  try {
    if (incoming.headers.host !== `127.0.0.1:${port}`) {
      outgoing.writeHead(403).end('Unknown host');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      size += buffer.byteLength;
      if (size > 32768) {
        outgoing.writeHead(413).end('Request body is too large');
        return;
      }
      chunks.push(buffer);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value))
        for (const part of value) headers.append(name, part);
      else if (value !== undefined) headers.set(name, value);
    }
    const method = incoming.method ?? 'GET';
    const request = new Request(new URL(incoming.url ?? '/', origin), {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: Buffer.concat(chunks).toString('utf8') }),
    });
    // Hashing an initial snapshot or signing it, or analysing a large worktree
    // for a Change map, can outlast a metadata lookup.
    const pathname = new URL(request.url).pathname;
    if (
      (method === 'POST' && pathname === '/api/project/initialize') ||
      (method === 'GET' && pathname === '/api/changes')
    )
      incoming.setTimeout(120_000);
    const response = await workbench.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end('Workbench request failed');
  }
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  try {
    await workbench.close();
  } catch {
    process.exitCode = 1;
  }
  server.closeAllConnections();
}
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
server.once('error', (error: Error) => {
  console.error(`Cannot open workbench: ${error.message}`);
  process.exitCode = 1;
  void stop();
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Agent workbench: ${origin}`);
  console.log(
    configured?.launch.provider !== undefined &&
      configured.launch.provider !== 'fixture'
      ? `${configured.launch.provider} · ${configured.launch.worker.transport} mode. ${
          configured.launch.worker.transport === 'local'
            ? configured.launch.source.kind === 'directory'
              ? 'No OS isolation. Clean Git worktrees are collected on shutdown; unsaved changes are retained.'
              : 'No OS isolation. Sample/HTTPS code copies are retained on shutdown.'
            : 'Managed worker environment.'
        }`
      : 'New Session: choose a Git project for local Codex, or Fixture for a demo. No OS isolation. Ctrl+C stops managed Runs.',
  );
});

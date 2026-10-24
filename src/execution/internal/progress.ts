import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { progressLimit, toolRecord } from './progress-protocol.js';
import type { z } from 'zod';
import type { requestInput } from './progress-protocol.js';

export type AgentRequestInput = z.infer<typeof requestInput>;

export type ProgressChannel = Readonly<{
  server: McpServerStdio;
  beginTurn(): Promise<void>;
  endTurn(): Promise<void>;
  close(): Promise<void>;
}>;

/** A local Run's private MCP ingress. Its identity is bound here, never supplied by the agent. */
export async function createProgressChannel(handlers: {
  report: (summary: string, finished: boolean) => void;
  request: (request: AgentRequestInput) => void;
  failed: () => void;
}): Promise<ProgressChannel> {
  const { report, request, failed } = handlers;
  const directory = await mkdtemp(join(tmpdir(), 'workbench-progress-'));
  const records = join(directory, 'reports.jsonl');
  const active = join(directory, 'turn');
  try {
    await writeFile(records, '', { mode: 0o600 });
    await writeFile(active, '', { mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let turn: string | undefined;
  let cursor = 0;
  let closed = false;
  let unavailable = false;
  let reading = Promise.resolve();
  const drain = () => {
    reading = reading.then(async () => {
      if (closed || unavailable) return;
      try {
        if ((await stat(records)).size > progressLimit)
          throw new Error('Progress history exceeds its limit');
        const text = await readFile(records, 'utf8');
        const end = text.lastIndexOf('\n') + 1;
        if (end < cursor) throw new Error('Progress history was truncated');
        const lines = text.slice(cursor, end).split('\n');
        cursor = end;
        for (const line of lines) {
          if (!line) continue;
          const input: unknown = JSON.parse(line);
          const parsed = toolRecord.parse(input);
          if (!turn || parsed.turn !== turn) continue;
          if ('summary' in parsed)
            report(parsed.summary, parsed.finished === true);
          else request(parsed.request);
        }
      } catch {
        unavailable = true;
        await writeFile(active, '').catch(() => {});
        failed();
      }
    });
    return reading;
  };
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void drain().finally(() => {
      polling = false;
    });
  }, 100);
  timer.unref();
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(
    new URL(
      source ? './progress-server.ts' : './progress-server.js',
      import.meta.url,
    ),
  );
  return {
    server: {
      name: 'workbench_progress',
      command: process.execPath,
      args: [
        ...(source ? ['--import', import.meta.resolve('tsx')] : []),
        entry,
      ],
      env: [{ name: 'WORKBENCH_PROGRESS_DIRECTORY', value: directory }],
    },
    async beginTurn() {
      if (closed || unavailable) return;
      await drain();
      turn = randomUUID();
      await writeFile(active, turn);
    },
    async endTurn() {
      if (closed) return;
      await drain();
      turn = undefined;
      await writeFile(active, '');
    },
    async close() {
      if (closed) return;
      closed = true;
      turn = undefined;
      clearInterval(timer);
      await reading;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  progressInput,
  progressInstructions,
  progressLimit,
  requestInput,
  requestInstructions,
  requestsPerTurn,
  toolRecord,
  workbenchInstructions,
} from './progress-protocol.js';

const directory = process.env.WORKBENCH_PROGRESS_DIRECTORY;
if (!directory) throw new Error('Progress channel is not configured');
const records = join(directory, 'reports.jsonl');
const active = join(directory, 'turn');
const server = new McpServer(
  { name: 'workbench-progress', version: '1.0.0' },
  { instructions: workbenchInstructions },
);
const failure = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text }],
});
const requestsByTurn = new Map<string, number>();
let writing = Promise.resolve();

/** Appends one record bound to the active turn; the agent never names a Run or turn. */
function record(
  entry: Readonly<Record<string, unknown>>,
  accepted: string,
  kind: 'progress' | 'request',
): Promise<CallToolResult> {
  const result = writing.then<CallToolResult>(async () => {
    try {
      const turn = (await readFile(active, 'utf8')).trim();
      const parsed = toolRecord.safeParse({ turn, ...entry });
      if (!parsed.success)
        return failure(
          `No active turn accepts ${kind === 'progress' ? 'progress reports' : 'requests'}.`,
        );
      if (
        kind === 'request' &&
        (requestsByTurn.get(turn) ?? 0) >= requestsPerTurn
      )
        return failure(
          `At most ${requestsPerTurn} requests are accepted per turn.`,
        );
      const line = JSON.stringify(parsed.data) + '\n';
      if ((await stat(records)).size + Buffer.byteLength(line) > progressLimit)
        return failure('This Run has reached its report limit.');
      await appendFile(records, line);
      if (kind === 'request')
        requestsByTurn.set(turn, (requestsByTurn.get(turn) ?? 0) + 1);
      return { content: [{ type: 'text', text: accepted }] };
    } catch {
      return failure('Workbench reporting is unavailable for this Run.');
    }
  });
  writing = result.then(() => {});
  return result;
}

server.registerTool(
  'report_progress',
  {
    title: 'Report progress',
    description: progressInstructions,
    inputSchema: progressInput,
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  ({ summary }) =>
    record({ summary }, 'Progress recorded as an agent report.', 'progress'),
);
server.registerTool(
  'request_user',
  {
    title: 'Ask the person to act or answer',
    description: requestInstructions,
    inputSchema: requestInput,
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  (request) =>
    record(
      { request },
      'Shown to the person as needing their attention. Nothing waits for it; explain it in your answer.',
      'request',
    ),
);
await server.connect(new StdioServerTransport());

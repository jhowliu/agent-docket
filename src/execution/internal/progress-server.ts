import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  progressInput,
  progressInstructions,
  progressLimit,
  progressRecord,
} from './progress-protocol.js';

const directory = process.env.WORKBENCH_PROGRESS_DIRECTORY;
if (!directory) throw new Error('Progress channel is not configured');
const records = join(directory, 'reports.jsonl');
const active = join(directory, 'turn');
const server = new McpServer(
  { name: 'workbench-progress', version: '1.0.0' },
  { instructions: progressInstructions },
);
let writing = Promise.resolve();
server.registerTool(
  'report_progress',
  {
    title: 'Report progress',
    description: progressInstructions,
    inputSchema: progressInput,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  ({ summary }) => {
    const result = writing.then<CallToolResult>(async () => {
      try {
        const turn = (await readFile(active, 'utf8')).trim();
        const record = progressRecord.safeParse({ turn, summary });
        if (!record.success)
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'No active turn accepts progress reports.',
              },
            ],
          };
        const line = JSON.stringify(record.data) + '\n';
        if (
          (await stat(records)).size + Buffer.byteLength(line) >
          progressLimit
        )
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'This Run has reached its progress-report limit.',
              },
            ],
          };
        await appendFile(records, line);
        return {
          content: [
            { type: 'text', text: 'Progress recorded as an agent report.' },
          ],
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Progress reporting is unavailable for this Run.',
            },
          ],
        };
      }
    });
    writing = result.then(() => {});
    return result;
  },
);
await server.connect(new StdioServerTransport());

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'ink';
import type { RunEvent, RunEventPayload } from '../src/execution/index.js';
import type { AttentionItem } from '../src/attention/index.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';
import { WorkbenchScreen } from '../src/app/tui-view.js';

const runId = 'run-timeline';
function events(payloads: readonly RunEventPayload[]): RunEvent[] {
  return payloads.map((payload, index) => ({
    ...payload,
    runId,
    sequence: index + 1,
    at: new Date(Date.UTC(2026, 9, 19, 7, 51, index)).toISOString(),
  }));
}
function timeline(events: RunEvent[], attention: AttentionItem[] = []) {
  const state: WorkbenchState = {
    runs: [
      {
        id: runId,
        provider: 'codex',
        label: 'ptt-web / describe',
        state: { kind: 'idle' },
        environment: { kind: 'local', location: '/example/run/repo' },
        capabilities: null,
      },
    ],
    attention,
    events,
    cursor: events.at(-1)?.sequence ?? 0,
    reset: true,
    source: '/example/ptt-web',
  };
  return renderToString(
    <WorkbenchScreen
      state={state}
      selectedId={runId}
      filter="active"
      view="timeline"
      offset={0}
      request={undefined}
      armed={false}
      connected
      busy={false}
      note="Ready"
      options={false}
      help={false}
      details={false}
      mode="normal"
      columns={120}
      rows={36}
    />,
    { columns: 120 },
  );
}

test('Timeline shows explicit progress and hides routine tool details', () => {
  const journal = events([
    { type: 'run.state', state: { kind: 'starting' } },
    {
      type: 'diagnostic',
      message:
        'Local process: no OS isolation. The code copy is retained when this Run stops.',
    },
    { type: 'run.state', state: { kind: 'idle' } },
    { type: 'run.state', state: { kind: 'running' } },
    { type: 'agent.message', text: 'I will inspect ' },
    { type: 'agent.message', text: 'the project.' },
    { type: 'tool', id: 'read', title: 'Read README.md', status: 'pending' },
    { type: 'tool', id: 'read', title: 'Tool update', status: 'unknown' },
    { type: 'tool', id: 'read', title: 'Tool update', status: 'completed' },
    { type: 'agent.message', text: 'PTT Web is a Rust/Axum reader ' },
    {
      type: 'agent.message',
      text: 'with a JavaScript frontend.\nMore details stay in Live.',
    },
    {
      type: 'agent.progress',
      summary:
        'Located the Rust backend and JavaScript frontend. The full project description is ready in the conversation.',
    },
    { type: 'turn.end', reason: 'end_turn' },
    { type: 'run.state', state: { kind: 'idle' } },
  ]);
  const output = timeline(journal);
  assert.ok(!output.includes('I will inspect the project.'), output);
  assert.ok(!output.includes('Read README.md'), output);
  assert.ok(!output.includes('Tool completed'), output);
  assert.ok(
    output.includes(
      'Progress · Located the Rust backend and JavaScript frontend.',
    ),
    output,
  );
  assert.ok(output.includes('9s · 1 tool'), output);
  assert.ok(!output.includes('More details stay in Live'), output);
  assert.ok(!output.includes('Local process:'), output);
  assert.ok(!output.includes('Tool update'), output);
  assert.ok(!output.includes('end_turn'), output);
});

test('Timeline names the approval and preserves acceptance versus delivery', () => {
  const attention: AttentionItem = {
    id: 'attn-edit',
    kind: 'permission',
    runId,
    title: 'Edit static/app.js',
    detail: 'Requested edit',
    status: 'delivered',
    choiceId: 'allow',
    createdAt: '2026-10-19T07:51:00Z',
    choices: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }],
  };
  const output = timeline(
    events([
      { type: 'attention', id: attention.id, status: 'pending' },
      { type: 'attention', id: attention.id, status: 'accepted' },
      { type: 'attention', id: attention.id, status: 'delivered' },
    ]),
    [attention],
  );
  assert.ok(output.includes('Approval requested · Edit static/app.js'), output);
  assert.ok(
    output.includes('Reply accepted · Allow once · Edit static/app.js'),
    output,
  );
  assert.ok(
    output.includes('Reply delivered · Allow once · Edit static/app.js'),
    output,
  );
});

test('Timeline associates requests, tool reuse and changed-file counts with their own turns', () => {
  const journal = events([
    { type: 'run.state', state: { kind: 'running' } },
    { type: 'turn.start', text: 'Describe this project in 200 words.' },
    {
      type: 'tool',
      id: 'command',
      title: 'Read project files',
      status: 'completed',
    },
    { type: 'diff', path: 'README.md', oldText: 'old', newText: 'new' },
    { type: 'diff', path: 'README.md', oldText: 'new', newText: 'newer' },
    { type: 'turn.end', reason: 'end_turn' },
    { type: 'run.state', state: { kind: 'idle' } },
    { type: 'run.state', state: { kind: 'running' } },
    { type: 'turn.start', text: 'Check the JavaScript syntax.' },
    {
      type: 'tool',
      id: 'command',
      title: 'npm run check',
      status: 'completed',
    },
    { type: 'turn.end', reason: 'end_turn' },
    { type: 'run.state', state: { kind: 'idle' } },
  ]);
  const before = JSON.stringify(journal);
  const output = timeline(journal);
  assert.ok(
    output.includes('Request · Describe this project in 200 words.'),
    output,
  );
  assert.ok(output.includes('Request · Check the JavaScript syntax.'), output);
  assert.ok(!output.includes('Read project files'), output);
  assert.ok(!output.includes('npm run check'), output);
  assert.ok(output.includes('5s · 1 tool · 1 file changed'), output);
  assert.ok(output.includes('3s · 1 tool'), output);
  assert.ok(!output.includes('File changed'), output);
  assert.ok(!output.includes('Turn started'), output);
  assert.ok(!output.includes('verified'), output);
  assert.equal(JSON.stringify(journal), before);
});

test('Timeline retains failure and stop reasons without claiming a successful check or inventing missing timings', () => {
  const journal = events([
    { type: 'tool', id: 'check', title: 'npm test', status: 'failed' },
    { type: 'turn.end', reason: 'max_tokens' },
    {
      type: 'run.state',
      state: { kind: 'interrupted', reason: 'Adapter exited' },
    },
  ]);
  const output = timeline(journal);
  assert.ok(output.includes('Tool failed · npm test'), output);
  assert.ok(output.includes('Turn ended · 1 tool · stop: max_tokens'), output);
  assert.ok(output.includes('Run interrupted · Adapter exited'), output);
  assert.ok(!output.includes('NaN'), output);
  assert.ok(!output.includes('passed'), output);
});

test('Timeline keeps progress, replies and Checks visible through noisy tool activity', () => {
  const journal = events([
    { type: 'run.state', state: { kind: 'running' } },
    { type: 'turn.start', text: 'Fix the issue.' },
    ...Array.from(
      { length: 80 },
      (_, index): RunEventPayload => ({
        type: 'tool',
        id: `read-${index}`,
        title: `Read file ${index}`,
        status: 'completed',
      }),
    ),
    {
      type: 'tool',
      id: 'failed',
      title: 'Read missing file',
      status: 'in_progress',
    },
    { type: 'agent.progress', summary: 'Found the cause and applied the fix.' },
    { type: 'tool', id: 'failed', title: 'Tool update', status: 'failed' },
    { type: 'tool', id: 'failed', title: 'Tool update', status: 'unknown' },
    { type: 'agent.message', text: 'The fix is ready.' },
    { type: 'turn.end', reason: 'end_turn' },
    { type: 'check.start', candidate: 'abc1234', command: 'npm test' },
    {
      type: 'check.end',
      candidate: 'abc1234',
      command: 'npm test',
      truncated: false,
      outcome: 'exited',
      exitCode: 0,
      durationMs: 1000,
      output: '',
    },
  ]);
  const before = JSON.stringify(journal);
  const output = timeline(journal);
  assert.ok(!output.includes('Read file'), output);
  assert.ok(
    output.includes('Progress · Found the cause and applied the fix.'),
    output,
  );
  assert.equal(
    output.split('Tool failed · Read missing file').length - 1,
    1,
    output,
  );
  assert.ok(output.includes('Space reply · 1 line'), output);
  assert.ok(output.includes('The fix is ready.'), output);
  assert.ok(output.includes('Checks started'), output);
  assert.ok(output.includes('Checks passed'), output);
  assert.equal(JSON.stringify(journal), before);
});

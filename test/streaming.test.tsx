import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'ink';
import type { RunEvent, RunId } from '../src/execution/index.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';
import { WorkbenchScreen } from '../src/app/tui-view.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';

const runId = 'run-streaming';
function screen(
  events: readonly RunEvent[],
  view: 'live' | 'timeline',
  columns = 80,
  selectedId: RunId = runId,
) {
  const state: WorkbenchState = {
    runs: [
      {
        id: selectedId,
        provider: 'codex',
        label: 'ptt-web',
        state: { kind: 'running' },
        environment: { kind: 'local', location: '/tmp/streaming/repo' },
        capabilities: null,
      },
    ],
    attention: [],
    events: [...events],
    cursor: events.at(-1)?.sequence ?? 0,
    reset: true,
    source: '/projects/ptt-web',
  };
  return renderToString(
    <WorkbenchScreen
      state={state}
      selectedId={selectedId}
      filter="active"
      view={view}
      offset={0}
      request={undefined}
      armed={false}
      connected
      busy={false}
      note="Ready"
      project={false}
      options={false}
      help={false}
      details={false}
      mode="normal"
      columns={columns}
      rows={36}
    />,
    { columns },
  );
}

test('Live joins streaming fragments into readable text', () => {
  const events: RunEvent[] = ['sum', 'marize', ' its', ' pur', 'pose', '.'].map(
    (text, index) => ({
      runId,
      sequence: index + 1,
      at: '2026-10-19T07:51:47Z',
      type: 'agent.message',
      text,
    }),
  );
  const output = screen(events, 'live');
  assert.ok(output.includes('summarize its purpose.'), output);
  const first = events[0];
  assert.ok(first);
  assert.ok(first.type === 'agent.message');
  assert.equal(
    output,
    screen([{ ...first, text: 'summarize its purpose.' }], 'live'),
  );
});

test('Timeline omits ordinary streamed prose and groups tool updates into concise activity entries', () => {
  const at = '2026-10-19T07:51:47Z';
  const payloads = [
    { type: 'run.state', state: { kind: 'running' } },
    { type: 'agent.message', text: 'sum' },
    { type: 'agent.message', text: 'marize' },
    { type: 'tool', id: 'read', title: 'Read README', status: 'pending' },
    { type: 'tool', id: 'read', title: 'Read README', status: 'completed' },
    { type: 'attention', id: 'attn-approval', status: 'pending' },
    { type: 'attention', id: 'attn-approval', status: 'delivered' },
    { type: 'diff', path: 'app.js', oldText: 'before', newText: 'after' },
    { type: 'tool', id: 'check', title: 'npm test', status: 'failed' },
    { type: 'diagnostic', message: 'Adapter connection lost' },
    { type: 'turn.end', reason: 'end_turn' },
    {
      type: 'run.state',
      state: { kind: 'interrupted', reason: 'Adapter connection lost' },
    },
  ] as const;
  const events: RunEvent[] = payloads.map((payload, index) => ({
    runId,
    sequence: index + 1,
    at,
    ...payload,
  }));
  const output = screen(events, 'timeline', 120);
  for (const detail of [
    'Turn started',
    'Approval · pending',
    'Approval · delivered',
    'File changed · app.js',
    'Tool failed · npm test',
    'Adapter connection lost',
    'Turn finished',
  ])
    assert.ok(output.includes(detail), output);
  assert.equal(output.split('Read README').length - 1, 1, output);
  assert.ok(!output.includes('summarize'), output);
  assert.ok(!output.includes('Tool pending · Read README'), output);
  const narrow = screen(events, 'timeline', 80);
  assert.ok(narrow.includes('Run interrupted · Adapter connect'), narrow);
  assert.ok(
    screen(events, 'live', 80).includes('Adapter connection lost'),
    'The complete failure reason stays available in Live beside Project',
  );
  assert.ok(
    screen(events, 'live').includes('summarize'),
    'Full text stays available in Live',
  );
});

test('Live keeps streamed whitespace, CJK and split emoji exactly as one complete message', () => {
  const text = 'Hello 世界 👩‍💻\n\n  - Read README\n  - Keep indentation\nDone.';
  const whole: RunEvent = {
    runId,
    sequence: 1,
    at: '2026-10-19T07:51:47Z',
    type: 'agent.message',
    text,
  };
  const chunks: RunEvent[] = text
    .split('')
    .map((text, index) => ({ ...whole, sequence: index + 1, text }));
  const snapshot = JSON.stringify(chunks);
  assert.equal(screen(chunks, 'live'), screen([whole], 'live'));
  assert.equal(
    JSON.stringify(chunks),
    snapshot,
    'Rendering must leave the journal unchanged',
  );
});

test('Live retains message boundaries around tools and turn endings while ignoring other Runs', () => {
  const at = '2026-10-19T07:51:47Z';
  const payloads = [
    { type: 'agent.message', text: 'Inspect' },
    { type: 'agent.message', text: 'IGNORED', runId: 'run-other' },
    { type: 'agent.message', text: 'ing project.' },
    { type: 'tool', id: 'read', title: 'Read README', status: 'completed' },
    { type: 'agent.message', text: 'Found ' },
    { type: 'agent.message', text: 'Rust.' },
    { type: 'turn.end', reason: 'end_turn' },
    { type: 'agent.message', text: 'Next turn.' },
  ] as const;
  const events: RunEvent[] = payloads.map((payload, index) => ({
    runId,
    sequence: index + 1,
    at,
    ...payload,
  }));
  const output = screen(events, 'live');
  assert.ok(output.includes('Inspecting project.'), output);
  assert.ok(output.includes('Found Rust.'), output);
  assert.ok(!output.includes('IGNORED'), output);
  assert.ok(!output.includes('project.Found'), output);
  assert.ok(!output.includes('Rust.Next'), output);
  assert.ok(
    output.indexOf('Inspecting project.') < output.indexOf('Read README'),
  );
  assert.ok(output.indexOf('Read README') < output.indexOf('Found Rust.'));
  assert.ok(output.indexOf('Turn ended') < output.indexOf('Next turn.'));
});

test('Live wraps complete streamed replies at 60, 80 and 120 columns without clipping the tail', () => {
  const text =
    'Describe purpose, architecture and current capabilities. '.repeat(4) +
    'COMPLETE_END';
  const chunks: RunEvent[] = text.split('').map((text, index) => ({
    runId,
    sequence: index + 1,
    at: '2026-10-19T07:51:47Z',
    type: 'agent.message',
    text,
  }));
  for (const columns of [60, 80, 120]) {
    const output = screen(chunks, 'live', columns);
    assert.ok(output.includes('Describe purpose'), output);
    assert.ok(output.includes('COMPLETE_END'), output);
  }
});

test('ACP chunks survive incremental polling and reconnection without missing or repeated text', async (t) => {
  const origin = 'http://127.0.0.1:4177';
  const app = createWebWorkbench(origin);
  t.after(() => app.close());
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const run = await client.command({ kind: 'start' });
  assert.ok('runId' in run);
  await client.command({ kind: 'prompt', runId: run.runId, text: 'stream' });
  const sentence = 'summarize its purpose.';
  const deadline = Date.now() + 6000;
  let state = await client.poll();
  const message = (value: WorkbenchState) =>
    value.events
      .flatMap((event) => (event.type === 'agent.message' ? [event.text] : []))
      .join('');
  while (!state.events.some((event) => event.type === 'turn.end')) {
    assert.ok(
      sentence.startsWith(message(state)),
      'Polling must retain the exact text prefix',
    );
    assert.ok(Date.now() < deadline, 'Stream did not finish');
    await new Promise((resolve) => setTimeout(resolve, 10));
    state = await client.poll();
  }
  assert.equal(message(state), sentence);
  assert.equal(
    state.events.filter((event) => event.type === 'agent.message').length,
    6,
  );
  assert.ok(screen(state.events, 'live', 80, run.runId).includes(sentence));
  const once = await client.poll();
  const twice = await client.poll();
  assert.deepEqual(twice.events, once.events);
  const reconnected = await client.connect();
  assert.equal(message(reconnected), sentence);
  assert.equal(
    screen(reconnected.events, 'live', 80, run.runId),
    screen(state.events, 'live', 80, run.runId),
  );
});

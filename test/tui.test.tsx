import test from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { Box, Text, renderToString } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';
import { WorkbenchApp } from '../src/app/tui-app.js';
import { WorkbenchScreen } from '../src/app/tui-view.js';
import { PromptInput } from '../src/app/tui-input.js';

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('TUI condition timed out');
}
async function frameHas(
  ui: ReturnType<typeof render>,
  text: string,
  present = true,
) {
  await until(() => Boolean(ui.lastFrame()?.includes(text)) === present);
}
async function stateWhen(
  client: WorkbenchClient,
  predicate: (state: WorkbenchState) => boolean,
) {
  let result = await client.poll();
  await until(async () => {
    result = await client.poll();
    return predicate(result);
  });
  return result;
}
const origin = 'http://127.0.0.1:4177';

test('Ink controls configured local startup, advertised sign-in and prompts in place', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-native-tui-'));
  const app = createWebWorkbench(origin, {
    launch: {
      provider: 'codex',
      source: { kind: 'fixture' },
      worker: {
        transport: 'local',
        workspaceRoot: root,
        adapter: {
          file: process.execPath,
          args: [resolve('fixtures/auth-agent.mjs')],
        },
      },
    },
  });
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  const initial = await client.connect();
  const ui = render(
    <WorkbenchApp client={client} initial={initial} pollInterval={25} />,
  );
  t.after(async () => {
    ui.unmount();
    ui.cleanup();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await frameHas(ui, 'LOCAL / no OS isolation');
  assert.ok(!ui.lastFrame()?.includes('FIXTURE / no model'));
  ui.stdin.write('n');
  await stateWhen(
    client,
    (state) => state.runs[0]?.state.kind === 'authentication-required',
  );
  await frameHas(ui, 'Sign-in required');
  ui.stdin.write('s');
  await frameHas(ui, ':auth test-auth');
  ui.stdin.write(':');
  await frameHas(ui, 'Command');
  ui.stdin.write('auth test-auth');
  await frameHas(ui, 'auth test-auth');
  ui.stdin.write('\r');
  await stateWhen(client, (state) => state.runs[0]?.state.kind === 'idle');
  await frameHas(ui, 'Idle');
  // Run readiness can arrive before the previous command's UI receipt is complete.
  await frameHas(ui, 'Sending', false);
  ui.stdin.write('i');
  await frameHas(ui, 'Reply · Enter');
  ui.stdin.write('hello');
  await frameHas(ui, 'hello');
  ui.stdin.write('\r');
  await stateWhen(client, (state) =>
    state.events.some(
      (event) =>
        event.type === 'agent.message' && event.text.includes('Native sign-in'),
    ),
  );
  await frameHas(ui, 'Reply · Enter', false);
  ui.stdin.write('x');
  await stateWhen(client, (state) => state.runs[0]?.state.kind === 'cancelled');
});

test('Ink navigation preserves independent drafts and never interprets typed text as actions', async (t) => {
  const app = createWebWorkbench(origin);
  t.after(() => app.close());
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  const initial = await client.connect();
  const ui = render(
    <WorkbenchApp client={client} initial={initial} pollInterval={25} />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  await frameHas(ui, 'n new');
  ui.stdin.write('n');
  await stateWhen(client, (state) => state.runs.length === 1);
  await frameHas(ui, 'Run 1');
  await frameHas(ui, 'Run started');
  ui.stdin.write('n'); // A held/repeated mutation key cannot create another Run.
  await new Promise((done) => setTimeout(done, 50));
  assert.equal((await client.poll()).runs.length, 1);
  ui.stdin.write('j');
  await new Promise((done) => setTimeout(done, 25));
  ui.stdin.write('n');
  await stateWhen(client, (state) => state.runs.length === 2);
  await frameHas(ui, '> Run 2');
  ui.stdin.write('k');
  await frameHas(ui, '> Run 1');
  ui.stdin.write('i');
  await frameHas(ui, 'Reply · Enter');
  ui.stdin.write('reply:中文jkar👩‍💻');
  await frameHas(ui, '中文jkar');
  assert.equal((await client.poll()).attention.length, 0);
  ui.stdin.write('\u001b');
  await frameHas(ui, 'Reply · Enter', false);
  ui.stdin.write('j');
  await frameHas(ui, '> Run 2');
  ui.stdin.write('i');
  await frameHas(ui, 'Reply · Enter');
  assert.ok(!ui.lastFrame()?.includes('中文jkar'));
  ui.stdin.write('reply:second');
  await frameHas(ui, 'second');
  ui.stdin.write('\u001b');
  await frameHas(ui, 'Reply · Enter', false);
  ui.stdin.write('k');
  await frameHas(ui, '> Run 1');
  ui.stdin.write('i');
  await frameHas(ui, '中文jkar');
  ui.stdin.write('\r');
  await frameHas(ui, 'Reply · Enter', false);
  const done = await stateWhen(client, (state) =>
    state.events.some(
      (event) =>
        event.type === 'agent.message' && event.text.includes('中文jkar'),
    ),
  );
  assert.equal(done.runs.length, 2);
  assert.equal(done.attention.length, 0);
  assert.ok(
    done.events.some(
      (event) => event.type === 'agent.message' && event.text.includes('👩‍💻'),
    ),
  );
  ui.stdin.write('j');
  await frameHas(ui, '> Run 2');
  ui.stdin.write('i');
  await frameHas(ui, 'second');
});

test('Ink approval shortcuts target the focused request; paste and repeats cannot answer the next one', async (t) => {
  const app = createWebWorkbench(origin);
  t.after(() => app.close());
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const one = await client.command({ kind: 'start' });
  const two = await client.command({ kind: 'start' });
  assert.ok('runId' in one && 'runId' in two);
  await client.command({
    kind: 'prompt',
    runId: one.runId,
    text: 'two-permissions',
  });
  await client.command({ kind: 'prompt', runId: two.runId, text: 'fix' });
  const initial = await stateWhen(
    client,
    (state) =>
      state.attention.filter((item) => item.status === 'pending').length === 3,
  );
  const ui = render(
    <WorkbenchApp client={client} initial={initial} pollInterval={25} />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  await frameHas(ui, 'Approval 1/2');
  ui.stdin.write('p');
  await frameHas(ui, 'Source ·');
  ui.stdin.write('s');
  await frameHas(ui, 'i prompts:');
  assert.ok(!ui.lastFrame()?.includes('Source ·'));
  ui.stdin.write('?');
  await frameHas(ui, 'PgUp/PgDn scroll');
  ui.stdin.write('d');
  await frameHas(ui, ':answer 1');
  assert.ok(!ui.lastFrame()?.includes('PgUp/PgDn scroll'));
  ui.stdin.write('\u001b');
  await frameHas(ui, ':answer 1', false);
  ui.stdin.write('\u001b[200~a\u001b[201~');
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(
    (await client.poll()).attention.filter((item) => item.status === 'pending')
      .length,
    3,
  );
  ui.stdin.write('a');
  await stateWhen(
    client,
    (state) =>
      state.attention.filter((item) => item.status === 'pending').length === 2,
  );
  await frameHas(ui, 'Tab to select');
  ui.stdin.write('a');
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(
    (await client.poll()).attention.filter((item) => item.status === 'pending')
      .length,
    2,
  );
  ui.stdin.write('\t');
  await frameHas(ui, 'r Reject once');
  ui.stdin.write('r');
  await stateWhen(
    client,
    (state) =>
      state.attention.filter((item) => item.status === 'pending').length === 1,
  );
  ui.stdin.write('w');
  await frameHas(ui, '> Run 2');
  ui.stdin.write('r');
  const finished = await stateWhen(client, (state) =>
    state.runs.every((run) => run.state.kind === 'idle'),
  );
  assert.ok(
    finished.events.some(
      (event) => event.runId === one.runId && event.type === 'diff',
    ),
  );
  assert.ok(
    !finished.events.some(
      (event) => event.runId === two.runId && event.type === 'diff',
    ),
  );
  assert.equal(
    finished.attention.filter((item) => item.status === 'delivered').length,
    3,
  );
  await frameHas(ui, 'Response delivered to agent');
  ui.stdin.write('k');
  await frameHas(ui, '> Run 1');
  await frameHas(ui, 'Last response accepted');
  assert.ok(!ui.lastFrame()?.includes('awaiting delivery to agent'));
});

test('disconnect disables actions, reconnect refreshes state, and q detaches without cancelling a Run', async (t) => {
  const app = createWebWorkbench(origin);
  t.after(() => app.close());
  let offline = false;
  const client = createWorkbenchClient(origin, (request) => {
    if (offline) return Promise.reject(new Error('Disconnected'));
    return app.fetch(request);
  });
  await client.connect();
  const run = await client.command({ kind: 'start' });
  assert.ok('runId' in run);
  await client.command({ kind: 'prompt', runId: run.runId, text: 'fix' });
  const initial = await stateWhen(client, (state) =>
    state.attention.some((item) => item.status === 'pending'),
  );
  const ui = render(
    <WorkbenchApp client={client} initial={initial} pollInterval={25} />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  await frameHas(ui, 'Awaiting approval');
  offline = true;
  await frameHas(ui, 'Disconnected');
  ui.stdin.write('a');
  offline = false;
  await frameHas(ui, 'Reconnected');
  assert.equal((await client.poll()).attention[0]?.status, 'pending');
  ui.stdin.write('q');
  await new Promise((done) => setTimeout(done, 50));
  const other = createWorkbenchClient(origin, (request) => app.fetch(request));
  const attached = await other.connect();
  assert.equal(attached.attention[0]?.id, initial.attention[0]?.id);
  assert.equal(attached.attention[0]?.status, 'pending');
  assert.equal(attached.runs[0]?.state.kind, 'running');
});

test('terminal text editing deletes whole graphemes and treats pasted commands as text', async (t) => {
  let value = 'a👩‍💻中';
  function Harness() {
    const [text, setText] = useState(value);
    return (
      <Box flexDirection="column">
        <Text>{text}</Text>
        <PromptInput
          id="test"
          active
          value={text}
          width={70}
          onChange={(next) => {
            value = next;
            setText(next);
          }}
          onSubmit={() => {}}
          onEscape={() => {}}
        />
      </Box>
    );
  }
  const ui = render(<Harness />);
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  await frameHas(ui, 'a👩‍💻中');
  ui.stdin.write('\u001b[D');
  await new Promise((done) => setTimeout(done, 25));
  ui.stdin.write('\u007f');
  await until(() => value === 'a中');
  ui.stdin.write('\u001b[200~:cancel\n中文\u001b[201~');
  await until(() => value === 'a:cancel 中文中');
});

test('Ink frames fit terminal cells with long CJK, diff and all optional controls', () => {
  const runId = 'run-layout';
  const state: WorkbenchState = {
    runs: [
      {
        id: runId,
        provider: 'fixture',
        label: '長專案名稱'.repeat(25),
        state: { kind: 'running' },
        environment: {
          kind: 'trusted-fixture-directory',
          location: '/tmp/' + '中文路徑/'.repeat(40),
        },
        capabilities: null,
      },
    ],
    attention: [
      {
        id: 'attn-layout',
        runId,
        title: '核准長指令'.repeat(25),
        detail: 'command '.repeat(300),
        status: 'pending',
        createdAt: '2026-10-19T00:00:00Z',
        choices: [
          { id: 'one', label: '允許一次', kind: 'allow-once' },
          { id: 'two', label: '拒絕一次', kind: 'reject-once' },
        ],
      },
    ],
    events: [
      {
        runId,
        sequence: 1,
        at: '2026-10-19T00:00:00Z',
        type: 'agent.message',
        text: '\u001b]0;unsafe title\u0007' + '長訊息 '.repeat(200),
      },
      {
        runId,
        sequence: 2,
        at: '2026-10-19T00:00:00Z',
        type: 'diff',
        path: '/tmp/' + '路徑/'.repeat(40),
        oldText: 'old '.repeat(100),
        newText: '新程式碼 '.repeat(100),
      },
    ],
    cursor: 2,
    reset: true,
    source: '/projects/' + '中文專案/'.repeat(40),
  };
  for (const [columns = 80, rows = 24] of [
    [120, 36],
    [80, 24],
    [60, 20],
    [40, 12],
  ]) {
    for (const view of ['live', 'diff', 'timeline'] as const) {
      for (const expanded of [false, true]) {
        const output = renderToString(
          <WorkbenchScreen
            state={state}
            selectedId={runId}
            filter="active"
            view={view}
            request={state.attention[0]}
            armed
            connected
            busy={false}
            note="Ready"
            project={expanded}
            options={expanded}
            help={expanded}
            details={expanded}
            mode={expanded ? 'reply' : 'normal'}
            offset={0}
            columns={columns}
            rows={rows}
            input={<Text>中文字輸入測試</Text>}
          />,
          { columns },
        );
        assert.ok(
          output.split('\n').length <= rows,
          `${columns}×${rows} ${view} too tall`,
        );
        for (const line of output.split('\n'))
          assert.ok(
            stringWidth(line) <= columns,
            `${columns} ${view}: ${line}`,
          );
        assert.ok(!output.includes('unsafe title'));
        if (expanded && columns >= 60)
          assert.ok(
            output.includes(':answer 1'),
            'Requested decision details must be visible',
          );
      }
    }
  }
});

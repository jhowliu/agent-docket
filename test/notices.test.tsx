import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';
import { WorkbenchApp } from '../src/app/tui-app.js';
import { WorkbenchScreen } from '../src/app/tui-view.js';

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('TUI condition timed out');
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
const escaped = (text: string) => text.replace(/[()]/g, '\\$&');
/** A stacked roster row: glyph, unselected cursor, the Run (its title may be cut) and its state label. */
const rowOf = (icon: string, run: string, label: string) =>
  new RegExp(`${icon} {3}${run} · [^│\n]* ${escaped(label)}`);
/** A left-column agent: glyph, unselected cursor and the Run, then its state beneath. */
const agentOf = (icon: string, run: string, state: string) =>
  new RegExp(`${icon} {3}${run} · [^\n]*\n {4}${escaped(state)} · `);
const turnsOf = (state: WorkbenchState, runId: string) =>
  state.events.filter(
    (event) => event.type === 'turn.end' && event.runId === runId,
  ).length;

test('background Runs turn unread, are announced once after the delay, and w jumps to them', async (t) => {
  const app = createWebWorkbench(origin);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  t.after(() => app.close());
  await client.connect();
  const one = await client.command({ kind: 'start' });
  const two = await client.command({ kind: 'start' });
  assert.ok('runId' in one && 'runId' in two);
  // A turn that ended before the TUI connected counts as seen.
  await client.command({ kind: 'prompt', runId: two.runId, text: 'reply:a' });
  const initial = await stateWhen(
    client,
    (state) =>
      turnsOf(state, two.runId) === 1 &&
      state.runs.every((run) => run.state.kind === 'idle'),
  );
  const run2 = `Run 2 · ${initial.runs.find((run) => run.id === two.runId)?.label}`;
  const alerts: string[] = [];
  const ui = render(
    <WorkbenchApp
      client={client}
      initial={initial}
      pollInterval={20}
      notify={(text) => alerts.push(text)}
    />,
  );
  t.after(() => {
    ui.unmount();
    ui.cleanup();
  });
  const frame = () => ui.lastFrame() ?? '';
  const frameHas = (text: string | RegExp, present = true) =>
    until(
      () =>
        (typeof text === 'string'
          ? frame().includes(text)
          : text.test(frame())) === present,
    ).catch(() => {
      throw new Error(`Expected ${present ? '' : 'no '}${text}\n${frame()}`);
    });
  await frameHas('> Run 1');
  assert.match(frame(), agentOf('○', 'Run 2', 'idle'));

  const sent = Date.now();
  await client.command({ kind: 'prompt', runId: two.runId, text: 'reply:b' });
  await frameHas(`${run2} ended a turn · w jump`);
  assert.ok(Date.now() - sent >= 1000, 'notices wait for the delay');
  assert.match(frame(), agentOf('●', 'Run 2', 'unread'));
  assert.deepEqual(alerts, [`${run2} ended a turn · w jump`]);

  // Once shown, the Run is read and its notice gone.
  ui.stdin.write('w');
  await frameHas('> Run 2');
  await frameHas('ended a turn', false);
  ui.stdin.write('k');
  await frameHas('> Run 1');
  assert.match(frame(), agentOf('○', 'Run 2', 'idle'));

  // The selected Run's own turn is already on screen.
  await client.command({ kind: 'prompt', runId: one.runId, text: 'reply:c' });
  await stateWhen(client, (state) => turnsOf(state, one.runId) === 1);
  await new Promise((done) => setTimeout(done, 1300));
  assert.doesNotMatch(frame(), /Unread|ended a turn/);
  assert.equal(alerts.length, 1);

  // An approval answered elsewhere within the delay is never announced; the
  // turn it ends still is.
  const shown = ui.frames.length;
  await client.command({
    kind: 'prompt',
    runId: two.runId,
    text: 'command-permission',
  });
  const asked = await stateWhen(client, (state) =>
    state.attention.some(
      (item) => item.runId === two.runId && item.status === 'pending',
    ),
  );
  const item = asked.attention.find((entry) => entry.status === 'pending');
  assert.ok(item?.kind === 'permission');
  const allow = item.choices.find((choice) => choice.kind === 'allow-once');
  assert.ok(allow);
  await client.command({ kind: 'answer', id: item.id, choiceId: allow.id });
  await frameHas(`${run2} ended a turn · w jump`);
  assert.ok(
    !ui.frames.slice(shown).some((text) => text.includes('needs approval')),
  );

  // A pending approval outranks unread in the row, the notice and w.
  await client.command({
    kind: 'prompt',
    runId: two.runId,
    text: 'command-permission',
  });
  // The header's pending count leaves the notice less room; the alert is whole.
  await frameHas(`${run2} needs approval`);
  assert.match(frame(), agentOf('◉', 'Run 2', 'approve (1)'));
  assert.equal(alerts.at(-1), `${run2} needs approval · w jump`);
  ui.stdin.write('w');
  await frameHas('> Run 2');
  await frameHas('needs approval', false);
  // The left column's short label is spelled out beside the selected Run's title.
  assert.match(frame(), /Run 2 · [^│\n]*Awaiting approval \(1\)/);
});

test('notices and roster icons fit narrow terminals', async (t) => {
  const app = createWebWorkbench(origin);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  t.after(() => app.close());
  await client.connect();
  const one = await client.command({ kind: 'start' });
  const two = await client.command({ kind: 'start' });
  assert.ok('runId' in one && 'runId' in two);
  const state = await stateWhen(client, (state) =>
    state.runs.every((run) => run.state.kind === 'idle'),
  );
  for (const [columns, rows] of [
    [120, 36],
    [80, 24],
    [60, 20],
  ] as const) {
    const output = renderToString(
      <WorkbenchScreen
        state={state}
        selectedId={one.runId}
        filter="active"
        view="timeline"
        offset={0}
        request={undefined}
        armed
        connected
        busy={false}
        note=""
        options={false}
        help={false}
        details={false}
        mode="normal"
        columns={columns}
        rows={rows}
        unread={new Set([two.runId])}
        notice={{
          text: 'Run 2 · ' + '很長的任務名稱 '.repeat(12) + 'ended a turn',
          color: 'magenta',
        }}
      />,
      { columns },
    );
    for (const line of output.split('\n'))
      assert.ok(stringWidth(line) <= columns, `${columns}: ${line}`);
    assert.match(
      output,
      columns >= 80
        ? agentOf('●', 'Run 2', 'unread')
        : rowOf('●', 'Run 2', 'Unread'),
      output,
    );
    // The header holds the notice beside the left column; narrower, the roster title.
    assert.match(output, /(workbench|agents).*Run 2 · 很長/, output);
  }
});

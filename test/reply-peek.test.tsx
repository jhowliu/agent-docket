import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';
import { WorkbenchApp } from '../src/app/tui-app.js';

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('Reply condition timed out');
}
async function stateWhen(
  client: WorkbenchClient,
  predicate: (state: WorkbenchState) => boolean,
) {
  await until(async () => predicate(await client.poll()));
}
const origin = 'http://127.0.0.1:4177';

test('Space reads a turn’s reply in the right pane; arrows scroll it or select Timeline rows while j/k move between Runs', async (t) => {
  const app = createWebWorkbench(origin);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  const runId = started.runId;
  await client.command({ kind: 'start' });
  await stateWhen(client, (state) =>
    state.runs.every((run) => run.state.kind === 'idle'),
  );
  await client.command({ kind: 'prompt', runId, text: 'lines:40' });
  await stateWhen(
    client,
    (state) =>
      state.events.some(
        (event) => event.type === 'turn.end' && event.runId === runId,
      ) && state.runs.find((run) => run.id === runId)?.state.kind === 'idle',
  );
  const ui = render(
    <WorkbenchApp
      client={client}
      initial={await client.poll()}
      pollInterval={25}
    />,
  );
  t.after(async () => {
    ui.unmount();
    ui.cleanup();
    await app.close();
  });
  const frame = () => ui.lastFrame() ?? '';
  const has = (text: string, present = true) =>
    until(() => frame().includes(text) === present).catch(() => {
      throw new Error(`Expected ${present ? '' : 'no '}${text}\n${frame()}`);
    });
  const key = async (value: string) => {
    ui.stdin.write(value);
    await new Promise((done) => setTimeout(done, 40));
  };
  // The first reply line on screen.
  const top = () => Number(/│ Line (\d+)\s/.exec(frame())?.[1]);

  // The turn's result row points at its reply.
  await has('Space reply · 40 lines');
  await key(' ');
  await has('Reply · lines:40');
  await has('Esc close');
  assert.equal(top(), 1, frame());
  await key('\u001b[B');
  await key('\u001b[B');
  assert.equal(top(), 5, frame());
  await key('\u0004'); // Ctrl+D pages without a PgDn key.
  assert.ok(top() > 5, frame());
  // At the end, the first key back moves at once: scrolling never overshoots.
  await key('G');
  await has('│ Line 40 ');
  const end = top();
  await key('\u001b[B');
  await key('\u001b[A');
  assert.equal(top(), end - 2, frame());
  await key('g');
  assert.equal(top(), 1, frame());
  await key('\u001b');
  await has('Reply · lines:40', false);
  await has('Space reply · 40 lines');

  // In Timeline arrows select rows, never Runs; Space opens that row's turn.
  await key('\u001b[A');
  await has('row ');
  assert.match(frame(), /> Run 1/, frame());
  await key(' ');
  await has('Reply · lines:40');
  // Any other key closes the reply and acts: Enter answers what was read.
  await key('\r');
  await has('Reply · lines:40', false);
  await has('Reply · Enter send');
  await key('\u001b');
  await has('Reply · Enter send', false);

  // j/k still move between Runs; in Live arrows scroll lines.
  await key('j');
  await has('> Run 2');
  await key('k');
  await has('> Run 1');
  await key(':');
  await has('Command');
  await key('live');
  await key('\r');
  await has('Live diagnostics');
  await has('↑↓ scroll');
  await key('\u001b[A');
  await has('paused');
  await key('G');
  await has('paused', false);
  assert.match(frame(), /> Run 1/, frame());
});

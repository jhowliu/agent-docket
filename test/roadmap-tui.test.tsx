import test from 'node:test';
import assert from 'node:assert/strict';
import { Text, renderToString } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import { WorkbenchApp } from '../src/app/tui-app.js';
import { WorkbenchScreen } from '../src/app/tui-view.js';
import { trackedWork } from '../src/app/workbench-work.js';

const origin = 'http://127.0.0.1:4177';
async function until(check: () => boolean | Promise<boolean>) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('Roadmap TUI condition timed out');
}

test('Ink enables Roadmap tracking explicitly, confirms scope and leaves direct Runs compact', async (t) => {
  const app = createWebWorkbench(origin);
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const one = await client.command({ kind: 'start' });
  const two = await client.command({ kind: 'start' });
  assert.ok('runId' in one && 'runId' in two);
  const initial = await client.poll();
  const ui = render(
    <WorkbenchApp client={client} initial={initial} pollInterval={20} />,
  );
  t.after(async () => {
    ui.unmount();
    ui.cleanup();
    await app.close();
  });
  const frameHas = (text: string, present = true) =>
    until(() => Boolean(ui.lastFrame()?.includes(text)) === present).catch(
      () => {
        throw new Error(
          `Expected ${present ? '' : 'no '}${text}\n${ui.lastFrame()}`,
        );
      },
    );
  async function command(text: string) {
    ui.stdin.write(':');
    await frameHas('Command · Enter');
    ui.stdin.write(text);
    await frameHas(': ' + text);
    ui.stdin.write('\r');
    await frameHas('Command · Enter', false);
    await frameHas('Sending', false);
  }
  await frameHas('> Run 1');
  await frameHas('Current step', false);
  await command('roadmap Token validation');
  await frameHas('Current step');
  assert.ok(trackedWork(await client.poll(), one.runId));
  await command('spec Reject expired tokens at the boundary.');
  await command('confirm');
  await until(
    async () =>
      trackedWork(await client.poll(), one.runId)?.task.stage === 'development',
  );
  await command('phase Delivery');
  ui.stdin.write('o');
  await frameHas('[/] Phases');
  ui.stdin.write(']');
  await frameHas('Phase 2/2 · Viewing');
  await frameHas('Delivery');
  const plan = (await client.poll()).work?.plan;
  assert.equal(plan?.activePhaseId, plan?.phases[0]?.id);
  ui.stdin.write('\u001b');
  await frameHas('[/] Phases', false);
  ui.stdin.write('j');
  await frameHas('> Run 2');
  await frameHas('Current step', false);
  await command('track 1.1');
  await frameHas('Current step');
  await command('direct');
  await frameHas('Current step', false);
  assert.equal(trackedWork(await client.poll(), two.runId), null);
  assert.equal((await client.poll()).work?.plan?.phases.length, 2);
});

test('Workflow stays separate from content tabs, fits terminal cells and never implies review passed', async (t) => {
  const app = createWebWorkbench(origin);
  t.after(() => app.close());
  const client = createWorkbenchClient(origin, (request) => app.fetch(request));
  await client.connect();
  const started = await client.command({ kind: 'start' });
  assert.ok('runId' in started);
  await client.command({
    kind: 'work.create',
    expectedRevision: 0,
    runId: started.runId,
    title: 'Authentication',
    phaseTitle: 'Boundary checks',
    taskTitle: 'Capture check results',
    spec: 'Preserve the refresh behavior.',
  });
  await client.command({ kind: 'prompt', runId: started.runId, text: 'fix' });
  let state = await client.poll();
  await until(async () => {
    state = await client.poll();
    return state.attention.some((item) => item.status === 'pending');
  });
  for (const [columns, rows] of [
    [60, 20],
    [79, 20],
    [80, 20],
    [80, 24],
    [120, 24],
    [120, 36],
  ] as const)
    for (const outline of [false, true])
      for (const mode of ['normal', 'reply', 'command'] as const) {
        const output = renderToString(
          <WorkbenchScreen
            state={state}
            selectedId={started.runId}
            filter="active"
            view="timeline"
            offset={0}
            request={state.attention.find((item) => item.status === 'pending')}
            armed
            connected
            busy={false}
            note="Roadmap ready"
            project={false}
            options={false}
            help={false}
            details={false}
            outline={outline}
            outlinePhase={0}
            mode={mode}
            input={<Text>Draft text</Text>}
            columns={columns}
            rows={rows}
          />,
          { columns },
        );
        const lines = output.split('\n');
        assert.ok(lines.length <= rows, output);
        assert.ok(
          lines.every((line) => stringWidth(line) <= columns),
          output,
        );
        assert.match(output, /1 Live\s+2 Diff\s+3 Timeline/);
        assert.match(output, /APPROVAL 1\/1/);
        assert.match(output, /q quit/);
        if (columns >= 80 || outline) assert.match(output, /Phase 1\/1/);
        else {
          assert.match(output, /o Workflow/);
          assert.doesNotMatch(output, /Current step/);
          // Only the roster's project line names the Phase.
          assert.ok(
            lines
              .filter((line) => line.includes('Phase 1/1'))
              .every((line) => line.includes('project · next: approve Run 1')),
            output,
          );
        }
        if (columns >= 80) {
          const panel = lines.find((line) =>
            line.includes(outline ? 'Roadmap' : 'Workflow'),
          );
          assert.ok(
            panel &&
              panel.indexOf(outline ? 'Roadmap' : 'Workflow') > columns / 2,
            output,
          );
          if (!outline) assert.match(output, /> Requirement clarification/);
        }
        assert.doesNotMatch(output, /Review passed|Task accepted|Complete/);
        assert.ok(!output.includes('resultsAwaiting'), output);
        if (outline) assert.match(output, /Boundary checks/);
      }
});

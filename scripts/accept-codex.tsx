import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { render } from 'ink-testing-library';
import { z } from 'zod';
import type { AttentionItem } from '../src/attention/index.js';
import { loadLaunchConfig } from '../src/app/launch-config.js';
import { WorkbenchApp } from '../src/app/tui-app.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';

const exec = promisify(execFile);
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--launch' || !args[1])
  throw new Error(
    'Usage: npm run qa:codex -- --launch /absolute/path/to/local-config.json',
  );
const { launch } = await loadLaunchConfig(args[1]);
if (
  launch.provider !== 'codex' ||
  launch.worker.transport !== 'local' ||
  launch.worker.adapter
)
  throw new Error(
    'Live acceptance requires local Codex with the bundled adapter',
  );

// The sample project is disposable input; the adapter and model are real.
const parent = resolve('.workbench/acceptance/codex-workflow');
await mkdir(parent, { recursive: true, mode: 0o700 });
const output = await mkdtemp(join(parent, 'trial-'));
const source = resolve('fixtures/project');
const project = join(output, 'project');
await cp(source, project, { recursive: true });
const git = async (...args: string[]) =>
  (
    await exec('git', [
      '-C',
      project,
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ])
  ).stdout.trim();
await git('init', '--quiet');
await git('config', 'user.name', 'Workbench Acceptance');
await git('config', 'user.email', 'acceptance@example.invalid');
await git('add', '.');
await git('commit', '-qm', 'Disposable acceptance project');
const sourceRevision = await git('rev-parse', 'HEAD');
const fingerprint = async () =>
  Object.fromEntries(
    await Promise.all(
      ['README.md', 'token.mjs'].map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(join(source, name)))
          .digest('hex'),
      ]),
    ),
  );
const before = await fingerprint();
const origin = 'http://127.0.0.1:4181';
const app = createWebWorkbench(origin, {
  launch: {
    ...launch,
    source: { kind: 'directory', path: project },
    label: 'Codex live workflow acceptance',
  },
});
const client = createWorkbenchClient(origin, (request) => app.fetch(request));
let state = await client.connect();
const ui = render(
  <WorkbenchApp
    client={client}
    initial={state}
    pollInterval={100}
    projectPath={project}
  />,
);
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const print = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + '\n');
const results: Record<string, unknown> = {};
let cursor = 0;
let failure: string | null = null;
let cancelPid: number | undefined;
let workspace: string | undefined;

async function waitFor(
  predicate: (snapshot: WorkbenchState) => boolean | Promise<boolean>,
  timeout = 90_000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    state = await client.poll();
    for (const event of state.events.filter((item) => item.sequence > cursor)) {
      cursor = event.sequence;
      if (event.type === 'run.state') print({ state: event.state });
      if (event.type === 'tool')
        print({ tool: event.title, status: event.status });
      if (event.type === 'agent.progress') print({ progress: event.summary });
      if (event.type === 'attention') print({ approval: event.status });
    }
    if (await predicate(state)) return;
    const run = state.runs[0];
    if (
      run &&
      ['failed', 'interrupted', 'authentication-required'].includes(
        run.state.kind,
      )
    )
      throw new Error('Run is unavailable: ' + JSON.stringify(run.state));
    await pause(50);
  }
  throw new Error('Live acceptance condition timed out');
}
async function frameHas(text: string, present = true) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    if (Boolean(ui.lastFrame()?.includes(text)) === present) return;
    await pause(20);
  }
  throw new Error('TUI condition timed out: ' + text);
}
async function prompt(text: string) {
  // The provider may finish before the TUI's next poll reflects its Idle state.
  await frameHas('Idle');
  await frameHas('Sending', false);
  ui.stdin.write('i');
  await frameHas('Reply · Enter');
  ui.stdin.write(text);
  await pause(30);
  ui.stdin.write('\r');
  await frameHas('Reply · Enter', false);
}
async function turnFinished(after: number) {
  await waitFor((snapshot) => {
    if (snapshot.attention.some((item) => item.status === 'pending'))
      throw new Error('Unexpected additional approval; no response was sent');
    return (
      snapshot.runs[0]?.state.kind === 'idle' &&
      snapshot.events.some(
        (event) => event.sequence > after && event.type === 'turn.end',
      )
    );
  });
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    )
      return false;
    throw error;
  }
};
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

print({
  output,
  purpose:
    'Real Codex on disposable sample code; Ink input and in-memory app transport; no listener',
});
try {
  ui.stdin.write('n');
  await frameHas('New Session');
  ui.stdin.write('\r');
  await frameHas('Enter create');
  await pause(40);
  ui.stdin.write('\r');
  await waitFor((snapshot) => snapshot.runs[0]?.state.kind === 'idle');
  await frameHas('Idle');
  const run = state.runs[0];
  assert.ok(
    run && run.provider === 'codex' && run.environment.kind === 'local',
  );
  workspace = run.environment.location;
  assert.ok(run.worktree);
  assert.notEqual(workspace, source);
  await client.command({
    kind: 'work.create',
    expectedRevision: 0,
    runId: run.id,
    title: 'Live workflow acceptance',
    phaseTitle: 'Real execution',
    taskTitle: 'Fix token expiry',
    spec: 'A token is expired exactly when expiry <= now. Preserve the before/after cases. Add Node built-in tests and run them. Change only token.mjs and token.test.mjs; do not install dependencies, start services, or create commits.',
  });
  state = await client.poll();
  const plan = state.work?.plan;
  const task = plan?.phases[0]?.tasks[0];
  assert.ok(plan && task);
  await client.command({
    kind: 'work.confirm',
    expectedRevision: plan.revision,
    taskId: task.id,
  });
  results.requirements = 'confirmed';

  let after = state.cursor;
  await prompt(
    'Implement the confirmed Task requirements. Read README.md and token.mjs, use apply_patch to fix the boundary and add token.test.mjs, then run node --test token.test.mjs. Report the actual result.',
  );
  await turnFinished(after);
  const checked = await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'import assert from "node:assert/strict"; import {expired} from "./token.mjs"; assert.equal(expired(10,9),false); assert.equal(expired(10,10),true); assert.equal(expired(10,11),true);',
    ],
    { cwd: workspace, timeout: 10_000 },
  );
  const tests = await exec(process.execPath, ['--test', 'token.test.mjs'], {
    cwd: workspace,
    timeout: 10_000,
  });
  assert.notEqual(
    await readFile(join(workspace, 'token.mjs'), 'utf8'),
    await readFile(join(source, 'token.mjs'), 'utf8'),
  );
  assert.ok(
    state.events.some(
      (event) => event.type === 'diff' && event.path.endsWith('token.mjs'),
    ),
    'Native edit must reach Diff',
  );
  assert.ok(
    state.events.some((event) => event.type === 'agent.progress'),
    'Native task must report progress',
  );
  results.edit = {
    independentBoundaryCheck: 'passed',
    stdout: checked.stdout,
    tests: tests.stdout,
    diffObserved: true,
  };
  await writeFile(join(output, 'edit-frame.txt'), ui.lastFrame() ?? '', {
    mode: 0o600,
  });
  print({ phase: 'edit', passed: true });

  for (const decision of ['allow', 'reject'] as const) {
    const marker = 'WORKBENCH_APPROVAL_' + randomUUID();
    const file = 'approval-' + decision + '.txt';
    const command =
      'node -e ' +
      quote(
        `require('node:fs').writeFileSync('${file}', '${marker}'); console.log('${marker}')`,
      );
    after = state.cursor;
    await prompt(
      `This is an approval-transport acceptance check. Request elevated execution explicitly with sandbox_permissions=require_escalated and a justification. Execute exactly this harmless command from the current workspace: ${command}. Wait for the decision. If rejected, stop without retrying or using another tool. Do not perform this check without requesting approval.`,
    );
    await waitFor(
      (snapshot) =>
        snapshot.attention.some(
          (item) => item.runId === run.id && item.status === 'pending',
        ) ||
        snapshot.events.some(
          (event) => event.sequence > after && event.type === 'turn.end',
        ),
    );
    const request: AttentionItem | undefined = state.attention.find(
      (item) => item.runId === run.id && item.status === 'pending',
    );
    assert.ok(request, 'The model must create a genuine permission request');
    const permission = z
      .object({
        kind: z.literal('execute'),
        status: z.literal('pending'),
        rawInput: z.object({ command: z.string(), cwd: z.string() }).strict(),
      })
      .parse(JSON.parse(request.detail));
    // The pinned adapter JSON-encodes shell commands in rawInput.command.
    const requestedCommand: unknown = JSON.parse(permission.rawInput.command);
    assert.equal(
      requestedCommand,
      command,
      'Only the exact marker command may be answered',
    );
    assert.equal(
      permission.rawInput.cwd,
      workspace,
      'Approval must target the owned Run workspace',
    );
    const choice = request.choices.find(
      (choice) => choice.kind === decision + '-once',
    );
    assert.ok(choice);
    await frameHas('Approval');
    ui.stdin.write('\t'); // Explicitly select each new decision, never reuse the previous one.
    await frameHas((decision === 'allow' ? 'a ' : 'r ') + choice.label);
    ui.stdin.write(decision === 'allow' ? 'a' : 'r');
    await waitFor((snapshot) =>
      snapshot.attention.some(
        (item) => item.id === request.id && item.status === 'delivered',
      ),
    );
    await turnFinished(after);
    const transitions = state.events
      .filter((event) => event.type === 'attention' && event.id === request.id)
      .map((event) => (event.type === 'attention' ? event.status : ''));
    assert.ok(
      transitions.indexOf('accepted') >= 0 &&
        transitions.indexOf('delivered') > transitions.indexOf('accepted'),
    );
    if (decision === 'allow')
      assert.equal(await readFile(join(workspace, file), 'utf8'), marker);
    else await assert.rejects(access(join(workspace, file)));
    results[decision] = {
      transitions,
      commandMarkerObserved: decision === 'allow',
    };
    print({ phase: decision, passed: true });
  }

  const marker = 'WORKBENCH_CANCEL_' + randomUUID();
  const command =
    'node -e ' +
    quote(
      `require('node:fs').writeFileSync('cancel-pid.txt',String(process.pid));console.log('${marker}');setTimeout(()=>{},180000)`,
    );
  await prompt(
    `Run this harmless foreground command with yield_time_ms=1000: ${command}. Do not detach it, start another command, or finish the turn before it completes. The operator will cancel the Run while it is active.`,
  );
  await waitFor(async (snapshot) => {
    if (snapshot.attention.some((item) => item.status === 'pending'))
      throw new Error('Unexpected approval for the cancellation command');
    try {
      const text = await readFile(
        join(workspace ?? '', 'cancel-pid.txt'),
        'utf8',
      );
      assert.match(text, /^\d+$/);
      cancelPid = Number(text);
      assert.ok(
        Number.isSafeInteger(cancelPid) &&
          cancelPid > 1 &&
          cancelPid !== process.pid,
      );
      return snapshot.runs[0]?.state.kind === 'running' && alive(cancelPid);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return false;
      throw error;
    }
  });
  assert.ok(cancelPid);
  // The native command may yield while its OS process keeps running. The PID
  // and Running state establish liveness independently of a tool status label.
  await frameHas('Sending', false);
  state = await client.poll();
  assert.equal(
    state.runs[0]?.state.kind,
    'running',
    'Cancel must target an active turn',
  );
  assert.ok(
    alive(cancelPid),
    'The owned command must still be alive before cancel',
  );
  ui.stdin.write('x');
  await waitFor(
    () => state.runs[0]?.state.kind === 'cancelled' && !alive(cancelPid ?? 0),
    10_000,
  );
  assert.ok(
    !state.attention.some(
      (item) => item.status === 'pending' || item.status === 'accepted',
    ),
  );
  results.cancellation = {
    observedRunningPid: cancelPid,
    processStopped: true,
    finalState: state.runs[0]?.state,
  };
  print({ phase: 'cancellation', passed: true });
  assert.equal(state.runs[0]?.worktree?.status.kind, 'commit-required');
  const savedToken = await readFile(join(workspace, 'token.mjs'), 'utf8');
  await frameHas('Commit required');
  await frameHas('Sending', false);
  ui.stdin.write('c');
  await frameHas(': commit');
  ui.stdin.write('Save worktree acceptance changes');
  await frameHas('Save worktree acceptance changes');
  ui.stdin.write('\r');
  await waitFor(
    () => state.runs[0]?.worktree?.status.kind === 'removed',
    15_000,
  );
  await assert.rejects(access(workspace));
  assert.equal(await git('rev-parse', 'HEAD'), sourceRevision);
  assert.equal(await git('status', '--porcelain'), '');
  assert.equal(
    await git('show', `${run.worktree.branch}:token.mjs`),
    savedToken.trim(),
  );
  assert.equal(
    await git('log', '-1', '--format=%s', run.worktree.branch),
    'Save worktree acceptance changes',
  );
  results.worktree = {
    branch: run.worktree.branch,
    removed: true,
    originalHeadUnchanged: true,
    committedLocally: true,
    remotePush: false,
  };
  print({ phase: 'worktree-commit-cleanup', passed: true });
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  print({ error: failure });
} finally {
  state = await client.poll();
  await writeFile(
    join(output, 'observed-state.json'),
    JSON.stringify(state, null, 2),
    { mode: 0o600 },
  );
  ui.unmount();
  ui.cleanup();
  try {
    await app.close();
  } catch (error) {
    failure ??= String(error);
  }
  assert.deepEqual(
    await fingerprint(),
    before,
    'Source fixture must remain unchanged',
  );
  const cancelledProcessStillAlive =
    cancelPid !== undefined && alive(cancelPid);
  if (cancelledProcessStillAlive)
    failure ??=
      'The owned cancellation command is still alive; it has a 180-second upper bound';
  const result = {
    passed: failure === null,
    error: failure,
    results,
    originalFilesUnchanged: true,
    cancelledProcessStillAlive,
    workspace,
    output,
    scope:
      'Real bundled Codex adapter and model, actual Ink input, disposable sample code, in-memory transport; no listener or physical terminal',
  };
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  print(result);
}
if (failure) process.exitCode = 1;

import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { RunId } from '../src/execution/index.js';
import { createWebWorkbench } from '../src/app/web-workbench.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';
import type { WorkbenchState } from '../src/app/workbench-protocol.js';

// The whole Task flow with a real agent: Roadmap → finished → checks → Agent
// Review → Human Review → accept. The sample project is a disposable copy;
// the adapters, the models and the person's logins are real.
//
// --provider codex (default) | claude: the agent that develops.
// --reviewer same (default) | codex | claude: the agent that reviews.
//
// --scenario passing (default): one prompt asks for what the spec asks.
// --scenario fix-checks / fix-review: the spec also expires a non-finite
// expiry, but the prompt asks only for the comparison. fix-checks also runs a
// check kept outside the project, so the first checks should fail; in
// fix-review only the boundary is checked, so the review should find the gap.
const exec = promisify(execFile);
const scenarios = ['passing', 'fix-checks', 'fix-review'] as const;
const usage =
  'Usage: npm run qa:loop -- [--scenario passing|fix-checks|fix-review] [--provider codex|claude] [--reviewer same|codex|claude]';
const option = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const scenario = option('scenario', 'passing');
const provider = option('provider', 'codex');
const reviewer = option('reviewer', 'same');
if (
  !scenarios.some((name) => name === scenario) ||
  (provider !== 'codex' && provider !== 'claude') ||
  (reviewer !== 'same' && reviewer !== 'codex' && reviewer !== 'claude')
)
  throw new Error(usage);
const partial = scenario !== 'passing';
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const authFile = resolve(homedir(), '.codex/auth.json');
const signedIn = await exists(authFile);
const claudeTokenFile = resolve(
  process.env.WORKBENCH_CLAUDE_TOKEN_FILE ??
    resolve(homedir(), '.config/agent-docket/claude-token'),
);
const agents = new Set([provider, reviewer === 'same' ? provider : reviewer]);
if (
  agents.has('codex') &&
  !signedIn &&
  !process.env.CODEX_API_KEY &&
  !process.env.OPENAI_API_KEY
)
  throw new Error(
    'Sign in to Codex first (~/.codex/auth.json) or set CODEX_API_KEY',
  );
if (agents.has('claude') && !(await exists(claudeTokenFile)))
  throw new Error(
    `Save a token from \`claude setup-token\` to ${claudeTokenFile} first`,
  );
const limit = Number(process.env.WORKBENCH_LOOP_MINUTES ?? 30) * 60_000;

const parent = resolve('.workbench/acceptance/task-flow');
await mkdir(parent, { recursive: true, mode: 0o700 });
const output = await mkdtemp(join(parent, 'trial-'));
const project = join(output, 'project');
await cp(resolve('fixtures/project'), project, { recursive: true });
await writeFile(
  join(project, 'check.mjs'),
  [
    "import assert from 'node:assert/strict';",
    "import { expired } from './token.mjs';",
    '// A token expires when expiry <= now.',
    'assert.equal(expired(9, 10), true);',
    'assert.equal(expired(10, 10), true);',
    'assert.equal(expired(11, 10), false);',
    "console.log('token checks passed');",
    '',
  ].join('\n'),
);
const hidden = join(output, 'hidden-check.mjs');
await writeFile(
  hidden,
  [
    "import assert from 'node:assert/strict';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const { expired } = await import(pathToFileURL(join(process.cwd(), 'token.mjs')).href);",
    '// A token whose expiry is not a finite number is expired.',
    'for (const expiry of [undefined, Number.NaN, Infinity])',
    '  assert.equal(expired(expiry, 10), true, `expired(${expiry}, 10) should be true`);',
    "console.log('non-finite expiry checks passed');",
    '',
  ].join('\n'),
);
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
await git('init', '--quiet', '-b', 'main');
await git('config', 'user.name', 'Workbench Acceptance');
await git('config', 'user.email', 'acceptance@example.invalid');
await git('add', '.');
await git('commit', '-qm', 'Disposable Task flow project');

const origin = 'http://127.0.0.1:4183';
const app = createWebWorkbench(origin, {
  localWorker: {
    transport: 'local',
    workspaceRoot: join(output, 'runs'),
    ...(signedIn ? { authFile } : {}),
    claudeTokenFile,
  },
  planDirectory: join(output, 'plans'),
});
const client = createWorkbenchClient(origin, (request) => app.fetch(request));
const started = Date.now();
const clock = () => {
  const seconds = Math.floor((Date.now() - started) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const log = (text: string) =>
  process.stdout.write(`[${clock()}] ${text.replace(/\s+/g, ' ')}\n`);
const short = (text: string, max = 160) =>
  text.length > max ? `${text.slice(0, max)}…` : text;
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const summary: Record<string, unknown> = {
  scenario,
  provider,
  reviewer,
  output,
};
let state: WorkbenchState = await client.connect();
let failure: string | null = null;
let runId: RunId | undefined;

try {
  const inspected = await client.project(project);
  const created = await client.command({
    kind: 'new-session',
    presetId: `${provider}-local`,
    project: {
      path: project,
      base: { branch: 'main', revision: inspected.head },
    },
  });
  if (!('runId' in created)) throw new Error('New Session did not start');
  runId = created.runId;
  const dev = runId;
  const name = (id: RunId) =>
    id === dev
      ? 'dev'
      : (state.runs.find((run) => run.id === id)?.label ?? 'reviewer');
  let cursor = 0;
  let stage = '';
  let flowText = '';
  const answered = new Set<string>();
  const counts = {
    permissions: 0,
    checks: 0,
    reviews: 0,
    checkFixes: 0,
    reviewFixes: 0,
  };
  /** Polls once, logging what changed and answering permission requests. */
  async function step() {
    state = await client.poll();
    for (const event of state.events.filter((item) => item.sequence > cursor)) {
      cursor = event.sequence;
      const who = name(event.runId);
      if (event.type === 'run.state')
        log(
          `${who} ${event.state.kind}${'reason' in event.state ? ` · ${event.state.reason}` : ''}`,
        );
      else if (event.type === 'turn.start') {
        log(`${who} prompt · ${short(event.text)}`);
        if (event.text.startsWith('Workbench Agent Review of '))
          counts.reviews++;
        else if (event.text.startsWith('Workbench checks failed'))
          counts.checkFixes++;
        else if (
          event.text.startsWith('Workbench Agent Review requested changes')
        )
          counts.reviewFixes++;
      } else if (event.type === 'agent.progress')
        log(
          `${who} ${event.finished ? 'finished' : 'progress'} · ${short(event.summary)}`,
        );
      else if (event.type === 'check.start') {
        counts.checks++;
        log(
          `checks started · ${event.command} · ${event.candidate.slice(0, 7)}`,
        );
      } else if (event.type === 'check.end')
        log(
          `checks ${event.outcome} · exit ${event.exitCode} · ${short(event.output.trim().split('\n').at(-1) ?? '')}`,
        );
      else if (event.type === 'turn.end')
        log(`${who} turn ended · ${event.reason}`);
      else if (event.type === 'diagnostic' && event.runId !== dev)
        log(`${who} · ${short(event.message)}`);
    }
    const work = state.projects?.find((item) =>
      item.runIds.includes(dev),
    )?.work;
    const task =
      work?.kind === 'ready' ? work.plan?.phases[0]?.tasks[0] : undefined;
    if (task && `${task.stage}/${task.status}` !== stage) {
      stage = `${task.stage}/${task.status}`;
      log(`Task · ${stage}`);
    }
    const flow = state.flows?.find((item) => item.runId === dev);
    const text = flow
      ? `${flow.step} (${flow.attempts} of 2)${flow.reason ? ` · ${flow.reason}` : ''}`
      : '';
    if (text !== flowText) {
      flowText = text;
      if (text) log(`flow · ${text}`);
    }
    for (const item of state.attention) {
      if (item.status !== 'pending' || answered.has(item.id)) continue;
      if (item.kind === 'agent-request') {
        log(`${name(item.runId)} asks the person · ${item.title}`);
        continue;
      }
      // The developer may act in its worktree; a reviewer should not edit.
      const wanted = item.runId === dev ? 'allow-once' : 'reject-once';
      const choice = item.choices.find((option) => option.kind === wanted);
      if (!choice) continue;
      answered.add(item.id);
      counts.permissions++;
      log(
        `${name(item.runId)} asks permission · ${short(item.subject ?? item.title)} → ${wanted}`,
      );
      await client.command({
        kind: 'answer',
        id: item.id,
        choiceId: choice.id,
      });
    }
    return { task, flow };
  }
  async function until(
    what: string,
    done: (current: Awaited<ReturnType<typeof step>>) => boolean,
  ) {
    while (Date.now() - started < limit) {
      const current = await step();
      if (done(current)) return current;
      const run = state.runs.find((item) => item.id === dev);
      if (
        !run ||
        [
          'failed',
          'interrupted',
          'cancelled',
          'authentication-required',
        ].includes(run.state.kind)
      )
        throw new Error(
          `dev Run is ${run ? JSON.stringify(run.state) : 'gone'}`,
        );
      if (current.flow?.step === 'stopped')
        throw new Error(`The flow stopped: ${current.flow.reason}`);
      await pause(1000);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  await until('the Run to start', () =>
    state.runs.some((run) => run.id === dev && run.state.kind === 'idle'),
  );
  const projectId = state.projects?.find((item) =>
    item.runIds.includes(dev),
  )?.id;
  if (!projectId) throw new Error('The Run has no project');
  await client.command({
    kind: 'set-check',
    projectId,
    command:
      scenario === 'fix-checks'
        ? `node check.mjs && node ${hidden}`
        : 'node check.mjs',
  });
  if (reviewer !== 'same')
    await client.command({
      kind: 'set-reviewer',
      projectId,
      provider: reviewer === 'claude' ? 'claude' : 'codex',
    });
  await client.command({
    kind: 'project-work',
    projectId,
    command: {
      kind: 'work.create',
      expectedRevision: 0,
      runId: dev,
      title: 'Tokens',
      phaseTitle: 'Expiry',
      taskTitle: 'Boundary',
      spec: partial
        ? 'A token expires when its expiry is at or before now: expired(expiry, now) returns true when expiry <= now. A token whose expiry is not a finite number (missing, NaN or Infinity) is also expired. Otherwise it returns false. Keep the function name and signature.'
        : 'A token expires when its expiry is at or before now: expired(expiry, now) returns true when expiry <= now and false otherwise. Keep the function name and signature.',
    },
  });
  const { task } = await step();
  const work = state.projects?.find((item) => item.id === projectId)?.work;
  if (!task || work?.kind !== 'ready' || !work.plan)
    throw new Error('The Roadmap was not created');
  await client.command({
    kind: 'project-work',
    projectId,
    command: {
      kind: 'work.confirm',
      expectedRevision: work.plan.revision,
      taskId: task.id,
    },
  });
  await client.command({
    kind: 'prompt',
    runId: dev,
    text: partial
      ? 'Change only the comparison in token.mjs so that a token whose expiry equals now is expired. Change nothing else for now.'
      : 'Fix the token expiry boundary in token.mjs as the Task describes.',
  });
  let quietSince = 0;
  await until('Human Review', ({ task: current, flow }) => {
    if (current?.stage === 'human-review' && current.status !== 'accepted')
      return true;
    // A turn that ended without a finished report starts nothing.
    const run = state.runs.find((item) => item.id === dev);
    const idle =
      run?.state.kind === 'idle' &&
      !flow &&
      !state.attention.some(
        (item) => item.runId === dev && item.status === 'pending',
      );
    if (!idle) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince > 20_000)
      throw new Error(
        'The agent ended its turn without reporting finished, so no checks started',
      );
    return false;
  });
  const review = state.reviews?.find((item) => item.runId === dev);
  log(`review · ${review?.status ?? 'none'} · ${review?.reason ?? ''}`);
  await client.command({ kind: 'accept', runId: dev });
  const accepted = await step();
  if (accepted.task?.status !== 'accepted')
    throw new Error('Accept did not apply');
  log('Task accepted');
  Object.assign(summary, counts, {
    review: review?.status,
    minutes: Math.round((Date.now() - started) / 6000) / 10,
  });
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  log(`FAILED · ${failure}`);
} finally {
  // Keep the Run's work on its branch in the disposable project, then stop.
  if (runId && state.runs.some((run) => run.id === runId)) {
    const last = await client
      .command({ kind: 'cancel', runId })
      .catch(() => null);
    if (last && 'branch' in last && last.branch) {
      summary.branch = last.branch;
      summary.token = await git('show', `${last.branch}:token.mjs`).catch(
        () => null,
      );
    }
  }
  state = await client.poll().catch(() => state);
  await writeFile(
    join(output, 'events.json'),
    JSON.stringify(state.events, null, 2),
  );
  await app.close();
  summary.result = failure ? `failed: ${failure}` : 'passed';
  await writeFile(
    join(output, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}
process.exitCode = failure ? 1 : 0;

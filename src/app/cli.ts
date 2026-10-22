import { createInterface } from 'node:readline';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { createAttention } from '../attention/index.js';
import type { AttentionId } from '../attention/index.js';
import { createExecution, parseLaunch } from '../execution/index.js';
import type { Launch, RunEvent, RunId } from '../execution/index.js';

const execFileAsync = promisify(execFile);
const clean = (text: string) =>
  stripVTControlCharacters(text).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    '',
  );
const message = (error: unknown) =>
  clean(error instanceof Error ? error.message : String(error));
async function config(path: string): Promise<Launch> {
  const input: unknown = JSON.parse(await readFile(path, 'utf8'));
  return parseLaunch(input);
}
async function save(events: readonly RunEvent[], path: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    { mode: 0o600 },
  );
  console.log('Replay saved: ' + resolve(path));
}
async function demo(): Promise<void> {
  const attention = createAttention(),
    runtime = createExecution({ attention });
  const allow = new Set<RunId>();
  // Auto-answer is deliberately restricted to this deterministic fixture command.
  attention.subscribe((item) => {
    if (
      item.status === 'pending' &&
      runtime.snapshot(item.runId).provider === 'fixture'
    )
      attention.answer(
        item.id,
        allow.has(item.runId) ? 'choice-0' : 'choice-1',
      );
  });
  runtime.subscribe((event) => console.log(JSON.stringify(event)));
  try {
    const one = await runtime.start({
        provider: 'fixture',
        label: 'fixture / allow',
      }),
      two = await runtime.start({
        provider: 'fixture',
        label: 'fixture / reject',
      });
    allow.add(one.id);
    await Promise.all([
      runtime.prompt(one.id, 'fix'),
      runtime.prompt(two.id, 'fix'),
    ]);
    await runtime.prompt(one.id, 'question');
    await runtime.prompt(one.id, 'reply:token-boundary');
    const waiting = runtime.prompt(two.id, 'wait');
    await runtime.cancel(two.id);
    await waiting;
    await runtime.close();
    await save(runtime.events(), '.workbench/replays/m0-demo.jsonl');
    console.log(
      'M0 fixture demo complete. No model/provider connection; real-provider acceptance remains unverified.',
    );
  } finally {
    await runtime.close();
  }
}
async function doctor(): Promise<void> {
  const checks = await Promise.allSettled([
    execFileAsync('codex', ['--version'], { timeout: 5000 }),
    execFileAsync('claude', ['--version'], { timeout: 5000 }),
    execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 5000,
    }),
  ]);
  const [codex, claude, docker] = checks;
  const version = (result: typeof codex) =>
    result?.status === 'fulfilled'
      ? clean(result.value.stdout.trim())
      : 'unavailable';
  const dockerVersion = version(docker);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        codex: version(codex),
        claude: version(claude),
        docker: {
          available: /^\d+\.\d+/.test(dockerVersion),
          version: /^\d+\.\d+/.test(dockerVersion) ? dockerVersion : null,
        },
        sdk: '1.9.0',
        realProviderValidation:
          'not performed; configure an explicit local Run or an isolated worker with authentication',
      },
      null,
      2,
    ),
  );
}
async function replay(path: string): Promise<void> {
  if ((await stat(path)).size > 16 * 1024 * 1024)
    throw new Error('Replay exceeds M0 size limit (16 MiB)');
  const envelope = z
    .object({
      sequence: z.number().int().positive(),
      runId: z.string().startsWith('run-'),
      at: z.string().datetime(),
      type: z.enum([
        'run.state',
        'capabilities',
        'agent.message',
        'agent.progress',
        'turn.start',
        'tool',
        'diff',
        'attention',
        'turn.end',
        'diagnostic',
      ]),
    })
    .passthrough();
  let last = 0;
  for (const line of (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())) {
    const raw: unknown = JSON.parse(line);
    const event = envelope.parse(raw);
    if (event.sequence <= last)
      throw new Error('Replay sequence is out of order');
    last = event.sequence;
    console.log(JSON.stringify(event));
  }
  console.log(
    'Historical replay only; no live session or permission callback was restored.',
  );
}
const help = `Commands:
  start fixture                 start trusted deterministic fixture
  start path/to/config.json     start a configured local Codex or container Run
  runs / use <run-number>       inspect or switch Run
  prompt <text>                 send a new prompt to the selected idle Run
  inbox                         show pending decisions across all Runs
  answer <item-number> <choice-number>
  auth <method-id>              use an advertised authentication method
  cancel [run-number]            cancel Run and clean up its environment
  commit <message>              commit a stopped worktree to its local branch and remove it
  save [path.jsonl]              export retained timeline
  help / quit
Fixture prompts: fix, question, reply:<answer>, wait, crash, unsupported-files.
M0 CLI owns its Runs: quit cleans them up. Persistent daemon/Ink UI are M1.`;
async function shell(initial?: Launch): Promise<void> {
  const attention = createAttention(),
    runtime = createExecution({ attention });
  const runNumbers = new Map<RunId, number>(),
    itemNumbers = new Map<AttentionId, number>();
  let current: RunId | undefined;
  let quitting = false;
  const background = new Set<Promise<void>>();
  const runNumber = (id: RunId) => {
    if (!runNumbers.has(id)) runNumbers.set(id, runNumbers.size + 1);
    return runNumbers.get(id);
  };
  runtime.subscribe((event) => {
    const number = runNumber(event.runId);
    if (event.type === 'agent.message')
      console.log(`[${number}] ${JSON.stringify(event.text)}`);
    else if (event.type === 'agent.progress')
      console.log(`[${number}] progress ${JSON.stringify(event.summary)}`);
    else if (event.type === 'turn.start')
      console.log(`[${number}] request ${JSON.stringify(event.text)}`);
    else if (event.type === 'run.state')
      console.log(`[${number}] ${JSON.stringify(event.state)}`);
    else if (event.type === 'tool')
      console.log(
        `[${number}] tool ${JSON.stringify(event.title)}: ${event.status}`,
      );
    else if (event.type === 'diff')
      console.log(`[${number}] diff ${JSON.stringify(event.path)}`);
    else if (event.type === 'diagnostic')
      console.log(`[${number}] ${JSON.stringify(event.message)}`);
  });
  attention.subscribe((item) => {
    if (!itemNumbers.has(item.id))
      itemNumbers.set(item.id, itemNumbers.size + 1);
    console.log(
      `[Run ${runNumber(item.runId)} / Item ${itemNumbers.get(item.id)}] ${item.status}: ${JSON.stringify(item.title)}`,
    );
    if (item.status === 'pending' && item.kind === 'permission')
      item.choices.forEach((choice, index) =>
        console.log(
          `  ${index + 1}. ${JSON.stringify(choice.label)} (${choice.kind})`,
        ),
      );
    else if (item.status === 'pending')
      item.steps.forEach((step, index) =>
        console.log(`  step ${index + 1}. ${JSON.stringify(step)}`),
      );
  });
  const selected = () => {
    if (!current) throw new Error('Start a Run first');
    return current;
  };
  const byNumber = (text: string | undefined) => {
    const number = Number(text);
    const id = [...runNumbers].find(([, value]) => value === number)?.[0];
    if (!id) throw new Error('Unknown Run number');
    return id;
  };
  const tasks = (task: Promise<unknown>) => {
    const wrapped = task
      .then(() => {})
      .catch((error) => {
        if (!quitting) console.error(message(error));
      });
    background.add(wrapped);
    void wrapped.finally(() => background.delete(wrapped));
  };
  const start = async (input: Launch) => {
    const run = await runtime.start(input);
    current = run.id;
    console.log(
      `Selected Run ${runNumber(run.id)}; environment ${JSON.stringify(run.environment)}`,
    );
  };
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  const lines = rl[Symbol.asyncIterator]();
  const shutdown = () => {
    quitting = true;
    rl.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log('agent / workbench · M0');
  console.log(help);
  try {
    if (initial) await start(initial);
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const split = trimmed.indexOf(' ');
      const command = split === -1 ? trimmed : trimmed.slice(0, split);
      const rest = split === -1 ? '' : trimmed.slice(split + 1).trim();
      try {
        if (command === 'quit') break;
        if (command === 'help') {
          console.log(help);
          continue;
        }
        if (command === 'start') {
          tasks(
            rest === 'fixture'
              ? start({ provider: 'fixture' })
              : config(rest).then(start),
          );
          continue;
        }
        if (command === 'runs') {
          runtime
            .list()
            .forEach((run) =>
              console.log(
                `${runNumber(run.id)} ${run.provider} ${JSON.stringify(run.label)} ${JSON.stringify(run.state)}`,
              ),
            );
          continue;
        }
        if (command === 'use') {
          current = byNumber(rest);
          console.log('Selected Run ' + runNumber(current));
          continue;
        }
        if (command === 'prompt') {
          tasks(runtime.prompt(selected(), rest));
          continue;
        }
        if (command === 'auth') {
          tasks(runtime.authenticate(selected(), rest));
          continue;
        }
        if (command === 'cancel') {
          tasks(runtime.cancel(rest ? byNumber(rest) : selected()));
          continue;
        }
        if (command === 'commit') {
          tasks(runtime.commitWorkspace(selected(), rest));
          continue;
        }
        if (command === 'inbox') {
          attention
            .list()
            .filter((item) => item.status === 'pending')
            .forEach((item) =>
              console.log(
                JSON.stringify({
                  number: itemNumbers.get(item.id),
                  run: runNumber(item.runId),
                  ...item,
                }),
              ),
            );
          continue;
        }
        if (command === 'answer') {
          const [number, choice] = rest.split(/\s+/).map(Number);
          const item = attention
            .list()
            .find((item) => itemNumbers.get(item.id) === number);
          if (!item || !choice || !Number.isInteger(choice))
            throw new Error('Unknown item or choice');
          if (item.kind !== 'permission')
            throw new Error(
              'Agent requests are marked done in the TUI or browser',
            );
          const option = item.choices[choice - 1];
          if (!option) throw new Error('Unknown choice');
          console.log(attention.answer(item.id, option.id));
          continue;
        }
        if (command === 'save') {
          tasks(
            save(
              runtime.events(),
              rest || `.workbench/replays/session-${Date.now()}.jsonl`,
            ),
          );
          continue;
        }
        console.log('Unknown command. Type help.');
      } catch (error) {
        console.error(message(error));
      }
    }
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    quitting = true;
    rl.close();
    await runtime.close();
    await Promise.allSettled(background);
  }
}
async function main(): Promise<void> {
  const [mode, arg] = process.argv.slice(2);
  if (mode === 'demo') {
    await demo();
    return;
  }
  if (mode === 'doctor') {
    await doctor();
    return;
  }
  if (mode === 'replay') {
    if (!arg) throw new Error('Provide replay path');
    await replay(arg);
    return;
  }
  if (mode === 'launch') {
    if (!arg) throw new Error('Provide launch config path');
    await shell(await config(arg));
    return;
  }
  if (mode === 'fixture') {
    await shell({ provider: 'fixture' });
    return;
  }
  if (mode === undefined || mode === 'shell') {
    await shell();
    return;
  }
  throw new Error(
    'Use shell, fixture, launch <config>, demo, doctor or replay <file>',
  );
}
main().catch((error) => {
  console.error(message(error));
  process.exitCode = 1;
});

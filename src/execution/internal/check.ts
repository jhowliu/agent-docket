import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { stopGroup } from './local.js';

const lineLimit = 200;
const byteLimit = 16 * 1024;

export type CheckRun = Readonly<{
  outcome: 'exited' | 'timed-out' | 'cancelled' | 'failed-to-start';
  exitCode: number | null;
  output: string;
  truncated: boolean;
}>;

/**
 * Runs one shell command in its own process group and stops the whole group
 * afterwards, so servers or watchers a check leaves behind do not survive it.
 */
export async function runCheck(
  cwd: string,
  command: string,
  options: Readonly<{ timeoutMs: number; signal: AbortSignal }>,
): Promise<CheckRun> {
  const env = { ...process.env };
  // The operator's tools and caches apply; repository overrides never do.
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_')) delete env[key];
  env['GIT_TERMINAL_PROMPT'] = '0';
  let output = '';
  let truncated = false;
  const append = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.length > byteLimit) {
      output = output.slice(-byteLimit);
      truncated = true;
    }
  };
  const child = spawn('/bin/sh', ['-c', command], {
    cwd,
    env,
    detached: true,
    stdio: 'pipe',
  });
  child.stdin.end();
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const started = await new Promise<boolean>((done) => {
    child.once('spawn', () => done(true));
    child.once('error', () => done(false));
  });
  if (!started)
    return { outcome: 'failed-to-start', exitCode: null, output, truncated };
  child.on('error', () => {});
  let ended: CheckRun['outcome'] = 'exited';
  const exited = new Promise<number | null>((done) =>
    child.once('exit', (code) => done(code)),
  );
  const stop = (outcome: CheckRun['outcome']) => {
    if (ended === 'exited') ended = outcome;
    void stopGroup(child).catch(() => {});
  };
  const timer = setTimeout(() => stop('timed-out'), options.timeoutMs);
  const abort = () => stop('cancelled');
  if (options.signal.aborted) abort();
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    const exitCode = await exited;
    // The shell has exited; anything it started in the group goes now.
    await stopGroup(child);
    const lines = output.split('\n');
    if (lines.length > lineLimit) truncated = true;
    return {
      outcome: ended,
      exitCode: ended === 'exited' ? exitCode : null,
      output: lines.slice(-lineLimit).join('\n'),
      truncated,
    };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
  }
}

const manifestSchema = z.object({
  scripts: z.object({ test: z.string().optional() }).optional(),
});
/**
 * A starting check for a Node project: install from its lockfile, then its
 * test script. Null when there is no real test script. Reads only package.json
 * (at most 256 KiB) and lockfile names.
 */
export async function suggestCheck(directory: string): Promise<string | null> {
  const file = join(directory, 'package.json');
  let manifest: unknown;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 256 * 1024) return null;
    manifest = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const test = manifestSchema.safeParse(manifest).data?.scripts?.test;
  if (!test?.trim() || /no test specified/i.test(test)) return null;
  const has = (name: string) =>
    lstat(join(directory, name)).then(
      (info) => info.isFile(),
      () => false,
    );
  if (await has('pnpm-lock.yaml'))
    return 'pnpm install --frozen-lockfile && pnpm test';
  if (await has('yarn.lock'))
    return 'yarn install --frozen-lockfile && yarn test';
  if (await has('package-lock.json')) return 'npm ci && npm test';
  return 'npm install && npm test';
}

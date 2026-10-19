import { spawn, execFile } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { LocalWorker, RunId, Source } from '../index.js';
import type { ManagedProcess } from './worker.js';

const execFileAsync = promisify(execFile);
const excluded = new Set([
  '.git',
  '.workbench',
  'node_modules',
  '.venv',
  '__pycache__',
]);
const inherited = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
] as const;
const code = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined;
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (code(error) === 'ESRCH') return false;
    throw error;
  }
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (code(error) !== 'ESRCH') throw error;
  }
}
async function stopGroup(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  // A parent exit does not establish that its background descendants are gone.
  signalGroup(pid, 'SIGTERM');
  const grace = Date.now() + 500;
  while (groupExists(pid) && Date.now() < grace) await delay(20);
  if (groupExists(pid)) signalGroup(pid, 'SIGKILL');
  const end = Date.now() + 2000;
  while (groupExists(pid) && Date.now() < end) await delay(20);
  if (groupExists(pid))
    throw new Error('Local process group cleanup could not be confirmed');
}

/** Explicit native mode. A directory copy and process group are not a security sandbox. */
export async function launchLocal(
  worker: LocalWorker,
  source: Source,
  id: RunId,
  fixture: string,
): Promise<ManagedProcess> {
  if (process.platform === 'win32')
    throw new Error('Local mode currently requires macOS or Linux');
  await mkdir(worker.workspaceRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(worker.workspaceRoot);
  const base = await mkdtemp(join(root, id + '-'));
  const cwd = join(base, 'repo');
  const temporary = await mkdtemp(join(tmpdir(), 'workbench-local-'));
  const home = join(temporary, 'home');
  const codexHome = join(home, '.codex');
  const scratch = join(temporary, 'tmp');
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(
      join(codexHome, 'config.toml'),
      'cli_auth_credentials_store = "file"\n',
      { mode: 0o600 },
    );
    await mkdir(scratch, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {};
    for (const key of inherited)
      if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, {
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      NO_BROWSER: '1',
      INITIAL_AGENT_MODE: 'workspace-write',
      CODEX_CONFIG: JSON.stringify({ cli_auth_credentials_store: 'file' }),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    });
    if (source.kind === 'git') {
      const gitOptions = { env, timeout: 60_000, maxBuffer: 1024 * 1024 };
      await execFileAsync(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          'clone',
          '--no-checkout',
          '--',
          source.url,
          cwd,
        ],
        gitOptions,
      );
      await execFileAsync(
        'git',
        [
          '-C',
          cwd,
          '-c',
          'core.hooksPath=/dev/null',
          'checkout',
          '--detach',
          source.revision,
        ],
        gitOptions,
      );
    } else {
      const path = await realpath(
        source.kind === 'fixture' ? fixture : source.path,
      );
      if (!(await lstat(path)).isDirectory())
        throw new Error('Local source must be a directory');
      const omitted: string[] = [];
      let files = 0,
        bytes = 0;
      await cp(path, cwd, {
        recursive: true,
        dereference: false,
        filter: async (entry) => {
          const name = basename(entry),
            info = await lstat(entry);
          if (
            entry !== path &&
            (entry === root ||
              excluded.has(name) ||
              name === '.env' ||
              name.startsWith('.env.') ||
              info.isSymbolicLink() ||
              (!info.isFile() && !info.isDirectory()))
          ) {
            if (omitted.length < 1000) omitted.push(relative(path, entry));
            return false;
          }
          if (info.isFile()) {
            files++;
            bytes += info.size;
            if (files > 20_000 || bytes > 256 * 1024 * 1024)
              throw new Error(
                'Local source copy exceeds 20,000 files or 256 MiB',
              );
          }
          return true;
        },
      });
      await writeFile(
        join(base, 'copy.json'),
        JSON.stringify({ source: path, omitted, files, bytes }, null, 2),
        { mode: 0o600 },
      );
    }
    if (worker.authFile) {
      const auth = await lstat(worker.authFile);
      if (!auth.isFile() || auth.size > 1024 * 1024)
        throw new Error(
          'authFile must be a regular auth.json file smaller than 1 MiB',
        );
      await copyFile(worker.authFile, join(codexHome, 'auth.json'));
      await chmod(join(codexHome, 'auth.json'), 0o600);
    }
    const adapter = worker.adapter ?? {
      file: process.execPath,
      args: [
        fileURLToPath(import.meta.resolve('@agentclientprotocol/codex-acp')),
      ],
    };
    child = spawn(adapter.file, [...adapter.args], {
      cwd,
      env,
      detached: true,
      stdio: 'pipe',
    });
    const managedChild = child;
    await new Promise<void>((done, reject) => {
      managedChild.once('spawn', done);
      managedChild.once('error', reject);
    });
    let cleanup: Promise<void> | undefined;
    return {
      child,
      cwd,
      environment: { kind: 'local', location: cwd },
      stop() {
        cleanup ??= (async () => {
          await stopGroup(managedChild);
          await rm(temporary, { recursive: true, force: true });
        })().catch((error: unknown) => {
          cleanup = undefined;
          throw error;
        });
        return cleanup;
      },
    };
  } catch (error) {
    if (child) await stopGroup(child);
    await rm(temporary, { recursive: true, force: true });
    // Preserve code and copy metadata on startup failure as well as cancellation.
    throw error;
  }
}

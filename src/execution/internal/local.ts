import { spawn, execFile } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
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
import { createLocalWorktree } from './worktree.js';
import type { ManagedWorktree } from './worktree.js';

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
] as const;
/** Host login settings an adapter may read; Claude gets only its token file. */
const providerInherited = {
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  claude: [],
} as const;
/** The adapters this package bundles, started with Node. */
const bundledAdapters = {
  codex: '@agentclientprotocol/codex-acp',
  claude: '@agentclientprotocol/claude-agent-acp/dist/index.js',
} as const;
const code = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined;
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The long-lived token `claude setup-token` printed, from the operator's file. */
async function claudeToken(worker: LocalWorker): Promise<string> {
  const file = worker.claudeTokenFile;
  if (!file)
    throw new Error(
      'Claude · local needs a token: run `claude setup-token` and configure claudeTokenFile',
    );
  const info = await lstat(file).catch((error: unknown) => {
    if (code(error) === 'ENOENT')
      throw new Error(
        `No Claude token at ${file}: run \`claude setup-token\` and save the token there (chmod 600)`,
      );
    throw error;
  });
  if (!info.isFile() || info.size > 4096)
    throw new Error(
      'claudeTokenFile must be a regular file smaller than 4 KiB',
    );
  const token = (await readFile(file, 'utf8')).trim();
  if (!/^[\x21-\x7e]{20,}$/.test(token))
    throw new Error(
      `${file} must hold only the token that \`claude setup-token\` printed`,
    );
  return token;
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (code(error) === 'ESRCH') return false;
    // EPERM is not proof that the group is gone. Keep polling within the stop
    // deadline; transient permission checks can fail while a group exits.
    if (code(error) === 'EPERM') return true;
    throw new Error(
      `Cannot inspect local process group ${pid}: ${error instanceof Error ? error.message : 'signal check failed'}`,
      { cause: error },
    );
  }
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (code(error) !== 'ESRCH')
      throw new Error(
        `Cannot send ${signal} to local process group ${pid}: ${error instanceof Error ? error.message : 'signal failed'}`,
        { cause: error },
      );
  }
}
export async function stopGroup(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
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

/** Explicit native mode. A worktree and process group are not a security sandbox. */
/** A reviewer's working directory, made by the reviewed Run's worktree. */
export type ReviewCheckout = (
  path: string,
) => Promise<{ release(): Promise<void> }>;

/**
 * With `review`, the Run reviews another Run's Candidate: its directory comes
 * from `review` instead of `source`, the adapter starts read-only, and stopping
 * it discards the checkout.
 */
export async function launchLocal(
  worker: LocalWorker,
  provider: 'codex' | 'claude',
  source: Source,
  id: RunId,
  fixture: string,
  review?: ReviewCheckout,
): Promise<ManagedProcess> {
  if (process.platform === 'win32')
    throw new Error('Local mode currently requires macOS or Linux');
  // Before any checkout, so a missing login leaves nothing behind.
  const token = provider === 'claude' ? await claudeToken(worker) : undefined;
  await mkdir(worker.workspaceRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(worker.workspaceRoot);
  const base = await mkdtemp(join(root, id + '-'));
  const cwd = join(base, 'repo');
  const temporary = await mkdtemp(join(tmpdir(), 'workbench-local-'));
  const home = join(temporary, 'home');
  const codexHome = join(home, '.codex');
  const claudeConfig = join(home, '.claude');
  const scratch = join(temporary, 'tmp');
  let child: ChildProcessWithoutNullStreams | undefined;
  let worktree: ManagedWorktree | undefined;
  let checkout: { release(): Promise<void> } | undefined;
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {};
    for (const key of [...inherited, ...providerInherited[provider]])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, {
      HOME: home,
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      NO_BROWSER: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      // Directory copies have no .git; never discover the workbench's parent repo.
      GIT_CEILING_DIRECTORIES: base,
      GIT_TERMINAL_PROMPT: '0',
    });
    if (provider === 'codex') {
      await mkdir(codexHome, { mode: 0o700 });
      await writeFile(
        join(codexHome, 'config.toml'),
        'cli_auth_credentials_store = "file"\n',
        { mode: 0o600 },
      );
      Object.assign(env, {
        CODEX_HOME: codexHome,
        // Codex asks before a reviewer edits anything.
        INITIAL_AGENT_MODE: review ? 'read-only' : 'workspace-write',
        CODEX_CONFIG: JSON.stringify({ cli_auth_credentials_store: 'file' }),
      });
    } else {
      // A private config: none of the person's hooks, plugins, MCP servers or
      // instructions, and the Run's own tools need no approval.
      await mkdir(claudeConfig, { mode: 0o700 });
      await writeFile(
        join(claudeConfig, 'settings.json'),
        JSON.stringify({
          permissions: {
            // A reviewer plans and reports; it never edits.
            defaultMode: review ? 'plan' : 'acceptEdits',
            allow: ['mcp__workbench_progress'],
            ...(review ? { deny: ['Edit', 'Write', 'NotebookEdit'] } : {}),
          },
        }),
        { mode: 0o600 },
      );
      Object.assign(env, {
        CLAUDE_CONFIG_DIR: claudeConfig,
        CLAUDE_CODE_OAUTH_TOKEN: token,
        DISABLE_AUTOUPDATER: '1',
      });
    }
    if (review) checkout = await review(cwd);
    else if (source.kind === 'git') {
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
    } else if (source.kind === 'directory') {
      worktree = await createLocalWorktree(source.path, cwd, id, source.base);
    } else {
      const path = await realpath(fixture);
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
              (entry === join(path, 'target') && info.isDirectory()) ||
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
    if (provider === 'codex' && worker.authFile) {
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
      args: [fileURLToPath(import.meta.resolve(bundledAdapters[provider]))],
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
      ...(worktree ? { worktree } : {}),
      stop() {
        cleanup ??= (async () => {
          await stopGroup(managedChild);
          await rm(temporary, { recursive: true, force: true });
          await checkout?.release();
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
    await worktree?.collect();
    await checkout?.release().catch(() => {});
    // Preserve code and copy metadata on startup failure as well as cancellation.
    throw error;
  }
}

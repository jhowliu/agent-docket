import { execFile } from 'node:child_process';
import { lstat, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { RunId, Source, WorktreeSnapshot } from '../index.js';

const exec = promisify(execFile);
const environment = () => {
  const env = { ...process.env };
  // The operator's Git identity/config is useful; inherited repository/index
  // overrides must never redirect a workspace operation to another checkout.
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_')) delete env[key];
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['LC_ALL'] = 'C';
  return env;
};
async function git(args: readonly string[]): Promise<string> {
  const { stdout } = await exec(
    'git',
    ['-c', 'core.hooksPath=/dev/null', ...args],
    { env: environment(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}
const line = (value: string) => value.replace(/\n$/, '');
const hasCode = (error: unknown, code: string) =>
  error !== null &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === code;
const exitCode = (error: unknown, code: number) =>
  error !== null &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === code;

const projectPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      isAbsolute(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  );
export const projectInitializationSchema = z
  .object({
    path: projectPath,
    state: z.enum(['not-git', 'no-commit']),
    directoryId: z
      .string()
      .max(100)
      .regex(/^\d+:\d+$/),
  })
  .strict();
export type ProjectInitialization = z.infer<typeof projectInitializationSchema>;

/** Expected source-selection state; callers may offer an explicit initialization action. */
export class ProjectInitializationRequired extends Error {
  readonly project: ProjectInitialization;
  constructor(project: ProjectInitialization) {
    super(
      project.state === 'not-git'
        ? 'This folder has no Git repository'
        : 'Commit the project once before starting a local worktree',
    );
    this.project = projectInitializationSchema.parse(project);
  }
}

async function directoryId(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Choose an existing project folder');
  return `${info.dev}:${info.ino}`;
}

async function hasGitMarker(path: string): Promise<boolean> {
  for (let current = path; ; current = dirname(current)) {
    try {
      await lstat(resolve(current, '.git'));
      return true;
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    if (dirname(current) === current) return false;
  }
}

const revision = z.string().regex(/^[a-f0-9]{40,64}$/);
export const localProjectSchema = z.object({
  path: z.string().min(1),
  /** Main checkout identity, shared by all linked worktrees. */
  identityPath: z.string().min(1),
  head: revision,
  currentBranch: z.string().nullable(),
  branches: z
    .array(z.object({ name: z.string().min(1).max(255), revision }))
    .max(256),
  truncated: z.boolean(),
});
export type LocalProject = z.infer<typeof localProjectSchema>;

/** Read-only Git discovery. Never switches a branch or starts a provider. */
export async function inspectLocalProject(
  source: string,
  start?: Extract<Source, { kind: 'directory' }>['base'],
): Promise<LocalProject> {
  if (!projectPath.safeParse(source).success)
    throw new Error('Choose an absolute Git project folder');
  let project: string;
  let top: string;
  try {
    project = await realpath(source);
    await directoryId(project);
  } catch {
    throw new Error('Choose an existing project folder');
  }
  try {
    top = await realpath(
      line(await git(['-C', project, 'rev-parse', '--show-toplevel'])),
    );
  } catch (error) {
    if (
      exitCode(error, 128) &&
      error !== null &&
      typeof error === 'object' &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      error.stderr.startsWith('fatal: not a git repository') &&
      !(await hasGitMarker(project))
    )
      throw new ProjectInitializationRequired({
        path: project,
        state: 'not-git',
        directoryId: await directoryId(project),
      });
    throw new Error(
      'Cannot read this Git repository; check Git installation, ownership and metadata',
    );
  }
  if (top !== project)
    throw new Error(
      'Choose the Git project root, not a subfolder, for a local worktree',
    );
  let head: string;
  try {
    head = (
      await git(['-C', project, 'rev-parse', '--verify', 'HEAD^{commit}'])
    ).trim();
  } catch {
    const marker = await lstat(resolve(project, '.git'));
    const symbolic = await git([
      '-C',
      project,
      'symbolic-ref',
      '--quiet',
      'HEAD',
    ]).catch(() => '');
    const refs = await git([
      '-C',
      project,
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
    ]);
    if (
      marker.isDirectory() &&
      !marker.isSymbolicLink() &&
      symbolic.trim() &&
      !refs.trim()
    )
      throw new ProjectInitializationRequired({
        path: project,
        state: 'no-commit',
        directoryId: await directoryId(project),
      });
    throw new Error('Commit the project once before starting a local worktree');
  }
  if (start) {
    let selected: string;
    try {
      if (start.branch)
        await git(['check-ref-format', `refs/heads/${start.branch}`]);
      selected = (
        await git([
          '-C',
          project,
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${start.branch ? `refs/heads/${start.branch}` : 'HEAD'}^{commit}`,
        ])
      ).trim();
    } catch {
      throw new Error(
        'Starting branch is unavailable; reload the project branches',
      );
    }
    if (selected !== start.revision)
      throw new Error(
        'Starting branch changed; reload the project branches before creating a Session',
      );
  }
  const common = await realpath(
    resolve(
      project,
      line(await git(['-C', project, 'rev-parse', '--git-common-dir'])),
    ),
  );
  const currentBranch =
    (
      await git([
        '-C',
        project,
        'symbolic-ref',
        '--quiet',
        '--short',
        'HEAD',
      ]).catch(() => '')
    ).trim() || null;
  const records = (
    await git([
      '-C',
      project,
      'for-each-ref',
      '--count=257',
      '--sort=refname',
      '--format=%(refname:strip=2)%00%(objectname)',
      'refs/heads/',
    ])
  )
    .trimEnd()
    .split('\n')
    .filter(Boolean);
  const branches = records.slice(0, 256).map((record) => {
    const [name, revision] = record.split('\0');
    return { name, revision };
  });
  if (
    currentBranch &&
    !branches.some((branch) => branch.name === currentBranch)
  )
    branches.splice(255, 1, { name: currentBranch, revision: head });
  return localProjectSchema.parse({
    path: project,
    identityPath: basename(common) === '.git' ? dirname(common) : common,
    head,
    currentBranch,
    branches,
    truncated: records.length > 256,
  });
}

/** Explicitly initializes only the inspected folder and snapshots non-ignored files.
 * Rechecks identity/state, serializes across daemons, never appends to existing history.
 * Failure preserves files/Git state for inspection and a fresh confirmation. */
export async function initializeLocalProject(
  input: ProjectInitialization,
): Promise<LocalProject> {
  const expected = projectInitializationSchema.parse(input);
  async function validatePath() {
    if (
      (await realpath(expected.path)) !== expected.path ||
      (await directoryId(expected.path)) !== expected.directoryId
    )
      throw new Error(
        'Project folder changed; reload it before initializing Git',
      );
  }
  await validatePath();
  const lockPath = resolve(expected.path, '.workbench-init.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (hasCode(error, 'EEXIST'))
      throw new Error(
        'Project initialization is already locked; wait for it to finish before retrying',
      );
    throw error;
  }
  const owned = await lock.stat({ bigint: true });
  try {
    await validatePath();
    try {
      return await inspectLocalProject(expected.path);
    } catch (error) {
      if (!(error instanceof ProjectInitializationRequired)) throw error;
      if (
        error.project.state !== expected.state ||
        error.project.directoryId !== expected.directoryId
      )
        throw new Error('Project changed; reload it before initializing Git');
    }
    if (expected.state === 'not-git')
      await git([
        'init',
        '--quiet',
        '--initial-branch=main',
        '--',
        expected.path,
      ]);
    await validatePath();
    await git([
      '-C',
      expected.path,
      'add',
      '--all',
      '--',
      '.',
      ':(top,exclude).workbench-init.lock',
    ]);
    const identity: string[] = [];
    for (const [key, fallback] of [
      ['user.name', 'Agent Workbench'],
      ['user.email', 'workbench@localhost'],
    ] as const) {
      const configured = await git([
        '-C',
        expected.path,
        'config',
        '--get',
        key,
      ]).catch((error: unknown) => {
        if (exitCode(error, 1)) return '';
        throw error;
      });
      if (!configured.trim()) identity.push('-c', `${key}=${fallback}`);
    }
    await validatePath();
    await git([
      '-C',
      expected.path,
      ...identity,
      'commit',
      '--allow-empty',
      '--message',
      'Initial project snapshot',
    ]);
    return await inspectLocalProject(expected.path);
  } finally {
    await lock.close();
    try {
      const current = await lstat(lockPath, { bigint: true });
      if (current.dev === owned.dev && current.ino === owned.ino)
        await unlink(lockPath);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  }
}

export interface ManagedWorktree {
  snapshot(): WorktreeSnapshot;
  /** Only called after the managed process group is confirmed stopped. */
  collect(): Promise<WorktreeSnapshot>;
  /** Explicitly commits all non-ignored changes to the owned local branch. */
  commit(message: string): Promise<WorktreeSnapshot>;
}

/** Git owns checkout/registration removal; this module never recursively deletes a repo. */
export async function createLocalWorktree(
  source: string,
  path: string,
  id: RunId,
  start?: Extract<Source, { kind: 'directory' }>['base'],
): Promise<ManagedWorktree> {
  const inspected = await inspectLocalProject(source, start);
  const project = inspected.path;
  const baseRevision = start?.revision ?? inspected.head;
  const common = await realpath(
    resolve(
      project,
      line(await git(['-C', project, 'rev-parse', '--git-common-dir'])),
    ),
  );
  const branch = `workbench/${id}`;
  const base = dirname(path);
  await git([
    '-C',
    project,
    'worktree',
    'add',
    '-b',
    branch,
    '--',
    path,
    baseRevision,
  ]);
  let current: WorktreeSnapshot = {
    path,
    branch,
    baseRevision,
    status: { kind: 'active' },
  };
  let pending = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = pending.then(task);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  const administrative = (...args: string[]) =>
    git(['--git-dir', common, ...args]);
  async function registered(): Promise<boolean> {
    const records = (
      await administrative('worktree', 'list', '--porcelain', '-z')
    ).split('\0\0');
    return records.some((record) => {
      const fields = record.split('\0');
      return (
        fields.includes(`worktree ${path}`) &&
        fields.includes(`branch refs/heads/${branch}`)
      );
    });
  }
  async function validate(): Promise<void> {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path ||
      (await realpath(base)) !== base
    )
      throw new Error(
        'Worktree path changed; preserve it for manual inspection',
      );
    const marker = await lstat(resolve(path, '.git'));
    if (!marker.isFile() || marker.isSymbolicLink())
      throw new Error(
        'Worktree Git metadata changed; preserve it for manual inspection',
      );
    const actualCommon = await realpath(
      resolve(
        path,
        line(await git(['-C', path, 'rev-parse', '--git-common-dir'])),
      ),
    );
    const actualRoot = await realpath(
      line(await git(['-C', path, 'rev-parse', '--show-toplevel'])),
    );
    const actualBranch = (
      await git(['-C', path, 'symbolic-ref', '--quiet', 'HEAD'])
    ).trim();
    if (
      actualCommon !== common ||
      actualRoot !== path ||
      actualBranch !== `refs/heads/${branch}` ||
      !(await registered())
    )
      throw new Error(
        'Worktree ownership or branch changed; preserve it for manual inspection',
      );
  }
  async function changes(): Promise<number> {
    const records = (
      await git([
        '-C',
        path,
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '-z',
      ])
    ).split('\0');
    let count = 0;
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record) continue;
      count++;
      // Renames/copies have a second NUL-delimited pathname.
      if (/^[RC]|^.[RC]/.test(record)) index++;
    }
    return count;
  }
  async function collect(): Promise<WorktreeSnapshot> {
    if (current.status.kind === 'removed') return structuredClone(current);
    try {
      try {
        await lstat(path);
      } catch (error) {
        if (!hasCode(error, 'ENOENT') || (await registered())) throw error;
        current = { ...current, status: { kind: 'removed' } };
        return structuredClone(current);
      }
      await validate();
      const count = await changes();
      if (count) {
        current = {
          ...current,
          status: { kind: 'commit-required', changes: count },
        };
      } else {
        // Never force: Git performs another cleanliness/lock/submodule check.
        // Keep the branch, including commits that have not yet been merged/pushed.
        await administrative('worktree', 'remove', '--', path);
        current = { ...current, status: { kind: 'removed' } };
        await rmdir(base).catch((error: unknown) => {
          if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY'))
            throw error;
        });
      }
    } catch (error) {
      current = {
        ...current,
        status: {
          kind: 'retained',
          reason:
            error instanceof Error
              ? error.message.slice(0, 2000)
              : 'Worktree cleanup failed',
        },
      };
    }
    return structuredClone(current);
  }
  return {
    snapshot: () => structuredClone(current),
    collect: () => serialize(collect),
    commit: (message) =>
      serialize(async () => {
        if (!message.trim() || message.length > 1000 || message.includes('\0'))
          throw new Error(
            'Enter a commit message between 1 and 1000 characters',
          );
        if (current.status.kind === 'removed') return structuredClone(current);
        await validate();
        if (await changes()) {
          await git(['-C', path, 'add', '--all', '--', '.']);
          await git(['-C', path, 'commit', '-m', message.trim()]);
        }
        return collect();
      }),
  };
}

import { execFile } from 'node:child_process';
import { open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { limits } from './contract.js';

const exec = promisify(execFile);
const environment = () => {
  const env = { ...process.env };
  // Inherited repository/index overrides must never redirect a read to another checkout.
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_')) delete env[key];
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['LC_ALL'] = 'C';
  return env;
};
async function git(
  directory: string,
  args: readonly string[],
  maxBuffer = 16 * 1024 * 1024,
): Promise<string> {
  const { stdout } = await exec(
    'git',
    [
      '-C',
      directory,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.quotePath=false',
      ...args,
    ],
    { env: environment(), timeout: 30_000, maxBuffer, encoding: 'utf8' },
  );
  return stdout;
}

export type DiffFile = {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  plus: number;
  minus: number;
  binary: boolean;
  diff: string | null;
  /** New-side line numbers that were added, and where removed lines used to sit. */
  lines: { plus: number[]; minus: number[] };
};

/** The directory must be the top of its own checkout; `base` must name a commit there. */
export async function resolveCheckout(
  directory: string,
  base: string,
): Promise<{ root: string; base: string }> {
  const root = await realpath(directory).catch(() => {
    throw new Error('Change map directory is unavailable');
  });
  const top = await git(root, ['rev-parse', '--show-toplevel']).catch(() => {
    throw new Error('Change map directory is not a Git checkout');
  });
  if ((await realpath(top.trim())) !== root)
    throw new Error('Change map directory must be the top of its checkout');
  const revision = await git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${base}^{commit}`,
  ]).catch(() => {
    throw new Error(
      'Change map base revision is not a commit in this checkout',
    );
  });
  return { root, base: revision.trim() };
}

function changedLines(diff: string): DiffFile['lines'] {
  const plus: number[] = [];
  const minus: number[] = [];
  let next = 0;
  for (const row of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) next = Number(hunk[1]);
    else if (row.startsWith('+') && !row.startsWith('+++')) plus.push(next++);
    else if (row.startsWith('-') && !row.startsWith('---'))
      minus.push(Math.max(1, next));
    else if (row.startsWith(' ')) next++;
  }
  return { plus, minus };
}

async function untracked(
  root: string,
  path: string,
): Promise<Omit<DiffFile, 'path' | 'status'>> {
  const handle = await open(join(root, path), 'r');
  try {
    const head = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (head.subarray(0, bytesRead).includes(0))
      return {
        plus: 0,
        minus: 0,
        binary: true,
        diff: null,
        lines: { plus: [], minus: [] },
      };
  } finally {
    await handle.close();
  }
  const content = await readFile(join(root, path), 'utf8');
  const rows = content.length ? content.replace(/\n$/, '').split('\n') : [];
  const diff = `@@ -0,0 +1,${rows.length} @@\n${rows.map((row) => `+${row}`).join('\n')}\n`;
  return {
    plus: rows.length,
    minus: 0,
    binary: false,
    diff,
    lines: { plus: rows.map((_, i) => i + 1), minus: [] },
  };
}

/**
 * Working tree (tracked edits plus untracked, non-ignored files) against `base`.
 * Never stages, writes or runs project code; diff drivers and text conversion are off.
 */
export async function readDiff(
  root: string,
  base: string,
): Promise<{ files: DiffFile[]; truncated: Set<'files' | 'diff'> }> {
  const truncated = new Set<'files' | 'diff'>();
  type Listed = Pick<DiffFile, 'path' | 'previousPath' | 'status'> & {
    untracked: boolean;
  };
  const listed: Listed[] = [];
  const fields = (
    await git(root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '-M',
      '--name-status',
      '-z',
      base,
      '--',
    ])
  ).split('\0');
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i++] ?? '';
    if (status.startsWith('R')) {
      const previousPath = fields[i++] ?? '';
      listed.push({
        path: fields[i++] ?? '',
        previousPath,
        status: 'renamed',
        untracked: false,
      });
    } else {
      const path = fields[i++] ?? '';
      const kind =
        status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified';
      listed.push({ path, status: kind, untracked: false });
    }
  }
  for (const path of (
    await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  ).split('\0'))
    if (path) listed.push({ path, status: 'added', untracked: true });
  listed.sort((a, b) => a.path.localeCompare(b.path));
  if (listed.length > limits.files) truncated.add('files');

  let budget: number = limits.totalDiffBytes;
  const files: DiffFile[] = [];
  const selected = listed.slice(0, limits.files);
  // Bounded concurrency: one `git diff` per file keeps path handling exact.
  for (let start = 0; start < selected.length; start += 8) {
    const batch = await Promise.all(
      selected
        .slice(start, start + 8)
        .map(async ({ untracked: isUntracked, ...file }): Promise<DiffFile> => {
          if (isUntracked)
            return { ...file, ...(await untracked(root, file.path)) };
          const paths = file.previousPath
            ? [file.previousPath, file.path]
            : [file.path];
          const diff = await git(root, [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '-M',
            base,
            '--',
            ...paths,
          ]);
          const binary = /^Binary files /m.test(diff);
          const hunks = diff.indexOf('\n@@');
          const body = hunks < 0 ? '' : diff.slice(hunks + 1);
          const lines = changedLines(body);
          return {
            ...file,
            plus: lines.plus.length,
            minus: lines.minus.length,
            binary,
            diff: binary ? null : body,
            lines,
          };
        }),
    );
    files.push(...batch);
  }
  for (const file of files) {
    const size = file.diff === null ? 0 : Buffer.byteLength(file.diff);
    if (file.diff !== null && (size > limits.fileDiffBytes || size > budget)) {
      file.diff = null;
      truncated.add('diff');
    } else budget -= size;
  }
  return { files, truncated };
}

/** A file as it was at `base`; undefined when it did not exist there. */
export async function readAtBase(
  root: string,
  base: string,
  path: string,
): Promise<string | undefined> {
  return git(root, ['show', `${base}:${path}`], 4 * 1024 * 1024).catch(
    () => undefined,
  );
}

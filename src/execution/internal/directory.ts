import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { runIdSchema } from './contract.js';

export const directoryPathSchema = z
  .string()
  .max(2048)
  .refine(
    (path) =>
      path === '' ||
      (!isAbsolute(path) &&
        !/[\\\u0000-\u001f\u007f]/u.test(path) &&
        path.split('/').length <= 32 &&
        path
          .split('/')
          .every(
            (part) =>
              !['', '.', '..', '.git', 'node_modules', '.workbench'].includes(
                part,
              ),
          )),
    'Use a relative directory inside this Run workspace',
  );
export const directoryListingSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ready'),
      runId: runIdSchema,
      path: directoryPathSchema,
      root: z.string(),
      entries: z
        .array(
          z
            .object({
              name: z.string().min(1).max(1024),
              path: z.string().min(1).max(4096),
              kind: z.enum(['directory', 'file', 'symlink', 'other']),
            })
            .strict(),
        )
        .max(200),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      runId: runIdSchema,
      path: directoryPathSchema,
      reason: z.string(),
    })
    .strict(),
]);

// Metadata only. Never follow a directory link or accept a caller's absolute root.
export async function readWorkspaceDirectory(
  cwd: string,
  runId: z.infer<typeof runIdSchema>,
  path: string,
) {
  const rootInfo = await lstat(cwd);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error('Run workspace is unavailable');
  const root = await realpath(cwd);
  let target = root;
  for (const part of path ? path.split('/') : []) {
    target = join(target, part);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('Choose a directory; symbolic links cannot be expanded');
    const resolved = await realpath(target);
    const inside = relative(root, resolved);
    if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside))
      throw new Error('Directory is outside this Run workspace');
    target = resolved;
  }
  const entries: Extract<
    z.infer<typeof directoryListingSchema>,
    { kind: 'ready' }
  >['entries'] = [];
  let truncated = false;
  const directory = await opendir(target);
  for await (const entry of directory) {
    // These are implementation/dependency folders, not project navigation targets.
    if (['.git', 'node_modules', '.workbench'].includes(entry.name)) continue;
    if (entries.length === 200) {
      truncated = true;
      break;
    }
    entries.push({
      name: entry.name,
      path: path ? path + '/' + entry.name : entry.name,
      kind: entry.isSymbolicLink()
        ? 'symlink'
        : entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : 'other',
    });
  }
  entries.sort(
    (a, b) =>
      Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
      a.name.localeCompare(b.name),
  );
  return directoryListingSchema.parse({
    kind: 'ready',
    runId,
    path,
    root,
    entries,
    truncated,
  });
}

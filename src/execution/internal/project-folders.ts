import { opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const plain = (value: string) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && plain(value));
export const projectFoldersSchema = z
  .object({
    input: pathSchema,
    directory: pathSchema,
    prefix: z
      .string()
      .max(255)
      .refine((value) => plain(value) && !value.includes('/')),
    entries: z
      .array(
        z
          .object({
            name: z
              .string()
              .min(1)
              .max(255)
              .refine(
                (value) =>
                  plain(value) &&
                  value !== '.' &&
                  value !== '..' &&
                  !value.includes('/'),
              ),
            path: pathSchema,
            kind: z.enum(['directory', 'directory-link']),
          })
          .strict(),
      )
      .max(200),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.directory !== resolve(value.directory) ||
      new Set(value.entries.map((entry) => entry.name)).size !==
        value.entries.length ||
      value.entries.some(
        (entry) =>
          entry.path !== join(value.directory, entry.name) ||
          !entry.name.toLowerCase().startsWith(value.prefix.toLowerCase()),
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Folder metadata does not match its directory and prefix',
      });
  });
export type ProjectFolders = z.infer<typeof projectFoldersSchema>;

/** Source selection only: one level of folder metadata, before a Run/Git root exists.
 * Reads at most 4096 directory entries and returns at most 200 matching folders.
 * Directory links are identified, never recursively scanned. No file contents are read.
 */
export async function listProjectFolders(
  input: string,
): Promise<ProjectFolders> {
  if (!pathSchema.safeParse(input).success)
    throw new Error('Choose an absolute folder path');
  const path = resolve(input);
  let parent = path,
    prefix = '';
  try {
    if (input.endsWith('/.')) {
      parent = path;
      prefix = '.';
    } else if (!(await stat(path)).isDirectory()) {
      parent = dirname(path);
      prefix = basename(path);
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw new Error(
        'Cannot browse this folder; check its path and permissions',
      );
    parent = dirname(path);
    prefix = basename(path);
  }
  try {
    const directory = await realpath(parent);
    const entries: ProjectFolders['entries'] = [];
    let scanned = 0,
      truncated = false;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (++scanned > 4096) {
        truncated = true;
        break;
      }
      if (
        !plain(entry.name) ||
        (entry.name.startsWith('.') && !prefix.startsWith('.')) ||
        !entry.name.toLowerCase().startsWith(prefix.toLowerCase())
      )
        continue;
      const candidate = join(directory, entry.name);
      if (candidate.length >= 4096) continue;
      const link = entry.isSymbolicLink();
      if (
        !entry.isDirectory() &&
        !(
          link &&
          (await stat(candidate).then(
            (info) => info.isDirectory(),
            () => false,
          ))
        )
      )
        continue;
      if (entries.length === 200) {
        truncated = true;
        break;
      }
      entries.push({
        name: entry.name,
        path: candidate,
        kind: link ? 'directory-link' : 'directory',
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return projectFoldersSchema.parse({
      input,
      directory,
      prefix,
      entries,
      truncated,
    });
  } catch {
    throw new Error(
      'Cannot browse this folder; check its path and permissions',
    );
  }
}

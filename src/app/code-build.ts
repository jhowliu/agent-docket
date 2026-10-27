import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Identifies the code a process runs: a hash of the app's source (or built)
 * files and the dependency lockfile, read when it is called. Processes started
 * from the same tree agree; a server started before the code changed does not.
 */
export async function codeBuild(
  root = fileURLToPath(new URL('../', import.meta.url)),
): Promise<string> {
  const hash = createHash('sha256');
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && /\.(?:[cm]?[jt]sx?|json)$/.test(entry.name),
    )
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
  for (const file of files)
    hash
      .update(file)
      .update('\0')
      .update(await readFile(join(root, file)))
      .update('\0');
  const lock = await readFile(join(root, '../package-lock.json')).catch(
    () => undefined,
  );
  if (lock) hash.update(lock);
  return hash.digest('hex').slice(0, 12);
}

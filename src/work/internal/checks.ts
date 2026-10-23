import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** Verify needs a check command first; `suggestion` comes from package.json. */
export class CheckRequired extends Error {
  constructor(readonly suggestion: string | null) {
    super('Set a check command for this project first: :check <command>');
  }
}

const projectId = z.string().regex(/^[a-f0-9]{64}$/);
export const checkCommand = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    'Use one line of plain text',
  );
const fileSchema = z
  .object({
    version: z.literal(1),
    checks: z.record(projectId, checkCommand),
  })
  .strict();

/**
 * Project check commands, loaded once at startup and written through.
 * Another daemon's later writes are seen only after a restart.
 */
export function createCheckStore(directory: string | undefined) {
  const file = directory ? join(directory, 'checks.json') : null;
  const checks = new Map<string, string>();
  if (file) {
    let body: string | null = null;
    try {
      body = readFileSync(file, 'utf8');
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    if (body !== null) {
      const parsed = fileSchema.safeParse(JSON.parse(body));
      if (!parsed.success)
        throw new Error(
          'checks.json is invalid; preserve it and repair the check commands',
        );
      for (const [id, command] of Object.entries(parsed.data.checks))
        checks.set(id, command);
    }
  }
  let queue = Promise.resolve();
  return {
    get: (id: string) => checks.get(id) ?? null,
    list: () =>
      [...checks].map(([id, command]) => ({ projectId: id, command })),
    set(id: string, input: string): Promise<void> {
      const command = checkCommand.parse(input);
      const result = queue.then(async () => {
        const next = new Map(checks).set(id, command);
        if (file && directory) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            await writeFile(
              temporary,
              JSON.stringify(
                { version: 1, checks: Object.fromEntries(next) },
                null,
                2,
              ) + '\n',
              { mode: 0o600, flag: 'wx' },
            );
            await rename(temporary, file);
          } finally {
            await rm(temporary, { force: true });
          }
        }
        checks.set(id, command);
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}

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
/** The agent that reviews a project's Candidates, when not the Run's own. */
export const reviewerProvider = z.enum(['codex', 'claude']);

/**
 * One value per project in `<directory>/<name>.json`, loaded once at startup
 * and written through. Another daemon's later writes are seen only after a
 * restart.
 */
function createProjectStore<T>(
  directory: string | undefined,
  name: 'checks' | 'reviewers',
  value: z.ZodType<T>,
) {
  const file = directory ? join(directory, `${name}.json`) : null;
  const fileSchema = z
    .object({ version: z.literal(1), [name]: z.record(projectId, value) })
    .strict();
  const values = new Map<string, T>();
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
          `${name}.json is invalid; preserve it and repair the ${name === 'checks' ? 'check commands' : 'reviewers'}`,
        );
      const saved = parsed.data[name] as Record<string, T>;
      for (const [id, entry] of Object.entries(saved)) values.set(id, entry);
    }
  }
  let queue = Promise.resolve();
  return {
    get: (id: string) => values.get(id) ?? null,
    list: () => [...values],
    /** `null` removes the project's value. */
    set(id: string, input: unknown): Promise<void> {
      const entry = input === null ? null : value.parse(input);
      const result = queue.then(async () => {
        const next = new Map(values);
        if (entry === null) next.delete(id);
        else next.set(id, entry);
        if (file && directory) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            await writeFile(
              temporary,
              JSON.stringify(
                { version: 1, [name]: Object.fromEntries(next) },
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
        if (entry === null) values.delete(id);
        else values.set(id, entry);
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}

/** Project check commands. */
export function createCheckStore(directory: string | undefined) {
  const store = createProjectStore(directory, 'checks', checkCommand);
  return {
    get: store.get,
    list: () =>
      store.list().map(([id, command]) => ({ projectId: id, command })),
    set: (id: string, command: string) => store.set(id, command),
  };
}

/** Which agent reviews each project's Candidates; absent means the Run's own. */
export function createReviewerStore(directory: string | undefined) {
  const store = createProjectStore(directory, 'reviewers', reviewerProvider);
  return {
    get: store.get,
    list: () =>
      store.list().map(([id, provider]) => ({ projectId: id, provider })),
    set: (id: string, provider: z.infer<typeof reviewerProvider> | null) =>
      store.set(id, provider),
  };
}

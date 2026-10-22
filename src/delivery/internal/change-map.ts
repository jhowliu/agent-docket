import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { analyze } from './analysis.js';
import { changeMapSchema } from './contract.js';
import type { ChangeMap } from './contract.js';
import { readAtBase, readDiff, resolveCheckout } from './diff.js';

const inputSchema = z
  .object({
    directory: z
      .string()
      .min(1)
      .max(4096)
      .refine(isAbsolute, 'Change map directory must be absolute'),
    base: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/, 'Change map base must be a commit hash'),
  })
  .strict();

export async function describeChange(input: {
  directory: string;
  base: string;
}): Promise<ChangeMap> {
  const { directory, base: requested } = inputSchema.parse(input);
  const { root, base } = await resolveCheckout(directory, requested);
  const diff = await readDiff(root, base);
  const analysis = await analyze(root, diff.files, (path) =>
    readAtBase(root, base, path),
  );
  const truncated = new Set<'files' | 'diff' | 'analysis'>(diff.truncated);
  if (analysis.truncated) truncated.add('analysis');
  return changeMapSchema.parse({
    base,
    generatedAt: new Date().toISOString(),
    totals: {
      files: diff.files.length,
      plus: diff.files.reduce((sum, file) => sum + file.plus, 0),
      minus: diff.files.reduce((sum, file) => sum + file.minus, 0),
    },
    truncated: [...truncated],
    analysis: analysis.analysis,
    files: diff.files.map((file) => ({
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status,
      plus: file.plus,
      minus: file.minus,
      binary: file.binary,
      diff: file.diff,
      symbols: analysis.symbols.get(file.path) ?? [],
    })),
    interfaces: analysis.interfaces,
    flows: analysis.flows,
    otherChanges: analysis.otherChanges,
  });
}

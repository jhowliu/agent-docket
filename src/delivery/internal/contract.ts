import { z } from 'zod';

/** Bounds keep one Change map small enough to send and render in full. */
export const limits = {
  files: 400,
  fileDiffBytes: 256 * 1024,
  totalDiffBytes: 4 * 1024 * 1024,
  programFiles: 4000,
  seeds: 300,
  referenceLookups: 3000,
  triggers: 4,
  flows: 64,
  otherChanges: 400,
} as const;

const text = (max: number) => z.string().max(max);
const line = z.number().int().min(1);
const count = z.number().int().min(0);

/** One function on a flow. `tags` are the key, command or kind that selects the call. */
const stepSchema = z
  .object({
    name: text(300),
    file: text(4096),
    line,
    changed: z.boolean(),
    tags: z.array(text(80)).max(16),
  })
  .strict();

const entrySchema = z
  .object({
    kind: z.enum([
      'key',
      'effect',
      'server',
      'ui-event',
      'component',
      'process-start',
      'no-static-caller',
    ]),
    label: text(300),
  })
  .strict();

const flowSchema = z
  .object({
    /** `http` reached over a local route; `unresolved` has a route but no static sender. */
    kind: z.enum(['http', 'unresolved', 'direct']),
    operation: text(400),
    triggers: z
      .array(
        z
          .object({ entry: entrySchema, chain: z.array(stepSchema).max(32) })
          .strict(),
      )
      .max(limits.triggers),
    moreTriggers: count,
    server: z.array(stepSchema).max(32),
    members: z
      .array(
        z
          .object({
            module: text(200),
            step: stepSchema,
            /** Changed functions below the Interface, in display order. */
            below: z
              .array(
                z
                  .object({
                    step: stepSchema,
                    depth: z.number().int().min(1).max(8),
                    /** Unchanged functions were skipped just above this one. */
                    gap: z.boolean(),
                    /** Changed functions under this one that are not listed. */
                    hidden: count,
                  })
                  .strict(),
              )
              .max(200),
          })
          .strict(),
      )
      .max(32),
    /** Short shared functions that changed; counted, not drawn. */
    helpers: z.array(text(300)).max(200),
  })
  .strict();

const symbolSchema = z
  .object({
    name: text(300),
    kind: z.enum([
      'function',
      'method',
      'callback',
      'class',
      'interface',
      'type',
      'const',
      'export',
    ]),
    line,
    endLine: line,
    plus: count,
    minus: count,
  })
  .strict();

export const changedFileSchema = z
  .object({
    path: text(4096),
    previousPath: text(4096).optional(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed']),
    plus: count,
    minus: count,
    binary: z.boolean(),
    /** Unified diff text; null when the file or the whole map exceeded its size bound. */
    diff: z.string().max(limits.fileDiffBytes).nullable(),
    symbols: z.array(symbolSchema).max(500),
  })
  .strict();

export const changeMapSchema = z
  .object({
    base: z.string().regex(/^[0-9a-f]{40}$/),
    generatedAt: z.iso.datetime(),
    totals: z.object({ files: count, plus: count, minus: count }).strict(),
    /** What was cut to stay within `limits`; an empty list means nothing was. */
    truncated: z.array(z.enum(['files', 'diff', 'analysis'])).max(3),
    analysis: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('typescript'),
          interfaceModules: z.array(text(200)).max(64),
        })
        .strict(),
      z.object({ kind: z.literal('files-only'), reason: text(400) }).strict(),
    ]),
    files: z.array(changedFileSchema).max(limits.files),
    interfaces: z
      .array(
        z
          .object({
            module: text(200),
            file: text(4096),
            added: z.array(text(300)).max(200),
            removed: z.array(text(300)).max(200),
            changed: z.array(text(300)).max(200),
          })
          .strict(),
      )
      .max(64),
    flows: z.array(flowSchema).max(limits.flows),
    /** Changed functions that no flow reaches; usually presentation code. */
    otherChanges: z
      .array(z.object({ file: text(4096), name: text(300), line }).strict())
      .max(limits.otherChanges),
  })
  .strict();

export type ChangeMap = z.infer<typeof changeMapSchema>;
export type ChangedFile = z.infer<typeof changedFileSchema>;
export type Flow = z.infer<typeof flowSchema>;
export type Step = z.infer<typeof stepSchema>;
export type FileSymbol = z.infer<typeof symbolSchema>;
export type Entry = z.infer<typeof entrySchema>;

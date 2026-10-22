import type { z } from 'zod';
import type { changeMapSchema } from './internal/contract.js';

/**
 * What changed in a checkout since `base`, arranged for reading: files and the
 * functions their hunks fall in, public Interface changes, and flows from a user
 * action down to the changed code. Flows are derived statically and may be
 * incomplete; nothing here is a verified review or check result.
 */
export type ChangeMap = z.infer<typeof changeMapSchema>;

/**
 * Read-only. `directory` must be the top of a Git checkout (a Run worktree) and
 * `base` a commit in it; the working tree, including untracked non-ignored files,
 * is compared with `base`. Never stages, writes, fetches or runs project code.
 * TypeScript checkouts with a root tsconfig.json also get functions, Interface
 * changes and flows; others get files and hunks only (`analysis.kind`).
 * Bounded by the published `limits`; `truncated` names what was cut.
 * Throws for an invalid input, a missing checkout or an unknown base.
 * Takes seconds on a large project; callers should not run it per keystroke.
 */
export { describeChange } from './internal/change-map.js';
export {
  changeMapSchema,
  limits as changeMapLimits,
} from './internal/contract.js';

import type {
  Candidate,
  CheckResult,
  Execution,
  RunId,
} from '../execution/index.js';

/** The Task spec a verification is bound to; null for a Direct Run. */
export type SpecRef = Readonly<{ taskId: string; revision: number }> | null;

export type Verification = Readonly<{
  runId: RunId;
  command: string;
  candidate: Candidate;
  spec: SpecRef;
  /** Null while the check runs. */
  result: CheckResult | null;
}>;

/**
 * `passed` only when the check exited 0 on exactly the Run's current code and
 * Task spec. `stale`: the code or spec changed since. `unconfirmed`: the check
 * did not finish, or the current code is unknown while a turn may change it.
 * Never a Task acceptance or review verdict.
 */
export type Assessment = Readonly<{
  status: 'running' | 'passed' | 'failed' | 'stale' | 'unconfirmed';
  reason: string;
}>;

export interface Evidence {
  /**
   * Freezes the Run's code as a Candidate and starts the check on it; resolves
   * once started. One per Run at a time. Only the latest verification of each
   * Run is kept, in memory for this process.
   */
  verify(
    input: Readonly<{ runId: RunId; command: string; spec: SpecRef }>,
  ): Promise<Verification>;
  /** The latest verification judged against the Run's current code and spec. */
  assess(
    runId: RunId,
    current: Readonly<{ tree: string | undefined; spec: SpecRef }>,
  ): Readonly<{ verification: Verification; assessment: Assessment }> | null;
}

export type EvidenceOptions = Readonly<{
  execution: Pick<Execution, 'createCandidate' | 'startCheck'>;
}>;

export { createEvidence } from './internal/evidence.js';

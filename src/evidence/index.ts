import type {
  Candidate,
  CheckResult,
  Execution,
  ReviewResult,
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

/** An Agent Review of one Candidate, bound like a verification. */
export type Review = Readonly<{
  runId: RunId;
  reviewer: RunId;
  candidate: Candidate;
  spec: SpecRef;
  /** Null while the reviewer works. */
  result: ReviewResult | null;
  /** Why the review ended without a verdict. */
  failure?: string | undefined;
}>;

/**
 * `approved` / `changes` only for exactly the Run's current code and Task
 * spec; `stale` once either changed; `unconfirmed` when the review ended
 * without a verdict or the current code is unknown. Advice for Human Review,
 * never acceptance.
 */
export type ReviewAssessment = Readonly<{
  status: 'reviewing' | 'approved' | 'changes' | 'stale' | 'unconfirmed';
  reason: string;
}>;

export interface Evidence {
  /**
   * Freezes the Run's code as a Candidate and starts the check on it; resolves
   * once started. `settled` resolves with the finished verification, or null
   * when the check could not report. One per Run at a time. Only the latest
   * verification of each Run is kept, in memory for this process.
   */
  verify(
    input: Readonly<{ runId: RunId; command: string; spec: SpecRef }>,
  ): Promise<
    Readonly<{
      verification: Verification;
      settled: Promise<Verification | null>;
    }>
  >;
  /** The latest verification judged against the Run's current code and spec. */
  assess(
    runId: RunId,
    current: Readonly<{ tree: string | undefined; spec: SpecRef }>,
  ): Readonly<{ verification: Verification; assessment: Assessment }> | null;
  /**
   * Starts an Agent Review of a Candidate (see `execution.startReview`),
   * throwing before anything runs when it cannot start. `settled` resolves
   * with the finished review, a verdict or a failure, never rejecting. Only
   * the latest review of each Run is kept, in memory for this process.
   */
  review(
    input: Readonly<{
      runId: RunId;
      candidate: Candidate;
      spec: SpecRef;
      prompt: string;
    }>,
  ): Readonly<{ review: Review; settled: Promise<Review> }>;
  /** The latest review judged against the Run's current code and spec. */
  assessReview(
    runId: RunId,
    current: Readonly<{ tree: string | undefined; spec: SpecRef }>,
  ): Readonly<{ review: Review; assessment: ReviewAssessment }> | null;
}

export type EvidenceOptions = Readonly<{
  execution: Pick<Execution, 'createCandidate' | 'startCheck' | 'startReview'>;
}>;

export { createEvidence } from './internal/evidence.js';

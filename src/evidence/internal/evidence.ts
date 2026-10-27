import type { RunId } from '../../execution/index.js';
import type {
  Assessment,
  Evidence,
  EvidenceOptions,
  Review,
  ReviewAssessment,
  SpecRef,
  Verification,
} from '../index.js';

const short = (sha: string) => sha.slice(0, 7);
const sameSpec = (a: SpecRef, b: SpecRef) =>
  a === null || b === null
    ? a === b
    : a.taskId === b.taskId && a.revision === b.revision;

function judge(
  verification: Verification,
  current: Readonly<{ tree: string | undefined; spec: SpecRef }>,
): Assessment {
  const { candidate, result, spec } = verification;
  if (!result)
    return { status: 'running', reason: `Checking ${short(candidate.sha)}` };
  if (!sameSpec(spec, current.spec))
    return {
      status: 'stale',
      reason:
        spec && current.spec && spec.taskId === current.spec.taskId
          ? 'Requirements changed after checking'
          : 'The Run tracks a different Task now',
    };
  if (current.tree === undefined)
    return {
      status: 'unconfirmed',
      reason: `Code may have changed since ${short(candidate.sha)}`,
    };
  if (current.tree !== candidate.tree)
    return {
      status: 'stale',
      reason: `Code changed after checking ${short(candidate.sha)}`,
    };
  switch (result.outcome) {
    case 'exited':
      return result.exitCode === 0
        ? { status: 'passed', reason: `Exit 0 on ${short(candidate.sha)}` }
        : {
            status: 'failed',
            reason:
              result.exitCode === null
                ? 'Ended by a signal'
                : `Exit ${result.exitCode}`,
          };
    case 'timed-out':
      return { status: 'failed', reason: 'Timed out after 10 minutes' };
    case 'cancelled':
      return { status: 'unconfirmed', reason: 'Checks were cancelled' };
    case 'failed-to-start':
      return {
        status: 'unconfirmed',
        reason:
          'Checks could not start: ' +
          (result.output.split('\n')[0] ?? '').slice(0, 200),
      };
  }
}

function judgeReview(
  review: Review,
  current: Readonly<{ tree: string | undefined; spec: SpecRef }>,
): ReviewAssessment {
  const { candidate, result, spec, failure } = review;
  if (failure) return { status: 'unconfirmed', reason: failure };
  if (!result)
    return {
      status: 'reviewing',
      reason: `Agent Review of ${short(candidate.sha)}`,
    };
  if (!sameSpec(spec, current.spec))
    return { status: 'stale', reason: 'Requirements changed after review' };
  if (current.tree === undefined)
    return {
      status: 'unconfirmed',
      reason: `Code may have changed since ${short(candidate.sha)}`,
    };
  if (current.tree !== candidate.tree)
    return {
      status: 'stale',
      reason: `Code changed after review of ${short(candidate.sha)}`,
    };
  return result.verdict === 'approve'
    ? { status: 'approved', reason: result.summary }
    : { status: 'changes', reason: result.summary };
}

/** Latest verification and review per Run, in memory only. */
export function createEvidence(options: EvidenceOptions): Evidence {
  const latest = new Map<RunId, Verification>();
  const reviews = new Map<RunId, Review>();
  const starting = new Set<RunId>();
  return {
    async verify({ runId, command, spec }) {
      if (starting.has(runId) || latest.get(runId)?.result === null)
        throw new Error('Checks are already running for this Run');
      starting.add(runId);
      try {
        const candidate = await options.execution.createCandidate(runId);
        const finished = options.execution.startCheck(
          runId,
          candidate,
          command,
        );
        const verification: Verification = {
          runId,
          command: command.trim(),
          candidate,
          spec,
          result: null,
        };
        latest.set(runId, verification);
        const settled = finished.then(
          (result) => {
            const done = { ...verification, result };
            if (latest.get(runId) === verification) latest.set(runId, done);
            return done;
          },
          () => {
            if (latest.get(runId) === verification) latest.delete(runId);
            return null;
          },
        );
        return { verification, settled };
      } finally {
        starting.delete(runId);
      }
    },
    assess(runId, current) {
      const verification = latest.get(runId);
      return verification
        ? { verification, assessment: judge(verification, current) }
        : null;
    },
    review({ runId, candidate, spec, prompt }) {
      const { reviewer, settled } = options.execution.startReview(
        runId,
        candidate,
        prompt,
      );
      const review: Review = {
        runId,
        reviewer: reviewer.id,
        candidate,
        spec,
        result: null,
      };
      reviews.set(runId, review);
      const keep = (done: Review) => {
        if (reviews.get(runId) === review) reviews.set(runId, done);
        return done;
      };
      return {
        review,
        settled: settled.then(
          (result) => keep({ ...review, result }),
          (error: unknown) =>
            keep({
              ...review,
              failure: (error instanceof Error
                ? error.message
                : 'Agent Review failed'
              ).slice(0, 400),
            }),
        ),
      };
    },
    assessReview(runId, current) {
      const review = reviews.get(runId);
      return review
        ? { review, assessment: judgeReview(review, current) }
        : null;
    },
  };
}

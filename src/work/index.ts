import type { z } from 'zod';
import type { Attention } from '../attention/index.js';
import type { Evidence } from '../evidence/index.js';
import type {
  Execution,
  Launch,
  RunId,
  RunSnapshot,
} from '../execution/index.js';
import type {
  nextActionSchema,
  planSchema,
  projectCheckSchema,
  projectOverviewSchema,
  runVerificationSchema,
  stageSchema,
  workCommandSchema,
  workSnapshotSchema,
  projectWorkSchema,
} from './internal/contract.js';

export type Stage = z.infer<typeof stageSchema>;
export type WorkPlan = z.infer<typeof planSchema>;
export type WorkCommand = z.infer<typeof workCommandSchema>;
export type WorkSnapshot = z.infer<typeof workSnapshotSchema>;
export type ProjectWork = z.infer<typeof projectWorkSchema>;
export type NextAction = z.infer<typeof nextActionSchema>;
export type ProjectOverview = z.infer<typeof projectOverviewSchema>;
export type RunVerification = z.infer<typeof runVerificationSchema>;
export type ProjectCheck = z.infer<typeof projectCheckSchema>;

export interface ProjectWorkspaces {
  /** Registers a stable project identity once; no Run or conversation is restored. */
  register(projectKey: string, source: string): string;
  /** A Run belongs to exactly one registered project for this process. */
  associate(projectId: string, runId: RunId): void;
  /**
   * Starts a Run and associates it before returning. With `projectId` the
   * launch runs as given in that registered project. Without it the launch
   * must be a local directory with a starting branch: the folder is inspected,
   * its canonical Git identity names the project, and a changed branch fails
   * before any Run exists. Fixture launches wait for startup; others return
   * at once and report readiness through execution events.
   */
  startSession(
    launch: Launch,
    projectId?: string,
  ): Promise<{ projectId: string; run: RunSnapshot }>;
  snapshot(): Promise<readonly ProjectWork[]>;
  /**
   * Where the person is needed, from current Run and attention state. A
   * project's `next` is its most urgent Run in `nextActionSchema` order, ties in
   * launch order. Runs asking something of the person (approve … worktree) come
   * first in that order; the rest keep launch order, so the list does not
   * reshuffle whenever a turn starts or ends. Projects follow their first Run;
   * projects without Runs come last. Planning guidance only: no action kind
   * passes a review or finishes a Task.
   */
  overview(): readonly ProjectOverview[];
  /** Each project's check command; persisted beside plans when configured. */
  checks(): readonly ProjectCheck[];
  /**
   * One line of 1–1000 characters, run by the operator's shell as the
   * operator: trusted input, never accepted from an agent.
   */
  setCheck(projectId: string, command: string): Promise<void>;
  /**
   * Checks the Run's current code with its project's command, bound to the
   * Task spec revision the Run tracks (none in Direct mode). Resolves once the
   * check has started. Without a command, rejects with CheckRequired.
   */
  verify(runId: RunId): Promise<void>;
  /**
   * Latest verification per Run against its current code and spec, using the
   * plans from the last snapshot(). Never passes a review or finishes a Task.
   */
  verifications(): readonly RunVerification[];
  apply(projectId: string, command: WorkCommand): Promise<void>;
  submit(runId: RunId, text: string): Promise<void>;
  close(): Promise<void>;
}

export interface Work {
  /** Project plan only; Run associations are process-local and are never restored. */
  snapshot(): Promise<WorkSnapshot>;
  /**
   * User-directed tracking, not verification. Stage selection never passes a review,
   * accepts a Candidate or finishes a Task. Every command uses the displayed plan
   * revision; stale writes fail instead of silently overwriting another client.
   */
  apply(command: WorkCommand): Promise<void>;
  /** Supplies the current Task spec as context without modifying the user's first prompt block. */
  submit(runId: RunId, text: string): Promise<void>;
  /** Waits for accepted writes. Does not cancel execution or finish project work. */
  close(): Promise<void>;
}

export type WorkOptions = Readonly<{
  /** Stable source identity, independent of provider, daemon port and credentials. */
  projectKey: string;
  /** Trusted operator path only. Omit for an ephemeral test workbench. */
  directory?: string;
  execution: Pick<Execution, 'snapshot' | 'submit'>;
}>;

export type ProjectWorkspacesOptions = Readonly<{
  /** Trusted operator path only. Omit for an ephemeral test workbench. */
  directory?: string;
  execution: Pick<
    Execution,
    'snapshot' | 'submit' | 'list' | 'start' | 'launch'
  >;
  attention: Pick<Attention, 'list'>;
  evidence: Evidence;
}>;

export {
  nextActionSchema,
  planSchema,
  projectCheckSchema,
  projectOverviewSchema,
  runVerificationSchema,
  stageSchema,
  workCommandSchema,
  workSnapshotSchema,
  projectWorkSchema,
} from './internal/contract.js';
export { createWork } from './internal/work.js';
export { createProjectWorkspaces } from './internal/projects.js';
export { CheckRequired } from './internal/checks.js';

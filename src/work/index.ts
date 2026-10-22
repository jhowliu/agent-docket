import type { z } from 'zod';
import type { Execution } from '../execution/index.js';
import type {
  planSchema,
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

export interface ProjectWorkspaces {
  /** Registers a stable project identity once; no Run or conversation is restored. */
  register(projectKey: string, source: string): string;
  /** A Run belongs to exactly one registered project for this process. */
  associate(
    projectId: string,
    runId: import('../execution/index.js').RunId,
  ): void;
  snapshot(): Promise<readonly ProjectWork[]>;
  apply(projectId: string, command: WorkCommand): Promise<void>;
  submit(
    runId: import('../execution/index.js').RunId,
    text: string,
  ): Promise<void>;
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
  submit(
    runId: import('../execution/index.js').RunId,
    text: string,
  ): Promise<void>;
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

export {
  planSchema,
  stageSchema,
  workCommandSchema,
  workSnapshotSchema,
  projectWorkSchema,
} from './internal/contract.js';
export { createWork } from './internal/work.js';
export { createProjectWorkspaces } from './internal/projects.js';

import type { Attention } from '../attention/index.js';
import type { z } from 'zod';
import type { directoryListingSchema } from './internal/directory.js';
export type DirectoryListing = z.infer<typeof directoryListingSchema>;
export type RunId = `run-${string}`;
export type Provider = 'fixture' | 'codex' | 'claude';
export type WorktreeSnapshot = Readonly<{
  path: string;
  branch: string;
  baseRevision: string;
  /**
   * Content identity of every non-ignored file, measured when a turn ends, a
   * Candidate is taken or the Run stops. Absent while a turn may be changing
   * files. Edits made outside a turn are only seen at the next measurement.
   */
  tree?: string | undefined;
  status:
    | Readonly<{ kind: 'active' | 'removed' }>
    | Readonly<{ kind: 'commit-required'; changes: number }>
    | Readonly<{ kind: 'retained'; reason: string }>;
}>;
export type LocalWorker = Readonly<{
  transport: 'local';
  /** Local mode is explicitly unsandboxed. Owns per-Run worktree directories. */
  workspaceRoot: string;
  /** Optional auth.json to copy into a private Codex home; never shared writable. */
  authFile?: string;
  /**
   * File holding the long-lived token `claude setup-token` prints. Read at
   * each Claude launch and handed to the agent alone; never copied or shown.
   * Claude Runs fail to start without it.
   */
  claudeTokenFile?: string;
  /**
   * Trusted operator configuration, never accepted from workbench commands.
   * Replaces the bundled adapter of whichever provider a Run uses.
   */
  adapter?: Readonly<{ file: string; args: readonly string[] }>;
}>;
export type Worker =
  | LocalWorker
  | Readonly<
      {
        image: string;
        /** Worker-side env file. Contents are never read by this client. */
        envFile?: string;
      } & ({ transport: 'docker' } | { transport: 'ssh'; host: string })
    >;
export type Source =
  | Readonly<{ kind: 'fixture' }>
  | Readonly<{
      kind: 'directory';
      path: string;
      /** Start from a displayed local branch/HEAD commit; fail if it changed. */
      base?:
        | Readonly<{ branch?: string | undefined; revision: string }>
        | undefined;
    }>
  | Readonly<{ kind: 'git'; url: string; revision: string }>;
export type Launch =
  | Readonly<{ provider: 'fixture'; label?: string }>
  | Readonly<{
      provider: 'codex' | 'claude';
      worker: Worker;
      source: Source;
      label?: string;
    }>;
export type RunState =
  | Readonly<{
      kind:
        | 'starting'
        | 'idle'
        | 'running'
        | 'cancelling'
        | 'cancelled'
        | 'closed';
    }>
  | Readonly<{
      kind: 'authentication-required';
      methods: readonly { id: string; label: string }[];
    }>
  | Readonly<{ kind: 'failed' | 'interrupted'; reason: string }>;
export type Capabilities = Readonly<{
  protocolVersion: number;
  agent: string;
  version: string;
  loadSessionAdvertised: boolean;
  clientFilesystem: false;
  clientTerminal: false;
  structuredQuestions: false;
  resumeImplemented: false;
}>;
export type RunSnapshot = Readonly<{
  id: RunId;
  provider: Provider;
  label: string;
  state: RunState;
  environment: {
    kind: 'trusted-fixture-directory' | 'local' | 'docker' | 'ssh';
    location: string;
  };
  capabilities: Capabilities | null;
  worktree?: WorktreeSnapshot | undefined;
  /** A reviewer Run: the Run and Candidate it reviews. */
  review?: Readonly<{ runId: RunId; candidate: string }> | undefined;
}>;
/** A Run's code frozen for checking; equal `tree`s mean equal code. */
export type Candidate = Readonly<{
  runId: RunId;
  /** Commit under refs/workbench/candidates/<run>; never on the Run branch. */
  sha: string;
  tree: string;
  /** The Run worktree's HEAD it was taken on. */
  parent: string;
  createdAt: string;
}>;
export type CheckResult = Readonly<{
  command: string;
  candidate: string;
  /** `exited` covers every exit code; only the code says whether checks passed. */
  outcome: 'exited' | 'timed-out' | 'cancelled' | 'failed-to-start';
  exitCode: number | null;
  /** Last lines of interleaved stdout/stderr, redacted; earlier output dropped. */
  output: string;
  truncated: boolean;
  startedAt: string;
  durationMs: number;
}>;
/** What a reviewer agent submitted; advice, never acceptance. */
export type ReviewResult = Readonly<{
  reviewer: RunId;
  candidate: string;
  verdict: 'approve' | 'changes';
  summary: string;
  findings: readonly Readonly<{
    path?: string | undefined;
    line?: number | undefined;
    text: string;
  }>[];
}>;
export type RunEventPayload =
  | { type: 'run.state'; state: RunState }
  | { type: 'capabilities'; capabilities: Capabilities }
  /** Input accepted locally; does not assert provider delivery or task success. */
  | { type: 'turn.start'; text: string }
  | { type: 'agent.message'; text: string }
  /**
   * Agent-authored progress, at most 50 whitespace-separated words; not a
   * verified verdict. `finished` is the agent saying the requested work is done.
   */
  | { type: 'agent.progress'; summary: string; finished?: true | undefined }
  | { type: 'tool'; id: string; title: string; status: string }
  | { type: 'diff'; path: string; oldText: string; newText: string }
  | { type: 'attention'; id: string; status: string }
  | { type: 'turn.end'; reason: string }
  | { type: 'check.start'; command: string; candidate: string }
  | ({ type: 'check.end' } & Omit<CheckResult, 'startedAt'>)
  | { type: 'diagnostic'; message: string };
export type RunEvent = Readonly<
  { sequence: number; runId: RunId; at: string } & RunEventPayload
>;
export interface Execution {
  /** Local execution requires explicit transport: 'local'; never a container fallback. */
  start(input: Launch): Promise<RunSnapshot>;
  /** Accepts startup immediately; events/snapshot report readiness or failure. */
  launch(input: Launch): RunSnapshot;
  authenticate(id: RunId, methodId: string): Promise<RunSnapshot>;
  /** One prompt per Run at a time. Busy prompts are rejected, not represented as steering. */
  prompt(id: RunId, text: string): Promise<{ stopReason: string }>;
  /** Accepts input into the current process. Turn outcomes arrive as events. */
  submit(id: RunId, text: string, context?: string): void;
  /**
   * Stops managed work (ended Runs too), commits changes left in its local Git
   * worktree to the Run's own branch (never pushed), collects the worktree and
   * removes the Run: `list()` drops it, its id becomes unknown and the last
   * snapshot is returned. A worktree Git would not remove (locked, branch
   * changed) stays on disk untouched. A failed commit or cleanup keeps the
   * Run. Journaled events stay until they age out.
   */
  cancel(id: RunId): Promise<RunSnapshot>;
  /** A stopped Run only: commit all non-ignored changes to its owned local branch,
   * then collect the clean worktree and remove the Run, returning its last
   * snapshot. Does not push or delete the branch. Failure preserves files and
   * the Run; a repeated call after removal throws without side effect.
   */
  commitWorkspace(id: RunId, message: string): Promise<RunSnapshot>;
  /**
   * Local Git worktree Runs only. Freezes every non-ignored file of the
   * worktree into a commit under refs/workbench/candidates/<run>; the
   * worktree, its index and its branch are untouched and nothing is pushed.
   * Unchanged code returns the previous Candidate. Removed worktrees throw.
   */
  createCandidate(id: RunId): Promise<Candidate>;
  /**
   * Validates and starts at once, throwing before anything runs: one check
   * per Run, the Candidate must be this Run's, 1–1000 characters. Runs
   * `/bin/sh -c command` in a fresh detached checkout of the Candidate with
   * the operator's environment (local: no OS isolation), then stops its
   * whole process group and removes the checkout. Ten-minute limit; stopping
   * the Run or closing execution cancels it. Emits check.start/check.end.
   */
  startCheck(
    id: RunId,
    candidate: Candidate,
    command: string,
  ): Promise<CheckResult>;
  /**
   * Local Git worktree Runs only, one review per Run at a time. Starts a
   * separate reviewer Run at once (same provider and worker, labelled
   * `Review · <label>`, listed like any Run, with `review` set) on a detached
   * checkout of the Candidate: no branch, the adapter read-only (Codex
   * `read-only`; Claude `plan` with edit tools denied), and
   * the Run-private submit_review tool instead of report_progress and
   * request_user. Sends `prompt` (1–100000 characters) once the reviewer is
   * ready. `settled` resolves with the latest review submitted when that turn
   * ends, and rejects when the reviewer cannot start, needs sign-in, ends
   * without a review, is interrupted or is cancelled (x on it, or the reviewed
   * Run stopping). Either way the reviewer Run is then removed and its
   * checkout discarded; nothing is committed.
   */
  startReview(
    id: RunId,
    candidate: Candidate,
    prompt: string,
  ): Readonly<{ reviewer: RunSnapshot; settled: Promise<ReviewResult> }>;
  snapshot(id: RunId): RunSnapshot;
  list(): readonly RunSnapshot[];
  /** Read-only, at most 200 entries per relative directory; fixture/local only.
   * Links are listed but never expanded. No file contents or prior Runs are read.
   * Invalid paths/unknown Runs throw; unavailable/ended environments return a reason.
   */
  listDirectory(id: RunId, path?: string): Promise<DirectoryListing>;
  /** Bounded cursor page. Throws when a cursor predates retained events. */
  events(after?: number): readonly RunEvent[];
  subscribe(listener: (event: RunEvent) => void): () => void;
  close(): Promise<void>;
}
export type ExecutionOptions = Readonly<{
  attention: Attention;
  maxEvents?: number;
  /**
   * A prompt turn is interrupted (`No agent activity for 10 minutes`) after
   * this long without agent activity: session updates, progress reports or
   * agent requests. A permission decision the person owes stops the clock.
   * There is no limit on an active turn. Default 10 minutes; 100 ms to 24 h.
   */
  idleTurnMs?: number;
}>;
export {
  runIdSchema,
  runSnapshotSchema,
  runEventSchema,
} from './internal/contract.js';
export { createExecution, parseLaunch } from './internal/runtime.js';
export {
  directoryPathSchema,
  directoryListingSchema,
} from './internal/directory.js';
export {
  inspectLocalProject,
  localProjectSchema,
  initializeLocalProject,
  projectInitializationSchema,
  ProjectInitializationRequired,
} from './internal/worktree.js';
export type {
  LocalProject,
  ProjectInitialization,
} from './internal/worktree.js';
export {
  listProjectFolders,
  projectFoldersSchema,
} from './internal/project-folders.js';
export type { ProjectFolders } from './internal/project-folders.js';
export { suggestCheck } from './internal/check.js';

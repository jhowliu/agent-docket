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
  /** Trusted operator configuration, never accepted from workbench commands. */
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
}>;
export type RunEventPayload =
  | { type: 'run.state'; state: RunState }
  | { type: 'capabilities'; capabilities: Capabilities }
  /** Input accepted locally; does not assert provider delivery or task success. */
  | { type: 'turn.start'; text: string }
  | { type: 'agent.message'; text: string }
  /** Agent-authored progress, at most 50 whitespace-separated words; not a verified verdict. */
  | { type: 'agent.progress'; summary: string }
  | { type: 'tool'; id: string; title: string; status: string }
  | { type: 'diff'; path: string; oldText: string; newText: string }
  | { type: 'attention'; id: string; status: string }
  | { type: 'turn.end'; reason: string }
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
  /** Stops managed work, then collects clean local Git worktrees. Dirty ones remain actionable. */
  cancel(id: RunId): Promise<void>;
  /** A stopped Run only: commit all non-ignored changes to its owned local branch,
   * then collect the clean worktree. Does not push or delete the branch.
   * Failure preserves files; duplicate calls after collection have no side effect.
   */
  commitWorkspace(id: RunId, message: string): Promise<RunSnapshot>;
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

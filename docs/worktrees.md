# Local Git worktrees

Local Codex Runs with a `directory` source now use a linked Git worktree. Choose an existing Git project root and local starting branch in [New Session](session-creation.md). A trusted launch file may also supply `source.path`; at least one commit is required. Each Run starts at the selected commit (source `HEAD` for legacy launches without an explicit base) on a unique `workbench/run-…` branch. The source checkout, its index and its uncommitted/untracked files are left in place; those pending changes are not copied into the new worktree.

For a folder without Git, New Session can explicitly initialize it and snapshot current non-ignored files in a first local commit before selecting a branch. An empty Git repository can create that initial commit while keeping its branch. This source-writing setup requires Yes; ordinary inspection and worktree creation retain the behavior above. See [initialization and recovery](session-creation.md#initialize-a-project).

The worktree lives at `workspaceRoot/run-…/repo`. Its branch and actual path appear in the TUI footer; Project browses that checkout. Git objects, refs and repository configuration are shared. Files, index and `HEAD` are separate. This provides separate development checkouts, not OS, process, network or security isolation. [Git worktree documentation](https://git-scm.com/docs/git-worktree)

## Close and save

1. Press `x` or use `:cancel`. Execution invalidates approvals and stops its managed process group before checking Git.
2. With no staged, unstaged or untracked changes, execution removes the registered worktree using Git without `--force`. The local branch remains, including any unmerged commits.
3. With changes, the stopped Run stays in the current roster as **Commit required**. Its files remain available. Press `c`, enter a commit message after `commit `, then Enter. Alternatively use `:commit <message>`.
4. The explicit commit action stages all non-ignored changes, including new files, and commits to that worktree's branch. After a successful commit and another cleanliness check, it removes the worktree. It does not merge, push or delete the branch.

You can also commit manually in the displayed path, then use `x` / `:cancel` again to recheck and remove it. In the browser, **Commit and close** opens the existing command field; supply the commit message and submit. The text CLI supports `commit <message>` after `cancel`.

After collection, the TUI/browser receipt shows the full saved branch name, even after the Run leaves the roster. Find the branch in the source project's Git repository; its commit remains available for later review or integration.

The operator's Git identity and signing configuration apply. A failed commit preserves the worktree and can be retried. Automated Git operations disable hooks. Locked worktrees, changed ownership/branches, invalid metadata or failed removal are retained with a reason. There is no force-discard action in this slice. Ignored dependency/build output is discarded with a clean worktree; use Git to save files that must survive removal.

`q` / Ctrl+C in the TUI only detaches and does not collect an active worktree. Stopping the daemon performs the same stop/collect check, preserving unsaved work. No extra worktree-count limit or count setting was added; existing Run limits are unchanged.

## Scope and recovery

Default fixture Runs still use disposable fixture directories. Local sample `fixture` sources and immutable HTTPS `git` sources retain their existing copy/clone behavior. This slice changes local Git `directory` sources. New Session selects the project and starting branch; it creates a fresh worktree rather than reusing another Run’s checkout.

Run conversations and decisions remain process-local; worktrees and Git branches do not restore an agent Session. After a daemon crash, inspect `git -C <project> worktree list`; use the listed checkout to save changes before `git worktree remove`. Automatic crash reconciliation and collection of old directory copies are not implemented. Existing user workspaces and services are never retroactively removed/upgraded.

## Module map and Interface

- `execution/index.ts`: optional `RunSnapshot.worktree` reports branch/path/base revision and active, commit-required, retained or removed status. `cancel` stops and attempts collection. `commitWorkspace(runId, message)` explicitly saves a stopped owned worktree and collects it; retries after successful removal have no further side effect.
- `execution/internal/worktree.ts`: Git creation, source-root validation, ownership/branch checks, change detection, serialized commit/collection and non-forced registration removal.
- `execution/internal/local.ts`: private home/login, adapter process and process-group shutdown; `runtime.ts` orders shutdown before collection and owns Run snapshots/diagnostics.
- App transports: authenticated `commit-workspace` command accepts only a Run ID and bounded message. No client-supplied checkout path, shell command or adapter configuration. TUI/browser render domain state and forward actions.

Public tests use real Git repositories and owned deterministic ACP subprocesses. They cover parallel checkouts, source edits left untouched, staged/binary/untracked changes, explicit and external commits, retries, signing failures, locks/branch changes, startup cancellation and the Ink close/commit flow. Real-model validation is recorded separately in [Codex acceptance](codex-live-acceptance.md).

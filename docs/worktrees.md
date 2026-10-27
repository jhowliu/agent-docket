# Local Git worktrees

Local Codex Runs with a `directory` source now use a linked Git worktree. Choose an existing Git project root and local starting branch in [New Session](session-creation.md). A trusted launch file may also supply `source.path`; at least one commit is required. Each Run starts at the selected commit (source `HEAD` for legacy launches without an explicit base) on a unique `workbench/run-…` branch. The source checkout, its index and its uncommitted/untracked files are left in place; those pending changes are not copied into the new worktree.

For a folder without Git, New Session can explicitly initialize it and snapshot current non-ignored files in a first local commit before selecting a branch. An empty Git repository can create that initial commit while keeping its branch. This source-writing setup requires Yes; ordinary inspection and worktree creation retain the behavior above. See [initialization and recovery](session-creation.md#initialize-a-project).

The worktree lives at `workspaceRoot/run-…/repo`. Its branch and actual path appear in the TUI footer; Project browses that checkout. Git objects, refs and repository configuration are shared. Files, index and `HEAD` are separate. This provides separate development checkouts, not OS, process, network or security isolation. [Git worktree documentation](https://git-scm.com/docs/git-worktree)

## Close and save

2026-10-26 the user asked for cancel to remove the Run directly, and chose to commit what it still holds rather than keep asking for `:commit`, and to drop Runs whose worktree Git will not remove while leaving the folder.

1. Press `x` or use `:cancel` (ended Runs too). Execution invalidates approvals and stops its managed process group before checking Git.
2. With staged, unstaged or untracked changes, execution stages all non-ignored files and commits them to the Run's own branch as `Save the work of a cancelled Run (Agent Workbench)`.
3. Execution removes the clean worktree using Git without `--force` and removes the Run from the list. The local branch remains, including any unmerged commits; press `n` and choose it as the starting branch to continue. The receipt names it: `Run removed · its work is on workbench/run-…`.
4. A worktree Git will not remove (locked, ownership or branch changed, invalid metadata) stays on disk untouched and the Run still leaves the list: `Run removed · its worktree stays on disk for you: <path>`. Clean it up with Git yourself (`git worktree remove`). Changes in a worktree on another branch are never committed.
5. If the commit fails (signing, identity), the Run stays as **Commit required** with `Automatic commit failed: …` in Live. Fix the cause and press `x` again, or `c` / `:commit <message>` to commit with your own message.

`c` / `:commit <message>` also works on a Run that ended on its own (failed, interrupted) with changes. It commits to that branch, removes the worktree and then the Run. It does not merge, push or delete the branch. In the browser, the cancel button reads **Remove Run** on ended Runs and **Commit and close** opens the command field. The text CLI supports `commit <message>`.

A Run that ended on its own stays listed, showing why, until `x` or a commit. Removed Runs are gone from the daemon: no Timeline, no `:inbox`, no Change map; their journaled events age out.

An Agent Review's reviewer Run (2026-10-26) is the exception: it works in a detached checkout of the Candidate with no branch, and stopping it force-removes that checkout without committing anything. See [Task flow](task-flow.md).

The operator's Git identity and signing configuration apply. A failed commit preserves the worktree and can be retried. Automated Git operations disable hooks. There is no force-discard action. Ignored dependency/build output is discarded with a clean worktree; use Git to save files that must survive removal.

`q` / Ctrl+C in the TUI only detaches and does not collect an active worktree. Stopping the daemon performs the same stop/collect check, preserving unsaved work. No extra worktree-count limit or count setting was added; existing Run limits are unchanged.

## Scope and recovery

Default fixture Runs still use disposable fixture directories. Local sample `fixture` sources and immutable HTTPS `git` sources retain their existing copy/clone behavior. This slice changes local Git `directory` sources. New Session selects the project and starting branch; it creates a fresh worktree rather than reusing another Run’s checkout.

Run conversations and decisions remain process-local; worktrees and Git branches do not restore an agent Session. After a daemon crash, inspect `git -C <project> worktree list`; use the listed checkout to save changes before `git worktree remove`. Automatic crash reconciliation and collection of old directory copies are not implemented. Existing user workspaces and services are never retroactively removed/upgraded.

## Module map and Interface

- `execution/index.ts`: optional `RunSnapshot.worktree` reports branch/path/base revision and active, commit-required, retained or removed status. `cancel` stops, commits what the worktree holds to the Run branch, collects it and removes the Run, returning its last snapshot; a worktree Git will not remove stays on disk, and a failed commit keeps the Run. `commitWorkspace(runId, message)` explicitly saves a stopped owned worktree, collects it and removes the Run; a repeated call after removal throws without side effect. `work` forgets removed Runs (project Run IDs, verifications, flows, Task bindings) on its next read.
- `execution/internal/worktree.ts`: Git creation, source-root validation, ownership/branch checks, change detection, serialized commit/collection and non-forced registration removal.
- `execution/internal/local.ts`: private home/login, adapter process and process-group shutdown; `runtime.ts` orders shutdown before collection and owns Run snapshots/diagnostics.
- App transports: authenticated `commit-workspace` command accepts only a Run ID and bounded message. No client-supplied checkout path, shell command or adapter configuration. TUI/browser render domain state and forward actions.

Public tests use real Git repositories and owned deterministic ACP subprocesses. They cover parallel checkouts, source edits left untouched, staged/binary/untracked changes committed on cancel, explicit and external commits, retries after failed automatic and manual commits, locks/branch changes leaving the folder, startup cancellation, the Ink `x` and failed-commit/`c` flows, and a tracked Run leaving its project while its Task keeps its stage. Real-model validation is recorded separately in [Codex acceptance](codex-live-acceptance.md).

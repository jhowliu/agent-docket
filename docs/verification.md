# Candidate and Verify

2026-10-23. A check result counts only for the exact code it ran on. Press `v` on a Run with a local Git worktree. The workbench freezes that Run's code as a **Candidate**, then runs the project's **check** command on a clean copy of it. The TUI shows whether that result still applies to the Run's current code and Task spec.

## Use

1. Set the project's check once with `:check <command>`, for example `:check npm ci && npm test`. A clean copy has no `node_modules`, so include the install step. `:check` alone shows the current command.
2. Select a Run and press `v` (or `:verify`). Without a check, `v` puts a suggestion on the command line instead, based on `package.json` and its lockfile, such as `check npm ci && npm test`. Enter saves it and nothing runs until the next `v`; Esc keeps it as a draft.
3. Timeline shows `Checks started · <command> · <sha>` and then `Checks passed` / `Checks failed · exit N` / `Checks timed out` / `Checks cancelled`. Live shows the command's last output lines.
4. The footer for the selected Run judges the latest result:
   - `Checks passed on abc1234`: exit 0 on exactly the Run's current code and spec.
   - `Checks failed on abc1234 (Exit 1)`
   - `Checks stale: Code changed after checking abc1234`: the agent edited files since the check ran.
   - `Checks stale: Requirements changed after checking`: the Run's Task spec has a new revision, or the Run tracks another Task now.
   - `Checks unconfirmed: …`: cancelled, could not start, or a turn is running and the code may be changing.

A pass is never Task acceptance, review or Human Review. Agents cannot set or run checks.

## Behavior and limits

- **Candidate.** `git add --all` into a copy of the worktree's index, then `write-tree` and `commit-tree`. The commit is stored under `refs/workbench/candidates/<run>`, parented on the Run's HEAD and authored as `Agent Workbench <workbench@localhost>`, unsigned. The worktree files, its index and its branch are untouched, and nothing is pushed. Ignored files are left out. Unchanged code returns the previous Candidate. One ref per Run stays in the repository: list them with `git for-each-ref refs/workbench`, remove one with `git update-ref -d <ref>`.
- **Check.** `/bin/sh -c <command>` runs in a fresh detached `git worktree` of the Candidate under the system temp directory. It uses the operator's environment without inherited `GIT_*` variables: local mode, no OS isolation. After the shell exits, its whole process group is stopped, so servers or watchers it started do not survive. The checkout is then force-removed. Limits:
  - ten minutes per check, then `timed out`;
  - one check per Run at a time;
  - stopping the Run or closing the daemon cancels the check;
  - output is the last 200 lines or 16 KiB, with known token patterns redacted.
- **Current code.** Execution measures each Run's content tree when a turn ends, when a Candidate is taken while idle, and when the Run stops. While a turn runs, the code is unknown. Edits made in the worktree outside a turn are seen only at the next measurement, so press `v` again after editing by hand.
- **Memory.** Only the latest verification per Run is kept, in daemon memory, like Runs and events. Check commands persist in `<planDirectory>/checks.json`, loaded at startup. Another daemon's later writes are seen after a restart.
- The browser lists check events only; whether a result still applies is TUI-only. Older daemons lack `features.verify`, so `v` explains that a new daemon is needed.

## Module map and Interface

- `execution` owns every Git and process step:
  - `createCandidate(runId)` and `startCheck(runId, candidate, command)`. `startCheck` validates and starts at once, throws before anything runs, and settles with a `CheckResult` when done.
  - `RunSnapshot.worktree.tree` and the `check.start` / `check.end` events.
  - `suggestCheck(directory)`.
  - Internals: `ManagedWorktree.measure/freeze/checkout` in `worktree.ts`, `runCheck` in `check.ts`.
- New `evidence` module (`src/evidence`):
  - `verify({ runId, command, spec })` freezes and starts, keeping the latest verification per Run.
  - `assess(runId, { tree, spec })` returns `running | passed | failed | stale | unconfirmed` with a reason. All applicability rules live here: Candidate tree against the current tree, and spec `{ taskId, revision }` equality.
- `work.ProjectWorkspaces` coordinates:
  - `checks()` and `setCheck(projectId, command)`, persisted.
  - `verify(runId)`: project check plus fresh plan read plus the Task spec revision the Run tracks. It throws `CheckRequired` with a `suggestion` when no check is set.
  - `verifications()`, judged with the plans from the last snapshot.
- App:
  - commands `verify` and `set-check`; `CheckRequired` becomes 409 `{ error, suggestion }`, carried as `WorkbenchError.suggestion`;
  - state `checks`, `verifications` and `features.verify`;
  - TUI `v`, which is a held-key-guarded action like `a`/`r`/`x`, plus `:verify` and `:check`;
  - Timeline and Live rows, and the footer hint.

## Validation and gaps

Typecheck passes. 133 of 134 tests passed in the full run; the one failure was the known intermittent Ink Git-initialization test, which passed 3 of 3 runs on its own. The four new tests in `test/verification.test.tsx` cover:

- Candidate contents: tracked and untracked files included, ignored files excluded, worktree, index and branch unchanged, same code giving the same Candidate;
- the check itself: run on a clean copy with its exit code, a background process stopped, the checkout removed, one check at a time, another Run's Candidate refused, Run cancellation cancelling the check;
- content identity unknown during a turn and changed after the fixture's edit;
- over HTTP: the suggestion with no check run, `checks.json`, passed → stale after an agent edit → passed again under a Task → stale after a spec revision, failed with its exit code, checks surviving a restart while verifications do not;
- the real Ink flow: suggestion, draft, `:check`, `v`, passed, then stale after an approved edit.

The first Ink run exposed two things. Two keys written in one terminal read are treated as paste, a test pacing issue. `v` lacked the held-key guard, now added.

Gaps:

- No tool-version record yet.
- No dependency cache between checks.
- No per-Task or multiple named checks.
- No agent-proposed checks and no independent Agent Review.
- Hand edits between turns are detected late.
- Since 2026-10-25 a tracked Task's finished report starts checks by itself and a pass moves it to Human Review; see [Task flow](task-flow.md).
- Not tested with a real Codex Run or a slow real install.

# Task flow: finished → Verify → Human Review

2026-10-25. The user asked how to trigger spec confirm, task breakdown, Candidate, Verify and Agent Review, and wanted the whole flow connected. Before this, every piece existed but was manual and none led to the next. The user chose three things:

- Agent Review starts by itself after checks pass.
- Failed checks or review findings go back to the agent at most twice, then stop for the person.
- Close the loop first, then add Agent Review, then task breakdown.

This document covers the first slice, the closed loop.

## The flow

```
:roadmap / :spec / :confirm        Task in Development (as before)
agent reports finished             Run-private report_progress(finished: true)
  └─ checks start on their own     Candidate + the project's check (Verify)
       ├─ passed → Human Review    next action `accept`, roster `review`
       │    ├─ :accept             Task accepted (needs passing checks on the current code)
       │    └─ :changes <notes>    back to Development, notes sent to the agent
       └─ failed → sent back       the check's result and output as the agent's next prompt
            ├─ (at most 2 times, then the flow stops: next action `checks`)
            └─ agent reports finished again → checks again
```

Triggers are declarations, as with turn outcomes: the agent's `finished` report, never its chat. Checks start only when all of these hold:

- the Run tracks a Task whose requirements are confirmed;
- the Task is in Development, or back from Human Review because the agent did more work;
- the turn ended without being cancelled;
- the Run has no open agent request;
- the Run has a local Git worktree.

A Direct Run that reports finished starts nothing.

## Rules

- **Pass.** When checks pass on exactly the Run's current code and Task spec revision (evidence's `passed`), the Task moves to Human Review. This applies to checks started with `v` too. A pass is never acceptance.
- **Failure.** A failing check the flow started goes back to the agent as a prompt. The prompt is `Workbench checks failed on Candidate abc1234 (automatic fix 1 of 2)` followed by the command, the result and the last 60 lines (at most 3000 characters) of output. After the second automatic fix, a third failure stops the flow (`Checks still fail after 2 fixes: Exit 3`). The flow also stops when no check is set (`Set a check first: :check <suggestion>`), when checks cannot start, or when they are cancelled. Failures of checks the person started with `v` are shown, never sent back.
- **The person takes over.** Any prompt the person sends clears the flow, so automatic fixes count from zero again. If the code changes while checks run, the result moves nothing.
- **Human Review.** `:accept` accepts the Task only with checks passing on the current code and requirements, and otherwise refuses with the reason. Accepting again does nothing. `:changes <what to fix>` works only during Human Review: it moves the Task back to Development and sends `Workbench Human Review requested changes:` plus the notes to the agent. Editing the spec or changing the stage reopens an accepted Task.
- **Accepted is not delivered.** Nothing is committed, pushed or merged. A stopped worktree still asks for `c` / `:commit`.
- **Memory.** Flows (`verifying`, `fixing`, `stopped` and the fix count) live in daemon memory, like verifications. A Task's stage and `accepted` status are saved in the plan file. A restarted daemon keeps them but runs nothing on its own.

## In the TUI

| Where              | Human Review                                                       | Stopped                                                       | Working                                                    |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Left column        | `◉ review` (yellow)                                                | `◉ checks` (yellow)                                           | `● verifying` / `● fixing` (blue)                          |
| Right title        | `Human Review · checks passed`                                     | `Checks · <reason>`                                           | `Verifying` / `Fixing failed checks (1 of 2)`              |
| Footer             | `Human Review · checks passed · :accept or :changes <what to fix>` | `Checks need you: <reason> · Enter tell the agent · v re-run` | `Codex is fixing failed checks (1 of 2) · x stop · 1 Live` |
| `spaces` next line | `review Run 2 · <Task>`                                            | `Run 2 checks need you`                                       |                                                            |

`w` reaches Runs in Human Review and Runs whose checks stopped, together with the other Runs waiting on the person. The Workflow panel highlights the stage from the plan. The automatic prompts show in Timeline as requests.

## Module map and Interface

- `work` (`projects.ts`) owns the flow. It subscribes to execution events (`turn.start`, `agent.progress` with `finished`, `turn.end`), runs one step at a time, and feeds both automatic and `v` checks into `checked()`.
  - `ProjectWorkspaces` gains `flows()`, `accept(runId)` and `requestChanges(runId, text)`.
  - Its options now need execution's `subscribe`.
  - Next actions gain `checks` and `accept`, after `sign-in`.
  - `createTrackedWork` gains `taskOf` and `transition`, the workbench's own stage and status writes. These go through the same lock and queue as user commands. They are not `WorkCommand`s, so no client can accept a Task without the evidence check.
  - The Task status `accepted` is new. A plan file holding it is invalid to older daemons and browsers.
- `evidence.verify` also returns `settled`, which resolves with the finished verification. Pass, fail and stale decisions stay in `assess`.
- App: commands `accept` and `request-changes` (notes of 1–4000 characters), state `flows`, `features.flow`. TUI: `:accept`, `:changes <notes>`, `flowViews` in `tui-view.tsx` for the roster, `spaces`, title and footer. Browser: plans with accepted Tasks validate; nothing else changes.
- Fixture: `--finish-feedback` answers prompts starting `Workbench ` as finished, so tests can drive the fix loop.

## Validation and gaps

`test/task-flow.test.tsx` covers:

- an ordinary turn starting nothing;
- `:accept` refused before checks;
- finished → checks → Human Review with the `accept` next action, and the TUI footer, `review · codex` and `review Run 1 · Boundary`;
- `:accept` in the TUI, accepting twice changing nothing, `:changes` reopening the Task with the notes reaching the agent, and `:changes` refused outside Human Review;
- a check failing three times: two automatic fixes with the output, stopped with `checks`, accept refused with the failure;
- the person's prompt clearing the flow;
- a Direct Run running no checks.

Full run: 144 tests, 143 passed. The known intermittent `project-initialization` test failed and passed 8/8 alone.

Next slices:

- **Agent Review.** A reviewer Run on a fresh worktree of the Candidate, given only the spec and the diff, reports through a Run-private `submit_review`. It sits between a pass and Human Review, and its findings go back to Dev under the same limit.
- **Task breakdown.** `propose_plan` from a requirements discussion, kept as a draft until the person adopts it.

Not done yet:

- no background notice for Human Review or a stopped flow;
- no next-Task suggestion after acceptance;
- one check per project;
- not tried with a real Codex Run.

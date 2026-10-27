# Task flow: finished → Verify → Agent Review → Human Review

2026-10-25. The user asked how to trigger spec confirm, task breakdown, Candidate, Verify and Agent Review, and wanted the whole flow connected. Before this, every piece existed but was manual and none led to the next. The user chose three things:

- Agent Review starts by itself after checks pass.
- Failed checks or review findings go back to the agent at most twice, then stop for the person.
- Close the loop first, then add Agent Review, then task breakdown.

This document covers the first slice, the closed loop, and the second, Agent Review (2026-10-26).

## The flow

```
:roadmap / :spec / :confirm        Task in Development (as before)
agent reports finished             Run-private report_progress(finished: true)
  └─ checks start on their own     Candidate + the project's check (Verify)
       ├─ passed → Agent Review    Task in Agent Review, a reviewer Run on that Candidate
       │    ├─ approve → Human Review   next action `accept`, roster `review`
       │    │    ├─ :accept        Task accepted (needs passing checks on the current code)
       │    │    └─ :changes <notes>    back to Development, notes sent to the agent
       │    └─ changes → sent back      findings as the agent's next prompt, Task back in Development
       └─ failed → sent back       the check's result and output as the agent's next prompt
            ├─ (at most 2 fixes in all, then the flow stops: next action `checks`)
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

- **Pass.** When checks pass on exactly the Run's current code and Task spec revision (evidence's `passed`), the Task moves to Agent Review and the review starts. This applies to checks started with `v` too, in Development or Agent Review. A pass is never acceptance.
- **Agent Review.** A separate reviewer Run (`Review · <label>`, listed under the project while it works) gets a detached checkout of the Candidate that passed: no branch, Codex in `read-only` mode (it asks before any edit), and only the Run-private `submit_review` tool. Its prompt is the Task title, the requirements and their revision, the Candidate and `git diff <base> HEAD`, and the check that passed. When its turn ends, the latest `submit_review` counts: `approve` moves the Task to Human Review; `changes` (at least one finding: path, line, text) moves it back to Development and sends `Workbench Agent Review requested changes on Candidate abc1234 (automatic fix 1 of 2)` with the summary and findings to the agent. Either way the reviewer Run is removed and its checkout discarded; nothing is committed. A review that ends without a verdict, fails to start, is interrupted or is cancelled (`x` on the reviewer) stops the flow with the reason. The verdict is bound to the Candidate and spec revision like a check, so changed code or requirements make it stale.
- **One limit.** Failed checks and review findings share the two automatic fixes. After them, a third failure or findings stop the flow (`Agent Review still requests changes after 2 fixes: <summary>`).
- **Failure.** A failing check the flow started goes back to the agent as a prompt. The prompt is `Workbench checks failed on Candidate abc1234 (automatic fix 1 of 2)` followed by the command, the result and the last 60 lines (at most 3000 characters) of output. After the second automatic fix, a third failure stops the flow (`Checks still fail after 2 fixes: Exit 3`). The flow also stops when no check is set (`Set a check first: :check <suggestion>`), when checks cannot start, or when they are cancelled. Failures of checks the person started with `v` are shown, never sent back.
- **The person takes over.** Any prompt the person sends clears the flow, so automatic fixes count from zero again, and stops a running review (its Run leaves). If the code changes while checks or a review run, the result moves nothing.
- **Human Review.** `:accept` accepts the Task only with checks passing on the current code and requirements, and otherwise refuses with the reason. The Agent Review is advice: accepting needs no approval, also works after the review stopped the flow, and stops a running review. Accepting again does nothing. `:changes <what to fix>` works only during Human Review: it moves the Task back to Development and sends `Workbench Human Review requested changes:` plus the notes to the agent. Editing the spec or changing the stage reopens an accepted Task.
- **Accepted is not delivered.** Nothing is committed, pushed or merged. A stopped worktree still asks for `c` / `:commit`.
- **Memory.** Flows (`verifying`, `reviewing`, `fixing`, `stopped` and the fix count) and reviews live in daemon memory, like verifications. A Task's stage and `accepted` status are saved in the plan file. A restarted daemon keeps them but runs nothing on its own; a Task left in Agent Review is reviewed again after `v` passes.

## In the TUI

| Where              | Human Review                                                                         | Stopped                                                                                     | Working                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Left column        | `◉ review` (yellow)                                                                  | `◉ checks` / `◉ agent review` (yellow)                                                      | `● verifying` / `● reviewing` / `● fixing` (blue)                                           |
| Right title        | `Human Review · checks passed · review approved`                                     | `Checks · <reason>` / `Agent Review · <reason>`                                             | `Verifying` / `Agent Review` / `Fixing failed checks (1 of 2)` / `Fixing review findings …` |
| Footer             | `Human Review · checks passed · review approved · :accept or :changes <what to fix>` | `Checks need you: <reason> …` / `Agent Review needs you: <reason> · Enter tell the agent …` | `Agent Review in Run 3 · a prompt here stops it · :accept skips it`                         |
| `spaces` next line | `review Run 2 · <Task>`                                                              | `Run 2 checks need you`                                                                     |                                                                                             |

The reviewer Run's own footer reads `Codex is reviewing Run 2 (Candidate abc1234) · x stops the review · 1 Live`; Live shows its reasoning. Run numbers are positions, so the reviewer's number goes away with it. `w` reaches Runs in Human Review and Runs whose flow stopped, together with the other Runs waiting on the person, and a reviewer that asks for approval. The Workflow panel highlights the stage from the plan (Development → Agent Review → Human Review). The automatic prompts show in Timeline as requests.

## Module map and Interface

- `work` (`projects.ts`) owns the flow. It subscribes to execution events (`turn.start`, `agent.progress` with `finished`, `turn.end`), runs one step at a time, and feeds both automatic and `v` checks into `checked()`, a pass into `review()` and the finished review into `reviewed()`.
  - `ProjectWorkspaces` gains `flows()`, `reviews()`, `accept(runId)` and `requestChanges(runId, text)`. Flows gain the step `reviewing` with its `reviewer`, and `cause` (`checks` / `review`) for fixing and stopped.
  - Its options now need execution's `subscribe` and `cancel` (stopping a review the person took over).
  - Next actions gain `checks` and `accept`, after `sign-in`.
  - `createTrackedWork` gains `taskOf` and `transition`, the workbench's own stage and status writes. These go through the same lock and queue as user commands. They are not `WorkCommand`s, so no client can accept a Task without the evidence check.
  - The Task status `accepted` is new. A plan file holding it is invalid to older daemons and browsers.
- `evidence.verify` also returns `settled`, which resolves with the finished verification. Pass, fail and stale decisions stay in `assess`. `evidence.review` starts a review and keeps the latest per Run; `assessReview` judges it `approved`, `changes`, `stale` or `unconfirmed` against the current code and spec.
- `execution.startReview(id, candidate, prompt)` starts the reviewer Run on `ManagedWorktree.detach` (a detached checkout at the reviewer's directory, force-removed on release) with `INITIAL_AGENT_MODE=read-only`, sends the prompt when it is ready and returns `{ reviewer, settled }`. The progress server in review mode (`WORKBENCH_PROGRESS_MODE=review`) offers only `submit_review` (verdict, summary up to 1000 characters, up to 20 findings; `changes` needs one). The reviewer snapshot carries `review: { runId, candidate }` and no `worktree`. Stopping the reviewed Run stops its reviewer. No new event type: older clients still parse the journal.
- App: commands `accept` and `request-changes` (notes of 1–4000 characters), state `flows`, `reviews`, `features.flow`, `features.review`. TUI: `:accept`, `:changes <notes>`, `flowViews` in `tui-view.tsx` for the roster, `spaces`, title and footer. Browser: plans with accepted Tasks validate; nothing else changes.
- Fixture: `--finish-feedback` answers prompts starting `Workbench ` as finished (review findings also leave `review-fix.txt`), so tests can drive the fix loop. A reviewer answers per `--review=approve|changes|changes-once|none|wait` and says its mode and tools.

## Validation and gaps

`test/task-flow.test.tsx` covers:

- an ordinary turn starting nothing;
- `:accept` refused before checks;
- finished → checks → Human Review with the `accept` next action, and the TUI footer, `review · codex` and `review Run 1 · Boundary`;
- `:accept` in the TUI, accepting twice changing nothing, `:changes` reopening the Task with the notes reaching the agent, and `:changes` refused outside Human Review;
- a check failing three times: two automatic fixes with the output, stopped with `checks`, accept refused with the failure;
- the person's prompt clearing the flow;
- a Direct Run running no checks;
- an approving review: the reviewer in `read-only` mode with only `submit_review`, its prompt, removal afterwards with no extra worktree or branch, `review approved` in the footer;
- findings sent back with path and line, the fix checked and reviewed again, then Human Review;
- findings past the limit stopping the flow (`agent review`, Task back in Development) while `:accept` still works on passing checks;
- the person's prompt stopping a running review, and `x` on the reviewer stopping the flow (`Agent Review was cancelled`).

Full run: 149 tests, 148 passed. The known intermittent `project-initialization` test failed; it passes alone.

Real Codex: `npm run qa:loop` ran the whole flow on a disposable sample project on 2026-10-27: the passing path (43 s), a failed check fixed by the agent (`--scenario fix-checks`, 52 s) and review findings fixed by the agent (`--scenario fix-review`, 77 s). The reviewer called `git diff` and `submit_review` in `read-only` mode without approval. See [Real Codex acceptance](codex-live-acceptance.md).

Next slice:

- **Task breakdown.** `propose_plan` from a requirements discussion, kept as a draft until the person adopts it.

Not done yet:

- no background notice for Human Review or a stopped flow;
- no next-Task suggestion after acceptance;
- one check per project; the reviewer uses the same agent preset as the Run;
- the reviewer is not given the diff text, only the command to see it;
- the reviewer cannot ask the person a question: with no verdict the flow stops and its Run (and what it asked) is removed;
- with real Codex the limit of two fixes was not reached; one fix each for checks and review was.

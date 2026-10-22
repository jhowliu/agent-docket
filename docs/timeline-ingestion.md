# Useful Timeline activity

2026-10-19. This slice adds context to the three-view TUI without generating summaries with another model. It does not implement the PM/Dev/Review/Verify/PR workflow.

## How oat-agents ingests information

Inspected revision: `c830f3e59726086fcb3d86dd6e0415687bd40d9b` of Noopher-AI/oat-agents.

Its workflow events come from explicit operations:

- Launch code writes `agent_enter` with the dispatch, role, worktree and backend. [Launch producer](https://github.com/Noopher-AI/oat-agents/blob/c830f3e59726086fcb3d86dd6e0415687bd40d9b/src/launch/mod.rs#L217-L224)
- Member `dispatch done` records an outcome and sends its report to the Run inbox; `dispatch ask` records a question. These are explicit member actions. [Dispatch producers](https://github.com/Noopher-AI/oat-agents/blob/c830f3e59726086fcb3d86dd6e0415687bd40d9b/src/commands/dispatch.rs#L122-L200)
- Agents can call `log record --event <kind> --message <text>`. The CLI validates an allowlist including decision, delegation, review-result, retry, blocker and note. The meta-agent's baseline instructions explicitly ask it to record decisions and requests for human judgment. [Validated log command](https://github.com/Noopher-AI/oat-agents/blob/c830f3e59726086fcb3d86dd6e0415687bd40d9b/src/commands/log.rs#L90-L129), [meta-agent reporting instructions](https://github.com/Noopher-AI/oat-agents/blob/c830f3e59726086fcb3d86dd6e0415687bd40d9b/assets/core/oat-meta-baseline.md#L39-L45)

`EventLog.record` appends timestamp, Run/Dispatch/agent identity, event kind and details to a per-Run JSONL file. `RunSnapshot.read` reads those entries and builds the TUI's rows. Timeline is a projection of this workflow record. Live uses tmux screen capture; Log reads a separate transcript. [JSONL storage](https://github.com/Noopher-AI/oat-agents/blob/c830f3e59726086fcb3d86dd6e0415687bd40d9b/src/event_log.rs#L13-L79), [snapshot ingestion](https://github.com/Noopher-AI/oat-agents/blob/c830f3e59726086fcb3d86dd6e0415687bd40d9b/src/tui/model.rs#L195-L224), [view definitions](https://github.com/Noopher-AI/oat-agents/blob/c830f3e59726086fcb3d86dd6e0415687bd40d9b/src/tui/tabbed.rs#L15-L24)

The useful semantic messages therefore depend on producers supplying them. The TUI does not infer a review decision from terminal prose.

## Current workbench ingestion

| Input                    | Owner and recorded observation                                                                                  | TUI presentation                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Accepted prompt          | `execution.prompt` emits `turn.start` after validation and entering Running; busy/rejected input emits no start | Request preview instead of a bare Running row                                                      |
| Agent progress tool      | `execution` accepts Run/turn-bound free-form summaries, at most 50 words                                        | Full wrapped Progress entries; no semantic classification                                          |
| ACP text deltas          | `execution` records bounded `agent.message` deltas                                                              | Full conversation in Live; no first-line proxy for progress                                        |
| ACP tool calls/patches   | `execution` merges title/status by tool ID; omitted patch fields preserve the preceding values                  | One activity row per tool in each turn, updated with its reported status and observed duration     |
| Approval transitions     | `attention` owns pending/accepted/delivered/stale; `execution` records the receipt                              | Request title and selected option when available, with acceptance and delivery kept distinct       |
| ACP diffs                | `execution` records the provider-reported change                                                                | One file notice per path per turn; full changes in Diff                                            |
| Agent request tool       | `execution` accepts Run/turn-bound `request_user` calls; `attention` keeps them until done or the Run ends      | `Needs you` / `Question for you`, `Marked done`, `Request expired` with the title                  |
| Turn ending              | Provider stop reason plus recorded start/tool/diff observations and whether the agent replied                   | Elapsed time, tool count, distinct changed-file count, `replied · 1 Live` and unusual stop reasons |
| Run failure/interruption | `execution` records the failure reason                                                                          | Failure with its reason; transport/environment diagnostics remain in Live and the header           |

`execution/index.ts` owns the new public `turn.start` event. Its text records locally accepted input, not provider delivery or task success, and passes through the existing redaction/8,000-character journal boundary. The private tool cache is bounded by the configured event limit and reset for each accepted prompt.

`app/tui-timeline.ts` is a pure reading projection. It groups observations without changing the raw journal, cursors, Run state or verification rules. Its tool fallback also reads older daemons that emitted `Tool update`/`unknown` for omitted fields. Tool IDs and changed-file counts are scoped to their own turn. Timing is omitted when retained history does not contain a usable start.

Progress wording comes directly from the working agent, not an additional model's interpretation or a classifier over ordinary conversation. See [Agent progress](agent-progress.md) for the tool contract and current transport limits. A completed tool status and a finished turn do not establish a verified check, passed stage or completed Task.

## Semantic colors

The TUI uses named terminal colors rather than hard-coding RGB values. Actual shades follow the user's terminal theme. It borrows Oat's colored labels, dim timestamps and ordinary details, with a user-requested change: green means successful completion/delivery; blue means activity. Oat itself uses green for agent entry and blue for exit. [Oat color mapping](https://github.com/Noopher-AI/oat-agents/blob/c830f3e59726086fcb3d86dd6e0415687bd40d9b/src/tui/text.rs#L248-L283), [Timeline rendering](https://github.com/Noopher-AI/oat-agents/blob/c830f3e59726086fcb3d86dd6e0415687bd40d9b/src/tui/tabbed.rs#L299-L313)

| Meaning                              | Workbench color | Current workbench mapping                                                            |
| ------------------------------------ | --------------- | ------------------------------------------------------------------------------------ |
| Successful reported operation        | Green           | Tool completed; approval reply delivered                                             |
| Activity                             | Blue            | Agent/turn/tool starting or running                                                  |
| Messages                             | Cyan            | Request and agent-authored Progress labels                                           |
| Needs human / review result          | Yellow          | Pending approval, accepted reply awaiting delivery, sign-in required                 |
| Blocker / skipped environment        | Red             | Failed tools, failed/interrupted Runs                                                |
| Decision / delegation / retry / note | Magenta         | Reserved until explicit reporting is implemented                                     |
| Run open/close                       | White           | Stopping/cancelled/ended Run; file-change label                                      |
| Ended or neutral observation         | Gray            | Turn finished, idle, expired approvals, neutral/pending activity; timestamps are dim |

Green tool completion is scoped to the provider-reported tool outcome; it does not establish a passed verification or completed Task. Turn endings stay neutral. Labels remain explicit when color is unavailable. Only event labels are colored and bold; tool commands and file paths are bold, while message text and reasons remain ordinary text.

Oat separately colors meta agents magenta, planners cyan, workers green and reviewers yellow. Our Run model has no role identity yet, so these role colors are not applied to provider names or invented roles. Adding the role protocol and semantic reporting remains future work.

## Upgrade and remaining scope

Reopening the TUI applies the activity projection to retained older events. Existing history has no stored prompt text to recover; Request entries begin when an upgraded daemon records new `turn.start` events. Progress requires a new Session on an upgraded daemon; old chat is not converted into reports. CLI replay and browser rendering also recognize the new events. This change does not restart an existing daemon or its Runs.

The live journal remains bounded in memory (2,000 events by default). Run snapshots, events and approval receipts are not saved to disk or restored after a daemon restart. TUI scrolling reads only the retained event window; there is no archive or history paging. Restart also does not reconcile external processes. See [Run lifecycle](run-lifecycle.md) for operation and validation limits.

The free-form progress ingress now lets an agent explain decisions, findings or blockers in its own words, without a required category. It does not implement workflow transitions or verification results. Future `work` would own workflow transitions and `evidence` check applicability; their contracts must not be inferred from progress prose. The role protocol and Candidate-bound review/verify results remain unimplemented.

## Validation

`test/execution.test.ts` covers accepted input ordering, busy rejection, input redaction and partial ACP tool updates. `test/timeline.test.tsx` replays the screenshot's lifecycle-only pattern and checks meaningful previews, single tool rows, approval titles, turn boundaries, reused tool IDs, file deduplication, failures and missing timing. Existing streaming and client tests exercise public polling/reconnection and terminal sizing. Rendered fixtures are not live model or physical-terminal acceptance.

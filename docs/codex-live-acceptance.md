# Real Codex acceptance

## 2026-10-28: Claude develops and reviews; Claude reviews Codex

`npm run qa:loop` with the user's `claude setup-token` token (file permissions 600, never printed):

- `-- --provider claude` first failed: Claude reviewed in `plan` mode, and its own `submit_review` still asked for approval even though the private settings allow `mcp__workbench_progress` (the script rejects reviewer approvals, so the review never landed and the flow stopped: `The reviewer ended without submitting a review`). The developing Run in `acceptEdits` reported without asking. Claude reviewers now start in `default` with Edit/Write/NotebookEdit denied.
- `-- --provider claude` then passed in 29 s: Claude read `token.mjs`, edited it (no approval in `acceptEdits`), asked once for `cat check.mjs; node check.mjs` (allowed), reported finished; the check passed; the Claude reviewer ran `git diff <base> HEAD` and `submit_review` with no approval and approved; accepted. No leftover worktree or Run directory.
- `-- --reviewer claude --scenario fix-review` passed in 1.3 min: Codex (2.2.2) changed only the comparison; the Claude reviewer (0.97.0) requested changes because a non-finite expiry was not expired; Codex added a `Number.isFinite` guard; a second Claude review approved. No approvals were needed. The reviewer said it read the diff without running `check.mjs` (a command that would ask).

Not tried: Claude reaching the two-fix limit, Claude in the TUI on a physical terminal, a Claude reviewer for a Claude Run with findings.

## 2026-10-27: the whole Task flow passed

`npm run qa:loop [-- --scenario passing|fix-checks|fix-review]` copies `fixtures/project` with a `check.mjs` for the expiry boundary into a disposable Git project under `.workbench/acceptance/task-flow/trial-*`, opens a Codex · local Session with the existing `~/.codex/auth.json` copy, sets the check `node check.mjs`, creates and confirms the Task, and prompts once. It answers permission requests (allow once for the Run, reject for a reviewer), accepts at Human Review, then cancels the Run so its work is committed to its branch. It fails when the Run ends, the flow stops, a turn ends without a finished report, or 30 minutes pass (`WORKBENCH_LOOP_MINUTES`). `summary.json` and `events.json` stay in the trial folder.

First trial, 43 seconds, no permission requests:

- Codex changed `expiry < now` to `expiry <= now`, ran `node check.mjs` itself and called `report_progress` with `finished: true`.
- Checks started on their own on Candidate `d159842` and passed (exit 0).
- The reviewer Run started in `read-only` mode on the detached checkout, ran `git diff <base> HEAD`, `node check.mjs` and `cat`, then called `submit_review` with approve and no findings. None of these asked for approval.
- The Task moved Development → Agent Review → Human Review, and `:accept` set it accepted. The reviewer Run left; the project kept only `main`, the Run's branch with the fix and its Candidate ref, with no extra worktree.

The fix scenarios add a requirement (a non-finite expiry is expired) to the spec, while the prompt asks only to change the comparison. Both passed the same day:

- **`fix-checks`, 52 seconds.** The check also runs a script kept outside the project. Codex changed only the comparison, as asked; checks failed (exit 1) and went back as `automatic fix 1 of 2`. Codex added `!Number.isFinite(expiry) ||`, checks passed on the new Candidate, the review approved, and the Task was accepted.
- **`fix-review`, 77 seconds.** Only the boundary is checked, so checks passed on the partial change. The reviewer requested changes with one finding (`token.mjs:2`: missing, NaN and Infinity expiries stay unexpired, against the requirements). The Task went back to Development and the findings to Codex as `automatic fix 1 of 2`; it fixed them, checks passed, a second reviewer approved, and the Task was accepted.

In all three trials no permission was asked, each project kept only `main` and the Run's branch, and no reviewer worktree was left. Not covered: the limit of two fixes with real Codex, a reviewer asking for an edit, and the TUI on a physical terminal.

## 2026-10-21: Git worktree save and collection passed

Latest trial `.workbench/acceptance/codex-workflow/trial-CtUbcY/` repeated the real bundled Codex workflow on an owned Git project initialized from the sample files. Native reading, edits/Diff, three passing Node tests plus independent boundary assertions, exact once-only allow/reject and active cancellation all passed. The observed cancellation PID was 18434 and stopped.

After cancellation, the actual Git changes kept the stopped Run visible as `Commit required`. Actual Ink `c` and a commit message invoked the public app/execution Interface, created a local commit on `workbench/run-23ac22e1-b280-4e9d-bd2e-091023c9ebd5`, and removed the worktree. Git confirmed the saved file content and commit message. Original project HEAD and checkout files were unchanged. No remote push, merge or source-branch commit was performed. The branch remains in the disposable source repository; private evidence includes `result.json` and `observed-state.json`.

Build and all **91** deterministic tests passed. A separate owned HTTP/browser check with a deterministic ACP peer covered clean collection, edit approval, dirty-close reminder and local commit/collection at desktop/mobile widths, without page errors or horizontal overflow. The real-model acceptance still uses in-memory transport and rendered Ink input, not physical-terminal acceptance. See [worktree behavior, Interface and limits](worktrees.md).

## 2026-10-21: earlier copy workflow baseline

Real bundled `@agentclientprotocol/codex-acp` 2.2.2 with the existing copied file login passed the scoped workflow below. These are real model/tool runs, with Ink input and in-memory application transport; no listener or physical terminal was used. Default workbench startup remains fixture mode. Existing user services and Runs were untouched.

| Check                     | Result | Observed evidence                                                                                                                                                           |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read the existing project | Passed | The same `ptt-web` prompt produced tool activity, a concrete answer and 2 progress reports; 17 original file hashes stayed unchanged.                                       |
| Confirm Task requirements | Passed | The Run was attached to a sample Task and its requirements confirmed through the public work transport.                                                                     |
| Edit and test sample code | Passed | The model changed `token.mjs`, added `token.test.mjs` and ran 3 passing tests. An independent Node check confirmed before/equal/after behavior; a native edit reached Diff. |
| Allow once                | Passed | A genuine elevated marker command waited for approval. Ink input selected Allow once; pending → accepted → delivered was observed and the marker file was created.          |
| Reject once               | Passed | A separate genuine request received Reject once; its command failed and its marker file was absent. No retry was approved.                                                  |
| Cancel an active Run      | Passed | A test command's actual PID was alive while the Run was Running. Ink `x` reached Cancelled and the PID stopped. This was not idle cleanup.                                  |
| Preserve source           | Passed | The two original sample files were unchanged; edits and approval markers existed only in the Run copy.                                                                      |

The earlier routing error was reproduced in the restricted execution environment. Re-running the same harness/configuration with approved network access succeeded. This comparison identifies an outer execution-environment constraint for this reproduction; it does not establish a universal meaning for the provider's routing error. The model, login, global configuration and provider were not changed.

The live trial also exposed Git walking from a copied workspace up to the workbench repository. Local execution now sets `GIT_CEILING_DIRECTORIES` to the owned Run directory. A public regression first reproduced that wrong root, then passed with the fix; a repository initialized inside the Run still works. This controls normal Git discovery, not OS isolation.

Reproduce from the repository root in an environment with provider connectivity:

```bash
npm run qa:codex -- --launch /absolute/path/to/local-config.json
```

This opt-in command uses the supplied local worker/login settings and **replaces its source with an owned Git project initialized from the built-in sample**. It refuses custom adapters, uses no external dependencies in the sample, validates the exact marker command and owned cwd before answering an approval, and closes its own resources. The current harness also checks explicit local commit and worktree collection. It does not change the configured source project or start a server. It is separate from `npm test` and uses real model access.

Private ignored evidence: `.workbench/acceptance/codex-live/trial-L5wzHC/` (restricted failure), `trial-6OtLHR/` (successful existing-project read), and `.workbench/acceptance/codex-workflow/trial-7MMZJ2/` (complete workflow). The last result records the passing independent tests, both approval transitions and stopped cancellation PID. These are acceptance artifacts, not product Run history.

Validation: `npm run build` and all **84** `npm test` checks passed. Open work includes physical keyboard/IME/screen-reader acceptance, API-key/device-login flows, multi-Run token refresh, crash reconciliation, native approval races, Claude, independent Review/check execution and Candidate-bound evidence. This sample does not mark a Task or Phase accepted.

## 2026-10-19: earlier baseline (historical)

Status at that time: **incomplete**. A real project-reading prompt failed before model tool activity. A separate local `/mcp` diagnostic confirmed the progress server is connected.

The committed baseline is `2c3e402`. These probes used the pinned `@agentclientprotocol/codex-acp` 2.2.2, a fresh local Run and actual Ink keyboard input. Application requests were routed in memory: no network listener or physical terminal was opened. Existing user-owned daemons and Runs were left untouched.

## Observed results

| Check                                    | Result     | Observation                                                                                                      |
| ---------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| ACP initialization and new Session       | Passed     | Protocol v1, real Codex ACP 2.2.2, Ready/Idle reached.                                                           |
| Real project-reading task                | Failed     | WebSocket fallback to HTTPS, then `workspace routing discovery failed`; no description or project-reading tools. |
| Autonomous progress                      | Unverified | Zero `agent.progress` events; inference did not reach tool execution.                                            |
| Local MCP registration/discovery         | Passed     | After the prompt-order fix, native `/mcp` reports `workbench_progress`: connected, 1 tool.                       |
| Remote MCP connectivity                  | Failed     | The same status response lists `codex_apps` as failed with an HTTP transport error.                              |
| Approval delivery and model-driven edits | Not run    | The prerequisite real task failed; fixture tests are not native acceptance.                                      |
| Cancellation during real tool execution  | Not run    | No real model tool was running. Cancelling each owned idle Run reached Cancelled and cleaned up.                 |
| Original source preservation             | Passed     | Both probes confirmed all 17 selected original source/test/manifest/documentation file hashes unchanged.         |

The execution environment restricts network access. The routing message and remote MCP HTTP error establish a connection failure symptom, but do not identify whether sandbox egress, account/workspace routing, or adapter/provider compatibility caused it. No model, account, global configuration, authentication flow or network settings were changed.

## Prompt-order regression found and fixed

Reporting instructions previously occupied the first ACP prompt block. The pinned adapter dispatches native slash commands from that first block, so `/mcp` was sent down the ordinary task path instead of handled as a command.

Execution now keeps the original user input first and adds reporting instructions after it. The fixture follows the same command-dispatch behavior and discovers the actual bundled MCP tool for `/mcp`. A regression test failed before the fix and passed after it; the real adapter then returned native MCP status. Progress ownership, approvals and public interfaces are unchanged.

Validation: **61/61 source tests**, TypeScript build and **7 compiled progress tests** passed. This validates the regression fix and existing deterministic behavior, not autonomous live-model progress quality.

## Evidence and reproduction

Private, ignored artifacts are retained locally:

- `.workbench/acceptance/codex-live/trial-DBFDox/`: ordinary read-only task; provider response, state, Live/Timeline frames, source hashes and failed result.
- `.workbench/acceptance/codex-live/trial-awgQ3I/`: native `/mcp` response and connected local server; source hashes and cleanup result. This probe makes no model inference request.
- `.workbench/acceptance/codex-live/probe.tsx`: rerunnable harness. Each invocation allocates new owned resources and a separate artifact directory, and cancels only its own Run.

From the repository root, in a normal terminal with the required provider connectivity and the existing private `ptt-web/launch.json` configuration:

```bash
node --import tsx .workbench/acceptance/codex-live/probe.tsx --mcp
node --import tsx .workbench/acceptance/codex-live/probe.tsx
```

The first command checks local MCP status. The second asks the model to read README, Cargo manifest, Rust entry point and browser code without modifying files or starting services. It requires observed project-reading tool activity and an actual progress event; an Idle state or nonempty error message cannot pass it. A recorded report still needs human review for usefulness and accuracy.

## Manual TUI check

Choose an unused Fetch-compatible port; this example uses 4182:

```bash
WORKBENCH_PORT=4182 \
WORKBENCH_LAUNCH="$PWD/.workbench/acceptance/ptt-web/launch.json" \
npm run tui
```

Press `n` for a new Run and wait for Idle. Press `i`, enter `/mcp` and submit; view `1 Live` to confirm the progress server is Connected with one tool. Then use `i` to submit the ordinary read-only task and view `3 Timeline` for an actual Progress entry. Full output and tool activity remain in Live.

Port 4190 is blocked by the [Fetch Standard](https://fetch.spec.whatwg.org/#port-blocking). A reported startup failure there was reproduced as a native fetch error with cause `bad port`, even though the log showed an earlier successful server bind. The app now rejects these ports before making requests or starting a daemon; this avoids starting unreachable servers on retry. Existing servers and Runs are left intact.

## Checks planned after the earlier failed trial

The 2026-10-21 scoped checks above now cover the basic edit, approval, rejection and active-cancellation path. The original plan was:

1. Check the ordinary task produces a useful report of at most 50 words without explicitly naming the reporting tool in the user request.
2. Exercise a genuine permission request, inspect its scope, allow once in the workbench and confirm accepted versus delivered. Default workspace-write edits may run without approval; that does not test permission delivery.
3. Create only an acceptance marker in the copied workspace, inspect the actual file and diff, and confirm the original source is unchanged.
4. Cancel while a harmless foreground command is observably running, and confirm that owned process stops and pending decisions become stale. Idle cleanup alone does not pass this check.

The [official authentication documentation](https://learn.chatgpt.com/docs/auth#credential-storage) describes file storage under `CODEX_HOME` and copying an auth cache for headless use. It does not establish the cause of the observed routing error or prove that the current login can perform inference.

## New Session follow-up — 2026-10-21

The updated harness opens the actual Ink New Session form at its disposable Git project, loads branches and confirms creation before the existing real-model workflow. `trial-nFdqZx` passed: confirmed Task context, real edit/Diff and three Node tests plus independent boundary assertions, genuine once-only Allow/Reject receipts, cancellation of observed PID 89360, explicit local commit on `workbench/run-b3a40f48-0d5e-4ba4-9e2a-7e04005509c4`, worktree removal and unchanged original HEAD/files. No remote push or physical terminal. The private result is under `.workbench/acceptance/codex-workflow/trial-nFdqZx/`. Deterministic multi-project tests separately exercise saved-branch continuation and per-project Roadmap/Task-context ownership; a real-provider run in every project is not claimed.

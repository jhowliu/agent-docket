# Real Codex acceptance — 2026-10-19

Status: **incomplete**. A real project-reading prompt failed before model tool activity. A separate local `/mcp` diagnostic confirmed the progress server is connected.

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

## Remaining live checks

After inference works, finish acceptance in new test-owned Runs:

1. Check the ordinary task produces a useful report of at most 50 words without explicitly naming the reporting tool in the user request.
2. Exercise a genuine permission request, inspect its scope, allow once in the workbench and confirm accepted versus delivered. Default workspace-write edits may run without approval; that does not test permission delivery.
3. Create only an acceptance marker in the copied workspace, inspect the actual file and diff, and confirm the original source is unchanged.
4. Cancel while a harmless foreground command is observably running, and confirm that owned process stops and pending decisions become stale. Idle cleanup alone does not pass this check.

The [official authentication documentation](https://learn.chatgpt.com/docs/auth#credential-storage) describes file storage under `CODEX_HOME` and copying an auth cache for headless use. It does not establish the cause of the observed routing error or prove that the current login can perform inference.

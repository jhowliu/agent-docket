# Local Codex execution

2026-10-19. Container isolation is deferred by the user's explicit decision. Local mode connects the installed, pinned `@agentclientprotocol/codex-acp@2.2.2` dependency to the existing workbench. It is an explicit launch mode, never a fallback after a container failure. Claude local execution is not implemented in this slice.

## Start

Copy `worker/codex.local.example.json` to a private configuration file and replace the absolute paths. `source.path` selects the project to copy; `workspaceRoot` selects where the workbench retains Run copies. The workbench never accepts these executable/path settings through browser or TUI commands.

```sh
WORKBENCH_LAUNCH=/absolute/path/to/local-config.json WORKBENCH_PORT=4180 npm run tui
```

Use an unused port so existing fixture sessions remain available. If the port already serves a different configuration, the client refuses the mismatch and leaves that server untouched. Reconnect with the same environment settings, or `WORKBENCH_PORT=4180 npm run tui -- --connect`. The daemon reads configuration at startup; editing the file does not reconfigure an existing server.

The default `npm run tui` remains the deterministic fixture. For a foreground server use the same environment variables with `npm run daemon`. The text CLI also accepts `npm run dev -- launch /absolute/path/to/local-config.json`.

## Authentication

Each Run receives a private temporary `HOME` and `CODEX_HOME`. The workbench writes `cli_auth_credentials_store = "file"` into that private configuration, so ordinary credential storage belongs to the Run. This setting uses `CODEX_HOME/auth.json`; managed device policy may still constrain authentication. [Official OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth)

Choose either:

- Add an absolute `worker.authFile` path to an existing file-based Codex `auth.json`. The launcher copies it with private permissions; it does not share the writable file, copy global configuration or write refreshes back to the original.
- Set `CODEX_API_KEY` or `OPENAI_API_KEY` in the environment that starts the daemon. The pinned adapter supports these variables. When sign-in is required, press `s` to see advertised methods, then use `:auth <method-id>`. [Adapter authentication](https://github.com/agentclientprotocol/codex-acp#authentication)

Browser/device-code sign-in inside the workbench is not accepted as working in this slice. Raw adapter/login stderr is drained and excluded from Timeline; do not rely on it to deliver login URLs. File-based login and API-key inference still require live account acceptance. The project trial below used an explicit private copy of the existing file login; credential contents were never printed or included in its logs.

API keys are inherited only when starting the daemon. Attaching to a server cannot change its environment. The temporary Run credential copy is removed on a confirmed stop. Token refresh in one copy is not synchronized to other copies; multi-Run subscription refresh behavior remains unverified.

## Operate and keep the code

- `n` accepts Run startup immediately. Timeline reports readiness/failure; wait for `Idle` before `i` sends a prompt.
- `a/r` and `Tab` keep the existing once-only approval behavior.
- `s` shows real-agent actions or advertised sign-in methods. `p` shows source and Run paths.
- `x` cancels, invalidates approvals and stops the managed POSIX process group. The code copy stays on disk; private home and temporary files are removed after confirmed process cleanup.
- `q` / Ctrl+C detach the TUI. `WORKBENCH_PORT=4180 npm run daemon:stop` explicitly stops the daemon's managed Runs, retaining local code copies.

Directory sources include uncommitted regular files. Copying omits `.git`, `.workbench`, `node_modules`, `.venv`, `__pycache__`, root `target/` build output, `.env`/`.env.*`, symlinks and special files. Nested source directories named `target` remain included. A `copy.json` next to `repo/` records source, omitted paths (up to 1,000), file count and bytes. The limit is 20,000 files / 256 MiB; exceeding it fails startup. Dependencies need installation inside the Run copy. Other source secrets are not automatically detected.

HTTPS Git sources at an immutable full SHA remain supported. They use a separate clone with hooks disabled during initialization, not a shared source working directory.

Workspaces use `workspaceRoot/run-…/repo`; remove retained copies explicitly when no longer needed. There is no automatic retention/GC yet. Workspace files alone are not a durable Run history or a sealed Candidate. Timeline remains bounded in memory and disappears when the daemon restarts.

## Domain and failure behavior

`execution/index.ts` owns launch validation, native mode selection and the high-level Interface. `internal/local.ts` owns copying, private environment configuration, adapter spawning and POSIX process-group shutdown. `worker.ts` dispatches explicit transports. The app reads trusted launch files, checks configuration identity, forwards commands and renders states; it never coordinates native processes itself.

`start()` waits for initialization for programmatic/CLI callers. `launch()` accepts immediately and reports initialization through the same snapshots/events, allowing the TUI to stay responsive during startup. Cancellation also works while copying/initializing, but cleanup may wait for initialization to finish or time out (Git initialization has a 60-second command deadline). Failed initialization retains any code copied so far; private home cleanup is attempted. A retained copy after an early startup failure may need locating directly under `workspaceRoot`.

Local mode shares the user's OS permissions and networking. The adapter requests its `workspace-write` mode, but this implementation does not establish an OS security sandbox or cross-Run access control. A process that deliberately escapes its group, machine crash or daemon crash can leave work behind; no automatic restart reconciliation is implemented. A failed process-group stop is reported as interrupted, without claiming cleanup succeeded. Container/worker isolation and durable ownership remain documented in `isolation-results-plan.md`.

## Validation scope

Public Interface tests exercise native subprocesses with deterministic ACP peers: separate code/home copies, explicit credential copying without changing the source credential, excluded files, real edit approvals, retained code, duplicate cancellation, ordinary child/grandchild termination, configured client transport and TUI sign-in/prompt control. Bootstrap tests verify a configuration mismatch leaves the existing server and approval untouched.

The bundled real adapter also completed an initialization/new-session handshake without credentials, reporting version 2.2.2, ACP v1 and the advertised API-key authentication method. The smoke Run sent no prompt, read no existing login and was stopped/removed afterward. This checks adapter wiring, not a model response.

On 2026-10-19, the user-selected `ptt-web` directory was copied and the real Ink application sent `Describe this project in 200 words.` to the real adapter with a private copy of the existing file login. The harness used in-memory application transport, without a listener or physical terminal. The adapter reached Idle, accepted the prompt and returned `workspace routing discovery failed`; the current execution sandbox reports networking disabled. No project description, model tool activity, approval or diff was received. The adapter still reported `end_turn` and returned to Idle: a completed turn does not establish task success. Cancellation reached Cancelled, the code copy remained, and fingerprints confirmed all 17 selected original source, test, manifest and documentation files were unchanged. Private trial configuration, state and frames are under `.workbench/acceptance/ptt-web/`. Real inference must be retried in an environment with the required connectivity; this attempt does not establish that the login can perform inference.

These tests establish native orchestration behavior, not model correctness or security isolation. Real Codex account authentication/inference, Claude local mode, actual check-result recording, persistent history, Services and the role pipeline remain separate acceptance work.

# Local Codex execution

2026-10-19. Container isolation is deferred by the user's explicit decision. Local mode connects the installed, pinned `@agentclientprotocol/codex-acp@2.2.2` dependency to the existing workbench. It is an explicit launch mode, never a fallback after a container failure. Claude local execution is not implemented in this slice.

2026-10-21: real Codex with the existing copied file login passed project reading, progress, sample-code editing and independent tests, native Allow once / Reject once, and cancellation of an observed running process. The earlier routing failure reproduced under restricted connectivity and the same probe succeeded with approved network access. See [live acceptance and the repeatable command](codex-live-acceptance.md). Physical-terminal and other authentication flows remain unverified; opening the workbench alone does not start a model.

## Start

Normally run `npm run tui`, press **n**, choose **Codex · local**, enter a Git project root and select a starting branch. No launch JSON or environment variable is needed to select a project. The standard server uses the bundled adapter and copies the existing `~/.codex/auth.json` when that file exists at startup. See [New Session](session-creation.md).

For custom operator settings, copy `worker/codex.local.example.json` to a private configuration file and replace the absolute paths. `source.path` supplies a legacy/default project; `workspaceRoot` selects where per-Run Git worktrees live. Ordinary commands can choose a project and displayed base revision, but cannot override executable, credential or storage settings. See [worktree operation and cleanup](worktrees.md).

```sh
WORKBENCH_LAUNCH=/absolute/path/to/local-config.json WORKBENCH_PORT=4180 npm run tui
```

Use an unused port so existing fixture sessions remain available. If the port already serves a different configuration, the client refuses the mismatch and leaves that server untouched. Reconnect with the same environment settings, or `WORKBENCH_PORT=4180 npm run tui -- --connect`. The daemon reads configuration at startup; editing the file does not reconfigure an existing server.

New Session also offers **Fixture · no model** for deterministic testing. For a foreground server use `npm run daemon`, with optional operator settings above. The text CLI also accepts `npm run dev -- launch /absolute/path/to/local-config.json`.

## Authentication

Each Run receives a private temporary `HOME` and `CODEX_HOME`. The workbench writes `cli_auth_credentials_store = "file"` into that private configuration, so ordinary credential storage belongs to the Run. This setting uses `CODEX_HOME/auth.json`; managed device policy may still constrain authentication. [Official OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth)

Choose either:

- Add an absolute `worker.authFile` path to an existing file-based Codex `auth.json`. The launcher copies it with private permissions; it does not share the writable file, copy global configuration or write refreshes back to the original.
- Set `CODEX_API_KEY` or `OPENAI_API_KEY` in the environment that starts the daemon. The pinned adapter supports these variables. When sign-in is required, press `s` to see advertised methods, then use `:auth <method-id>`. [Adapter authentication](https://github.com/agentclientprotocol/codex-acp#authentication)

Browser/device-code sign-in inside the workbench is not accepted as working in this slice. Raw adapter/login stderr is drained and excluded from Timeline; do not rely on it to deliver login URLs. One existing file-based login completed real inference in the 2026-10-21 acceptance; API-key inference remains unverified. The project trial used an explicit private copy of the existing file login; credential contents were never printed or included in its logs.

API keys are inherited only when starting the daemon. Attaching to a server cannot change its environment. The temporary Run credential copy is removed on a confirmed stop. Token refresh in one copy is not synchronized to other copies; multi-Run subscription refresh behavior remains unverified.

## Operate and keep the code

- `n` opens the compact project/starting-branch form. Confirming the form accepts Run startup immediately. Timeline reports readiness/failure; wait for `Idle` before `i` sends a prompt.
- `a/r` and `Tab` keep the existing once-only approval behavior.
- `s` shows real-agent actions or advertised sign-in methods. `p` focuses the Run's actual folder tree; the working path is in the bottom status bar.
- `x` cancels, invalidates approvals and stops the managed POSIX process group. Private home/tmp are cleaned after confirmed stop. Changes in a local Git worktree are committed to the Run's branch, then the worktree and the Run are removed (2026-10-26); a failed commit keeps the Run as `Commit required`.
- Press `c` or use `:commit <message>` on a stopped worktree to commit all non-ignored changes to its local branch, then remove the clean worktree. A failed commit preserves files. You can also commit manually and press `x` again. No remote push or merge is performed.
- `q` / Ctrl+C detach the TUI. `WORKBENCH_PORT=4180 npm run daemon:stop` explicitly stops the daemon's managed Runs and performs the same clean-worktree collection check.

Directory sources check out committed files at the selected local branch/HEAD revision on a unique `workbench/run-…` branch. Source uncommitted/staged/untracked files and ignored dependencies/build output are not copied. Tracked dotfiles and links follow Git checkout behavior; this is not a secret filter. Dependencies need installation in the worktree. Git object storage and repository configuration are shared; source checkout files/index are not modified. Non-Git directories, repository subfolders and unborn repositories are rejected with an actionable error.

Local Git discovery stops at the owned Run directory, so a worktree selects its own Git metadata rather than an unrelated enclosing repository. Local sample fixture copies still omit Git metadata, ignored/dependency/build/config entries and links with the previous 20,000-file / 256 MiB copy limit. This does not restrict arbitrary OS access in local mode.

HTTPS Git sources at an immutable full SHA remain supported. They use a separate clone with hooks disabled during initialization, not a shared source working directory.

Workspaces use `workspaceRoot/run-…/repo`. Closing automatically collects clean directory-source worktrees while keeping their local branch. Local sample/HTTPS clone sources and pre-existing copies retain their old behavior. Workspace files alone are not a sealed Candidate. Run events and approvals stay only in bounded daemon memory; a restarted daemon begins empty and does not restore Sessions. Crash-time environment cleanup remains unconfirmed. See [Run lifecycle](run-lifecycle.md).

## Domain and failure behavior

`execution/index.ts` owns launch validation, native mode selection and the high-level Interface. `internal/worktree.ts` owns Git worktree validation, creation, explicit commits and collection; `internal/local.ts` owns private configuration, adapter spawning and POSIX process-group shutdown. `worker.ts` dispatches explicit transports. The app reads trusted launch files, checks configuration identity, forwards commands and renders states; it never coordinates native processes itself.

`start()` waits for initialization for programmatic/CLI callers. `launch()` accepts immediately and reports initialization through the same snapshots/events. Cancellation also works during initialization, but may wait for Git/adapter startup to settle. Worktree Git commands have a 30-second deadline. Failed startup attempts to collect a clean created worktree and remove private home/tmp. Failures that prevent confirmed process cleanup retain the workspace. Ordinary legacy clone initialization keeps its 60-second command deadline and retention behavior.

Local mode shares the user's OS permissions and networking. The adapter requests its `workspace-write` mode, but this implementation does not establish an OS security sandbox or cross-Run access control. A process that deliberately escapes its group, machine crash or daemon crash can leave work behind; no automatic restart reconciliation is implemented. A failed process-group stop is reported as interrupted, without claiming cleanup succeeded. Container/worker isolation and durable ownership remain documented in `isolation-results-plan.md`.

## Validation scope

Public Interface tests exercise native subprocesses with deterministic ACP peers: separate code/home copies, explicit credential copying without changing the source credential, excluded files, real edit approvals, retained code, duplicate cancellation, ordinary child/grandchild termination, configured client transport and TUI sign-in/prompt control. Bootstrap tests verify a configuration mismatch leaves the existing server and approval untouched.

The bundled real adapter also completed an initialization/new-session handshake without credentials, reporting version 2.2.2, ACP v1 and the advertised API-key authentication method. The smoke Run sent no prompt, read no existing login and was stopped/removed afterward. This checks adapter wiring, not a model response.

On 2026-10-19, the user-selected `ptt-web` directory was copied and the real Ink application sent `Describe this project in 200 words.` to the real adapter with a private copy of the existing file login. The harness used in-memory application transport, without a listener or physical terminal. The adapter reached Idle, accepted the prompt and returned `workspace routing discovery failed`; the current execution sandbox reports networking disabled. No project description, model tool activity, approval or diff was received. The adapter still reported `end_turn` and returned to Idle: a completed turn does not establish task success. Cancellation reached Cancelled, the code copy remained, and fingerprints confirmed all 17 selected original source, test, manifest and documentation files were unchanged. Private trial configuration, state and frames are under `.workbench/acceptance/ptt-web/`. Real inference must be retried in an environment with the required connectivity; this attempt does not establish that the login can perform inference.

The 2026-10-21 live checks extend these deterministic orchestration tests with one real file-login/model workflow. They do not establish general model correctness or security isolation. Other login methods, Claude local mode, product check-result recording, Services and the role pipeline remain separate work.

# Session recap — 2026-10-19 · Local Codex mode

## Current decision and completed work

- User explicitly deferred item 3/container isolation:「3 可以先記錄，先做不containerize的」and asked what comes next. Implemented explicit local Codex execution. Container ownership/network/reconciliation remain proposed in `docs/isolation-results-plan.md`, not implemented. See `docs/local-execution.md` for current operation and limits. AGENTS/main plan preserve this decision, English UI and deep Modules by domain.
- Added exact dependency `@agentclientprotocol/codex-acp@2.2.2` and lockfile entries. Native mode runs its bundled entry through Node. No global adapter install or fallback after container failure. Claude local mode is rejected for now.
- `execution/internal/local.ts` owns native source copying/HTTPS pinned Git clone, private temporary HOME/CODEX_HOME/tmp, selected environment inheritance, explicit optional auth.json copying, process groups and cleanup. Directory copy omits .git/.workbench/dependencies/.env files/symlinks/special files, caps 20,000 files/256 MiB and writes copy.json. Code survives cancel/startup failure/shutdown under workspaceRoot; private home/tmp are removed after confirmed stop. Local mode shares OS permissions/network and is not a security sandbox.
- Public `execution.launch()` accepts startup immediately; `start()` still waits for initialization. Both share reserve/initialize behavior. Run, auth, prompt, approval mapping, cancellation and failure handling remain domain-owned. Existing fixture and Docker/SSH paths remain. Client filesystem/terminal callbacks stay disabled.
- `app/launch-config.ts` loads trusted operator files and fingerprints settings. WORKBENCH_LAUNCH configures the server; UI commands cannot supply executable/path settings. Conflicting existing listeners are left untouched and rejected when a configuration was requested. Server state exposes provider/mode/config identity/source, without raw launch settings. Auth-required Runs count as active; configured startup is asynchronous.
- TUI displays LOCAL / no OS isolation, real-agent actions, source/Run paths and :auth <advertised-method-id>. Browser copy reflects actual mode and hides fixture scenarios for real providers. Existing keyboard/draft/approval safeguards remain. No new Results dashboard. Template: worker/codex.local.example.json. README and operation/capability/keyboard docs link the new guide.

## Validation

- 40 tests pass; TypeScript build passes; browser runtime JS syntax passes; product source Han scan is empty. Native tests cover independent code/home copies, dummy credential refresh preserving the source credential, omitted files, edit approvals, retained code, duplicate cancel, ordinary children/grandchildren termination, cancel during startup, missing-adapter failure, configured client transport and TUI auth/prompt/cancel. Bootstrap test confirms config mismatch preserves the existing server and pending approval.
- Compiled TUI --help succeeds. Legacy text CLI --help is unsupported and returns its usage message with exit1; its interactive help command remains available. Do not repeat the earlier recap's claim that this CLI flag passed.
- Actual bundled Codex ACP 2.2.2 completed an unauthenticated ACP v1 initialization/new-session handshake: authentication-required, method api-key. No prompt, account credential or existing CLI home was used. Its managed group stopped and the smoke-owned workspace was removed. This verifies adapter wiring, not real login/inference.
- All probes/tests used owned temporary resources. No user-owned server/Run was stopped/reconfigured. Earlier default-port observation was 9 existing Runs/0 pending; this task did not inspect/change those. No containers, Docker socket access, publication or real model prompts.
- Earlier English-copy review passed for its own scope. DESIGN.md/sidecar unchanged. Existing .impeccable/review/tui and english-ui captures describe the prior fixture UI, not a new native visual review. Real terminal IME, keyboard negotiation/restoration and screen-reader checks remain manual gaps.

## Current operation

Copy worker/codex.local.example.json to a private config, set absolute source/workspace paths, then:

    WORKBENCH_LAUNCH=/absolute/path/to/local-config.json WORKBENCH_PORT=4180 npm run tui

- Authentication: explicit worker.authFile copies existing file login to the temporary Run home, or supply CODEX_API_KEY/OPENAI_API_KEY when starting the daemon. The private config requests file credential storage. Browser/device-code sign-in is not accepted as working; raw login stderr is excluded from Timeline. Token refresh is not synchronized between copies; live subscription behavior remains unverified. Do not read/dump user credentials to diagnose this.
- Default npm run tui remains fixture on 4177. --connect forbids bootstrap; q/Ctrl+C detach. WORKBENCH_PORT=4180 npm run daemon:stop explicitly stops managed Runs. Timeline is in memory and lost on restart although native code copies persist. Logs: .workbench/daemon-<port>.log. Foreground: npm run daemon with the same env. Text CLI launch <config-file> owns separate Runs.
- j/k select, w next waiting approval, Tab request focus, a/r once-only choice, n new, i prompt, p paths, s actions/auth methods, d approval details, ? help, x cancel, : commands, PgUp/PgDn/g/G scroll. Per-Run drafts survive Esc but not TUI exit. Repeated mutation keys cannot answer the next request automatically.

## Remaining scope and next target

- Next: configure one actual project/login source and accept real Codex prompt→approval→edit→cancel through TUI. Then item 4: authoritative command/outcome/log capture, Candidate/diff and persisted results. Provider messages/diffs remain reported activity, not authoritative verification. Real account/inference acceptance has not occurred.
- Container isolation is deferred. No SQLite/resource ledger/restart reconciliation, full history, sealed Candidate/evidence Module, real Services, PM/profiles or independent Dev→Review→Verify→PR pipeline. Do not mark full M0/M1 complete.
- Native cancellation covers ordinary POSIX groups. Escaped groups and daemon/machine crashes can leave work; no recovery yet. Startup cancellation may await copy/clone completion (Git commands have 60s deadlines). Early failures may leave a copy discoverable only under workspaceRoot. No automatic workspace GC. Windows local mode is rejected; current acceptance ran on macOS.
- Git repository is now initialized on main. User requested the first commit of the current workbench, including the native Codex slice, tests, docs and prototypes; intended message: Initialize agent workbench with local Codex execution. Consult git log for the resulting revision. No push/PR requested. Earlier .git/ps/Docker socket/PTY and separate-listener restrictions were not bypassed. Automated tests retained their normal owned loopback bootstrap coverage.

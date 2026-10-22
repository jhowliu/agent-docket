# Run lifecycle and daemon restart

2026-10-20. The user cancelled History. The workbench no longer creates, reads or updates SQLite Run archives. Run snapshots, conversation, progress, tool activity and approval receipts live only in the current daemon's bounded memory. TUI and browser show active Runs and pending approvals, with Live / Diff / Timeline for the selected Run.

## Closing the screen versus stopping the service

`npm run tui` connects to an existing compatible local daemon, or starts a detached local process when none is available. The daemon owns agent Sessions, output and approval callbacks; the TUI is its operation screen.

- `q` / Ctrl+C in the TUI detaches the screen. The daemon and its Runs continue. Reopening the TUI reconnects to that same process and its retained events and pending decisions.
- `npm run daemon:stop` explicitly stops the daemon and attempts to cancel and clean up its managed Runs. This affects active work. Use the same `WORKBENCH_PORT` as the running service.
- Starting a new daemon after a stop, crash or computer restart begins with empty Run, event and approval state. Old Sessions and permission callbacks are not restored. The client clears old request focus and never automatically replays an ambiguous mutation.

Crash-time OS processes and workspaces are not automatically reconciled or reaped. Empty workbench state does not prove those resources were cleaned up. Local Git directory-source worktrees are collected after confirmed stop when clean; unsaved changes remain actionable until committed. Branches survive worktree removal. Legacy fixture/HTTPS copies keep their previous retention behavior; see [worktrees](worktrees.md) and [local execution](local-execution.md).

## Interfaces and limits

`execution` owns the in-memory Run lifecycle and event window; `attention` owns in-memory decisions and accepted-versus-delivered receipts. Their schemas remain domain-owned. The app composes their public Interfaces and serves bounded `/api/state` polling plus authenticated commands.

`execution.submit()` confirms acceptance into the current process, not durable storage or provider delivery. There is no `historyFile`, `historyDirectory`, archive flag, Run paging or history API. `:history`, `:older`, `:latest` and `:older-runs` are removed. `PgUp/PgDn` and `g/G` scroll only retained events.

The app allows four active Runs and 64 newly created Runs per daemon process. Stopped Runs with a commit-required/retained worktree remain actionable in the current roster until collection succeeds. Terminal snapshots remain in that bounded process-local roster for lifecycle checks, without a past-Run browsing mode. The live event window is at most 2,000 events; approval receipts retain at most 500 in memory. Reaching an expired event cursor requires a fresh snapshot, not a disk replay.

Existing `.workbench/history/` files are left untouched and are no longer used. `WORKBENCH_HISTORY_DIRECTORY` has no effect. Existing running daemons keep their already-loaded code; restarting the TUI alone does not upgrade a daemon. No running user daemon is automatically stopped or replaced.

Daemon startup diagnostic logs and explicitly requested legacy CLI `save` / fixture-demo exports remain separate from automatic Run history. These are not restored into the workbench.

## Validation scope

Tests use public domain Interfaces, owned ACP fixture subprocesses, in-memory Request/Response and Ink input. They cover same-process reattachment, fresh state after daemon replacement, rejection of old permissions, bounded events and removal of history controls/routes. They do not establish real model correctness, OS terminal behavior or external-resource cleanup after a crash.

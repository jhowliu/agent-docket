# Project overview and next actions

2026-10-23. The user's main pains are losing track of progress across projects and not knowing what to do next. The TUI agents roster now groups Runs by project. Each group opens with one line naming the project, its next action and its active Roadmap Phase:

```
! ptt-web · next: approve Run 4 · Phase 1/1 Session tokens
!   Run 4 · ptt-web                          Awaiting approval (1)
-   Run 2 · Refresh expiry                                    Idle
- web-shop · next: prompt Run 1
- > Run 1 · web-shop                                          Idle
~ all-in-one · Run 3 · Located the theme configuration and its entry point…
```

The leading icons and `Unread` came later; see [background notices](background-notices.md).

## Behavior

- **Next action** per Run, most urgent first: `approve` (pending approval), `respond` (pending agent request), `sign-in`, `commit` (stopped worktree with changes), `worktree` (retained for another reason), `prompt` (idle, waiting for the next instruction), `working`, `ended`.
- Runs that ask something of the person (`approve` through `worktree`) move to the top in that order. Other Runs keep launch order, so the roster does not reshuffle whenever a turn starts or ends. `j/k` and `w` follow the order on screen.
- A project's next action is its most urgent Run, including `prompt` before `working`. Projects follow their first Run; equal urgency keeps launch order.
- The header shows `next: approve Run 4`, `next: Run 2 · <request title>`, `next: prompt Run 1` and similar. A working project shows the latest `report_progress` summary retained in the TUI's events, otherwise `Run N working`. The active Phase is shown as `Phase i/n <title>`. Tasks have no completion state yet, so there is no Task count. The line truncates from the end, so the Phase is cut first.
- Urgent next actions are yellow; the rest are dimmed. `:inbox` groups only Runs with pending decisions. When the header of the selected Run's group has scrolled away, the top row shows that project instead. The `i/N` counter appears whenever the roster scrolls.
- Narrow layouts with an inline Project or Roadmap panel keep the one-row roster: just the selected Run, without its project line. Daemons from before the overview (from New Session, 2026-10-21) still send each project's Runs. The TUI groups those in launch order, with headers but no `next:`. This was added after the user saw an ungrouped roster on a live older daemon whose Runs cannot move. Daemons without projects keep the flat launch-order list.
- Browser and CLI are unchanged.

## Module map and public Interface

- `work.ProjectWorkspaces.overview()` owns the ranking. It reads `execution.list()` and `attention.list()` together with the process-local Run ownership, and returns `{ projectId, next, runs[] }` ordered as above (`projectOverviewSchema`, `nextActionSchema`). It reads no plan files and never treats a next action as review, verification or Task completion. Projects without Runs come last. Runs without a project association are left out.
- `work.ProjectWorkspaces.startSession(launch, projectId?)` replaces the app's former `inspectLocalProject` → `register` → `launch` → `associate` sequence. With a project ID, it starts the launch as given in that registered project. Without one, it requires a local directory with a starting branch: it inspects the folder, registers the canonical Git identity, launches from the checkout and names the Run after the folder. Fixture launches wait for startup. Unknown projects and launches without a starting branch fail before any Run exists. App composition still owns trusted presets, the 64 created / 4 active Run bounds and run labels for configured launches.
- `createProjectWorkspaces` now takes `attention` (only `list`) and execution's `list`/`start`/`launch` in addition to `snapshot`/`submit`.
- `GET /api/state` adds `overview`. The protocol field is optional for older daemons.
- TUI `rosterGroups` / `visibleRuns` (`src/app/tui-view.tsx`) only render, falling back to `projects[].runIds` in launch order: they map the overview onto visible Runs and compose header text. A Run that the overview does not place goes into a trailing `Other Runs` group.

## Validation and gaps

Typecheck and all 129 deterministic tests passed. The three new tests in `test/project-overview.test.tsx` cover:

- ranking through the public Interface with every action kind, including an answered approval dropping out and projects without Runs;
- `startSession` starting nothing for an unknown project or a launch without a starting branch, and associating the Run before it returns;
- the real Ink app with two Git projects: launch order while idle, the approval's project first, `k` following the grouped order, order restored after approval, and the older-daemon fallbacks: launch-order groups without next actions, and the flat list without projects.

Two existing assertions were updated. The narrow Roadmap layout may now name the Phase on the roster's project line. The navigation race that exposed reshuffling led to the stable-order rule. Rendered frames at 120×36, 80×24 and 60×20 with three projects and four Runs fit exactly; one capture showed the missing scroll counter, which is now fixed.

Gaps:

- Ordering uses only state in the current process. A daemon restart starts from empty Runs.
- The header has no Task count until Tasks can be accepted.
- Projects without visible Runs are not shown in the roster.
- The browser roster is ungrouped.
- Run labels for local Runs repeat the project name.

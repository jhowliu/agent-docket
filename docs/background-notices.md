# Unread Runs, background notices and roster icons

2026-10-23. Borrowed from the agent multiplexer herdr after the user asked which of its TUI ideas fit. The goal: see which Run has news without selecting it, and hear about it when it is not on screen.

```
! project · next: approve Run 2
!   Run 2 · ptt-web                          Awaiting approval (1)
- > Run 1 · web-shop                                          Idle
*   Run 3 · all-in-one                                      Unread
~   Run 4 · ro-info                                        Running
```

## Behavior

- **Unread.** An idle Run whose latest turn ended after this TUI last showed it. Selecting a Run marks it read. Turns that ended before the TUI connected, or before a daemon restart, count as read. Seen state lives in this TUI process only: another TUI or the browser keeps its own, nothing is stored, and it never changes next-action ranking. A Run that asks for something shows that instead.
- **Icons.** Each roster row and project header starts with a one-column ASCII icon. Every state has a different shape, and the label beside it stays (DESIGN.md's state text rule):
  - `!` yellow: approval, agent request, sign-in, commit or retained worktree;
  - `x` red: failed or interrupted;
  - `*` magenta: unread;
  - `~` blue: starting or running (cancelling is uncolored);
  - `-` gray: idle;
  - blank: ended.

  A project header shows the icon of its most urgent Run in that order. Icons are ASCII because ambiguous-width symbols such as `●` can take two cells in CJK terminal settings and break alignment.

- **Notices.** These changes on a Run that is not selected are announced:
  - a new approval or agent request;
  - sign-in required;
  - the Run failed or was interrupted;
  - a check ended;
  - a turn finished.

  Each Run gets one notice, its most urgent change, in that order. A notice waits one second and is dropped if, by then, the request was answered (for example from the browser), the Run was selected, or a finished Run is no longer idle. It shows beside the roster title for 8 seconds, as in `Run 2 · ptt-web needs approval · +1 more · w jump`, and disappears once its Run is selected. When space runs out, the roster counts give way.

- **`w`** cycles through Runs waiting on the person, then unread Runs, in roster order.
- **Outside the TUI.** Off by default. `WORKBENCH_NOTIFY=bell npm run tui` rings the terminal bell. `WORKBENCH_NOTIFY=osc9` sends an OSC 9 desktop notification with the notice text, in terminals that support it, such as iTerm2. Inside tmux, OSC 9 needs passthrough, so `bell` is the safer choice there. Any other value refuses to start.

## Module map

All of it is app rendering and input, with no domain, protocol or daemon change. Older daemons get it too.

- `src/app/tui-notices.ts`:
  - `unreadRuns` and `turnEnds` read the TUI's event window.
  - `notices(previous, next)` finds changes between two polls of one server instance.
  - `stillNews` re-checks a delayed notice.
  - `noticeText` formats the line.
- `tui-app.tsx` owns per-client seen state, the delay queue, `w` and the optional `notify` prop, which `tui.tsx` builds from `WORKBENCH_NOTIFY`.
- `tui-view.tsx` adds `runStatus`, used by roster rows and the header rollup, and `ScreenProps.unread` / `notice`.

## Validation and gaps

`test/notices.test.tsx` covers:

- a turn from before connect not counting as unread;
- a background turn becoming `Unread` and producing one notice after the delay;
- `w` and selection clearing both;
- the selected Run's own turn announcing nothing;
- an approval answered within the delay never announced, while the turn it ends still is;
- a pending approval outranking unread;
- fit at 120×36, 80×24 and 60×20 with a long CJK notice.

Two older assertions now expect the header icon.

Gaps:

- Turns older than the 2,000-event window cannot be unread.
- No Goto picker, help filter or extra input-editing keys yet (herdr items 4–6).
- OSC 9 has not been checked in a physical terminal.

# Project folders in the TUI

The Project panel shows actual directory entries in the selected Run's workspace. Its root is the same execution-owned cwd used to create the ACP Session. Run number, provider and working path appear in the bottom status bar; Source/Run relationships are not rendered as a file tree.

At 80+ columns a small tree preview sits above Workflow; at 60–79 columns it opens inline. Press `p` to focus Project. `j/k` or up/down select entries, `l` or right expands a folder or enters its first child, and `h` or left collapses a folder or selects its parent. `g/G` and Home/End select the first/last entry; PgUp/PgDn move through entries. Status notices are skipped. `[` / `]`, Enter/Space and `R` remain selection, toggle and refresh shortcuts. Esc or a second `p` closes browsing and returns focus to the workspace.

Press `Ctrl+w`, then `h/l` to focus the workspace/Project; `Ctrl+w w` switches between them. Moving focus keeps tree expansion and selection. The focused pane has a cyan frame and an explicit focus label. Workspace `j/k` selects Runs and `h/l` changes content tabs; those keys never change the Run or tab while Project is focused. Tab keeps its approval-selection role and returns focus to the workspace. Reply/command editing keeps text input separate from navigation; pane-switching shortcuts are inactive there. Files are listed by name; this slice does not open or edit their contents. New filesystem entries appear after refresh. Switching Runs clears the tree and rejects late responses from the previous selection.

Use a new server port for this version, e.g. `WORKBENCH_PORT=4188 npm run tui`. Existing daemons cannot gain the new read endpoint without restart; keep their Runs intact. New daemons restore only the existing project plan, never past Runs or their tree state. All example execution remains the deterministic fixture unless a local provider launch configuration is explicitly supplied.

## Interface and ownership

`execution.listDirectory(runId, relativePath = '')` owns root selection and directory access. It returns validated `ready` metadata or an `unavailable` reason. Invalid paths and unknown Run IDs throw. Only active fixture/local environments are browsable; startup, stopped workspaces and unsupported remote environments have explicit unavailable states. This user-facing metadata query does not enable ACP client filesystem/terminal callbacks.

Paths are relative to the managed Run root. Absolute paths, traversal, excessive depth, links as the root or an expanded directory, and excluded implementation folders are rejected. Symbolic links are listed with `@` and are never expanded. Only names and entry kinds are read, not file contents. Local mode still shares OS permissions and is not an OS security sandbox.

Each directory returns at most 200 entries, directories first. `.git`, `node_modules` and `.workbench` are omitted. Truncated listings are marked. The TUI caches at most 32 directory queries per selection and bounds the displayed tree; refresh clears that cache. These bounds are not a complete large-repository file explorer or filesystem watcher.

The authenticated loopback `GET /api/directory?runId=...&path=...` transport delegates to execution and uses `Cache-Control: no-store`. State advertises optional `features.directoryTree`; older servers retain ordinary controls without unsupported queries. The client validates response schema and requested Run/path identity. `tui-project.tsx` owns view expansion, metadata caching and stale-response suppression; `tui-view.tsx` owns layout and the bottom path strip. Neither chooses arbitrary filesystem roots.

Validation uses public execution/transport interfaces and Ink input/rendering: Run separation, fixture/local metadata, path and link rejection, missing/ended directories, cancellation during reads, bounded/truncated results, auth, lazy expansion/refresh, late responses after a selection change, focused Vim navigation, retained expansion, text-input separation and legacy daemons. Focus is app presentation state; execution and transport interfaces are unchanged. Rendered ANSI captures are not physical-terminal or real-model acceptance.

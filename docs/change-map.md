# Change map

A Change map shows what one Run changed, arranged for reading rather than as a raw diff: the user action that starts each affected flow, the local HTTP route it crosses, the module's public Interface it enters and the changed functions below it. Interface changes and every other change are listed separately. Each function opens a diff of just that function.

It answers "what did this agent change and through which path does it run", which a long Diff tab does not. It is not a review, verification or Candidate evidence: flows are derived statically and can miss dynamic calls.

## Using it

Select a Run in the TUI and press `m` or type `:map`. The TUI asks the platform browser opener (`open` / `xdg-open` / `explorer`) to open `http://127.0.0.1:<port>/changes?run=<run-id>` and shows the same URL in the footer for copying when no browser opens. The page reads its own data from the service; reload it to see newer edits.

When the selected Run finishes a turn in a worktree, the footer says `Turn finished · m see what changed`. Agent-reported edits (ACP tool-result diffs) miss files Codex writes through shell or patch commands, so for Runs with a worktree on disk the TUI Diff tab shows the worktree itself: `Worktree vs <base> · N files · +a −b · m Change map`, then each changed file with its hunks (`@@` cyan, additions green, removals red; binary and oversized files are named, at most 4,000 diff lines). It uses the same read without the TypeScript pass (`files=only`), reloads when the Run records new activity (at most every 1.5 s) and every 5 s while the tab is open, keeps the last result on screen during a reload, and drops a late reply after the selection changes. Like other output it follows the end; `g` jumps to the top. Runs without a worktree (fixture, remote, collected) and older daemons keep showing reported edits; a failed read says why above them.

The page lists flows on the left, grouped as:

- **Flows**: traced from a key press or event, over a local HTTP route, into a module Interface.
- **Sender not found**: the route branch is chosen by the request's shape (for example `'expectedRevision' in command`), so no static sender exists. The route and everything below it are still shown.
- **Other entry points**: calls without the HTTP service, such as `cli.ts` or the service's own lifecycle.
- **Interface changes** and **All other changes** (functions no flow reaches, usually screen code, then every changed file).

One flow is drawn as three tinted bands: blue **Started by** (each trigger chain with its key, such as `[tab]` or `[x]`), amber **Public Interface** (`New` / `Changed` when that export changed) and violet **Inside the module** (changed functions only; `… →` marks skipped unchanged calls, `+N deeper` counts hidden levels, and short shared helpers are listed once as "Also changed"). The page opens on the HTTP flow that touches the most changed functions.

Only Runs whose local Git worktree is still on disk have a map. A fixture Run, a container/remote Run or a Run whose worktree was collected returns an explanatory message; a committed Run's changes stay on its `workbench/run-…` branch.

## Interface and ownership

`delivery.describeChange({ directory, base })` owns the map (`src/delivery/index.ts`). `directory` must be the top of a Git checkout and `base` a commit in it. The working tree, including untracked non-ignored files, is compared with `base`. It never stages, writes, fetches or runs project code: Git runs with hooks off, external diff and text conversion off, and inherited `GIT_*` variables removed; the TypeScript compiler only parses and type-checks source. The result is validated against `changeMapSchema` before it is returned.

- **Files**: status (including renames), line counts, the unified diff and the declarations each hunk falls in.
- **Interfaces**: for each `src/<module>/index.ts`, exported names and Interface members added, removed or changed compared with `base`. A changed doc comment counts as changed.
- **Flows**: from each changed function inside a module, callers are followed with TypeScript references, bridging the module Interface, the local HTTP hop (a route guarded by `… === '/api/…'` matched to the client string that sends it, or to a command object with the guarded `kind`) and JSX prop callbacks. Paths stop at `useInput`, `useEffect` and `createServer` callbacks. Paths are grouped by the HTTP operation; command kinds served by the same code are merged.

A checkout without a root `tsconfig.json`, with no TypeScript files or with more than 4,000 of them gets files and hunks only (`analysis.kind: 'files-only'` with a reason).

Bounds (`changeMapLimits`): 400 files, 256 KB of diff per file and 4 MB per map, 300 starting functions, 3,000 reference lookups, 4 listed triggers per flow and 64 flows. `truncated` names what was cut (`files`, `diff`, `analysis`); an omitted diff is `null`.

The authenticated loopback `GET /api/changes?runId=…` (same token and origin rules as `/api/directory`) resolves the checkout from execution's own Run record; the request only names the Run. `files=only` skips the TypeScript pass (`describeChange({ …, analysis: false })`) for the Diff tab. One read per Run and mode runs at a time and repeated opens share it. The service raises the socket timeout for this route to 120 s. State advertises `features.changeMap`; older daemons keep ordinary controls and the TUI explains that a restart is needed. `GET /changes` serves `preview/change-map.html` with the session token, plus `change-map.js` and `change-map.css` (no inline script or style, so the page keeps the strict CSP). The page renders every value as text.

## Module map

| Area                 | Files                                                                                | Responsibility                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `delivery` Interface | `src/delivery/index.ts`                                                              | `describeChange`, `changeMapSchema`, `changeMapLimits`, `ChangeMap`                                           |
| Git reading          | `src/delivery/internal/diff.ts`                                                      | Checkout/base validation, tracked and untracked changes, per-file diff and changed lines, file text at `base` |
| Analysis             | `src/delivery/internal/analysis.ts`                                                  | Declarations per hunk, Interface comparison, reference tracing and flow grouping                              |
| Contract             | `src/delivery/internal/contract.ts`                                                  | Runtime schema and bounds                                                                                     |
| Transport            | `src/app/web-workbench.ts`, `web.ts`, `workbench-protocol.ts`, `workbench-client.ts` | `/api/changes`, page assets, timeout, feature flag, `changeMapUrl`                                            |
| TUI                  | `src/app/tui-app.tsx`, `tui-view.tsx`                                                | `m` / `:map`, footer URL, help line                                                                           |
| Page                 | `preview/change-map.{html,js,css}`                                                   | Flow list, bands, function-only diff drawer                                                                   |

## Limits

The heuristics are tuned to this codebase's patterns: Ink `useInput` and `key.*`, `command.kind` dispatch, an `/api/` prefix and `src/<module>/index.ts` modules. Other projects get correct files, declarations and Interface changes, but fewer or no flows. Only TypeScript is analysed; the browser preview scripts are plain JavaScript outside the TypeScript program, so routes they call (such as `/api/changes` itself) show as "sender not found". Shared cleanup code can repeat under several flows. Container/remote Runs have no host checkout to read yet.

## Validation

`test/change-map.test.tsx` uses the public `describeChange` and transport Interfaces: a key press traced over HTTP and the Interface to a changed internal function, Interface additions and doc-comment changes, untracked files, files-only checkouts, oversized diffs, rejected directories and revisions, authentication and origin, unknown and worktree-less Runs, shared concurrent requests, the TUI `m` key with an injected opener and the message after a worktree is collected. Earlier, the static tracer recovered 29 of 31 hand-traced steps on the New Session commit. The page was checked in headless Chrome at 1440×900 (dark, light with the drawer open) and 390×844 with no CSP violations, script errors or horizontal overflow.

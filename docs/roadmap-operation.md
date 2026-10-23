# Optional Roadmap tracking

2026-10-20. First runtime slice of the approved compact workspace. TUI and browser use real project planning state through `work`; the separately hosted concept still uses sample data.

## Start and opt in

Use `npm run tui` or the same daemon's browser URL. If an older daemon is already running, choose another available Fetch-compatible port; leave its Runs intact. For example:

```sh
WORKBENCH_PORT=4186 npm run tui
```

Runs start in Direct mode. Planning is optional for each current Run; enabling it does not restart the agent. In the browser, open **Actions → Use Roadmap**, enter a Roadmap name, first Phase, first Task and requirements. With an existing plan, select a Task and **Attach this Run**. The Project disclosure also opens the plan when no Run is selected.

The TUI equivalent is:

```text
:roadmap Token validation
:spec Reject expired tokens at the boundary; preserve refresh behavior.
:confirm
```

The first command creates an Implementation Phase and its first Task, attached to the selected Run. Without a selected Run it creates the plan only. Requirements start as a draft. `:confirm` confirms the saved requirements and sets the working stage to Development. It does not send a prompt or run code automatically; use the existing `i` or `:prompt` controls.

## Compact workspace

- Direct Runs keep agents and Live / Diff / Timeline without workflow tracking. The independent Project tree shows their real folder structure; the bottom status bar identifies the working directory.
- A tracked browser Run adds one compact stage row. In the TUI, terminals at least 80 columns wide put a small **Workflow** panel below **Project** in a separate column (on the left since 2026-10-23), beside the agents and content viewport. It shows the Task's Phase and four vertically arranged stages; only the current step is highlighted. Live / Diff / Timeline remain together in the main column, and their numbers never label workflow stages. `p` focuses project folders, where `j/k` selects entries and `h/l` navigates folders; `Ctrl+w h/l` switches workspace/Project focus. The working path is in the bottom status bar; browsing changes no execution or planning state.
- TUI widths of 60–79 columns preserve the full content width and show an **o Workflow** disclosure next to the content tabs. Opening it reveals the current step and a bounded Roadmap window. Direct Runs have no workflow panel unless the user explicitly opens the saved plan.
- Browser stage buttons inspect a short summary. **Work on this stage** explicitly updates the working stage; inspection alone changes no state. Requirements must be confirmed before tracking another stage.
- **Roadmap** opens a small Phase/Task window. `o` toggles the outline in either interface; the TUI uses the same side column without moving the content tabs or reducing the log height. The narrow layout opens a bounded inline window. The current Task starts in view. TUI `[` / `]` inspect Phases; `{` / `}` scroll Tasks. Inspection never changes the active Phase.
- A Task with a current Run opens that Run in the browser. A Task without a current Run opens the attachment form; it never opens a past Run. **Work on this phase** / `:focus N` explicitly selects the current Phase without accepting the previous one.
- **Direct mode** / `:direct` removes the association only. It preserves the project plan and keeps the Run alive.

## Continue and revise the plan

```text
:phase Delivery
:task 2 Prepare reviewed change
:track 2.1
:focus 2
:spec Prepare the change with its review findings and executed checks.
:confirm
:stage agent-review
:direct
```

`task` uses a Phase number; `track` uses Phase.Task numbering shown in the outline. The browser's Manage panel offers Add Phase, Add Task, attachment and requirements editing. Adding and attaching a new Task is one domain command.

Saving requirements creates a new revision, clears confirmation and returns the Task to clarification. An editor uses the revision displayed when it opened. A concurrent change is rejected instead of overwriting the plan; the browser keeps the unsaved draft. Confirming saved requirements is disabled while its editor contains different unsaved text.

A tracked prompt supplies the current Phase, Task and requirements as a separate context block. The original user message stays first, preserving native slash-command dispatch. Mode switches, requirement edits and input acceptance are ordered by `work`; returning to Direct removes Task context from subsequent prompts.

## What is saved

The daemon defaults to `.workbench/plans/<source-identity-hash>.json`. `WORKBENCH_PLAN_DIRECTORY=/absolute/path` changes the trusted server-side directory. Source identity is independent of the provider, credentials and daemon port. In-process test factories default to memory unless a directory is supplied.

Each project has one current JSON file containing the Roadmap, Phases, Tasks, current Phase, requirements revision/confirmation and working stage. It contains no Run IDs, transcript, events, callbacks, approval receipts or Session credentials. No file is created until planning is explicitly enabled; updates replace the current file rather than appending history.

A daemon restart restores only planning state. New Runs start Direct, and require explicit attachment to continue a saved Task. Restored planning state never restores an agent, a pending tool approval or evidence that an interrupted check passed.

Limits: 8 Phases, 16 Tasks per Phase, 64 Tasks per project, 512 KiB per plan file, 64 current-process Run associations. Existing execution limits remain unchanged. Domain commands require the displayed plan revision; a per-file writer lock and atomic rename protect concurrent updates. Invalid files are preserved and shown as unavailable. A leftover `.lock` requires operator recovery after confirming its writer is stopped; it is never automatically deleted as stale. Plan errors do not stop ordinary Direct Runs.

## Module map and checks

```text
TUI / browser → app transport → work → execution.submit
                              ├─ project plan JSON
                              └─ current-process Run associations

execution → attention → native tool permission responses
```

- `work/index.ts`: snapshot, apply a versioned planning command, submit with current Task context, close. `internal/` owns schemas, limits, persistence, stage/confirmation rules and associations.
- `execution/index.ts`: `submit` accepts an optional bounded context block. ACP, first-message ordering, progress ingress and Run lifecycle stay in execution.
- `app/workbench-protocol.ts`: optional `work` snapshot for older-server compatibility and the domain command union. Commands retain token/origin checks and a bounded 32 KiB request body.
- `app/workbench-work.ts`: terminal command syntax and projection only. `tui-app.tsx` / `tui-view.tsx` keep the original workspace and optional outline.
- `preview/runtime-work.js`: validated browser projection and forms. The main browser script loads it only after a server advertises Roadmap state; old daemons keep ordinary controls without requesting an unsupported asset.

Tests use the public domain and transport Interfaces. They cover opt-in/direct switching, requirements changes, stale/concurrent edits, corrupt-file preservation, source separation, restart without Run/approval restoration, context ordering, native slash dispatch and terminal sizes. Browser QA uses an isolated real fixture server; all example inference remains deterministic fixture behavior.

Validation on 2026-10-20: build/typecheck and diff checks passed; 75 non-listener source tests plus one blocked-port daemon test passed. All nine affected TUI tests passed again after correcting narrow-roster spacing. Fifteen final browser checks passed against an isolated real HTTP fixture server, including a cold restart, original-language requirements, Task rebinding, touch and legacy-server compatibility. Dark/light desktop/mobile captures and Ink 120×36 / 80×24 / 60×20 frames were inspected; the final detector returned no findings. Two automated daemon listener tests remain excluded in the restricted environment; no full npm-test, real-provider or physical-terminal acceptance is claimed. The owned QA service was stopped; existing user daemons were untouched.

## Remaining workflow work

This slice tracks the working stage. It does not execute an independent Agent Review, record Candidate-bound evidence, accept a Task, complete a Phase or automatically hand off to the next Run. Later-stage labels remain unverified; moving a label is not a passed review. These production gates need the independent Review/check execution slice before Human Review acceptance is enabled.

The proposed agent tool that recommends a Roadmap is also not implemented. Manual opt-in works now; a future proposal must remain a draft until the user adopts it. Real provider/account acceptance and container isolation remain separate open work.

# Roadmap and task stepper — proposal

2026-10-20. Design proposal, not an implemented task runner. The user wants to see which implementation Phase the project has reached and keep iterating after discussing requirements. They proposed a four-step task workflow: **Requirement clarification → Development → Agent Review → Human Review**.

Implementation update: the [first runtime tracking slice](roadmap-operation.md) is implemented in `work`, TUI and browser. It includes explicit opt-in, Phase/Task plans, requirements revisions/confirmation, manual working-stage tracking, current-Run associations and plan-file continuity. The full evidence-gated task runner described below remains proposed: no independent review/check execution, Candidate acceptance or automatic Phase completion is claimed.

## Two levels of progress

After the initial requirement discussion, prepare a Roadmap draft from the confirmed scope or implementation plan: Phase outcomes, required Tasks, dependencies and acceptance conditions. The user confirms that plan before it becomes the project's progress reference. Per-Task clarification then resolves the next piece of work within that agreed scope. Later discussions propose explicit plan changes rather than silently rewriting the current Phase.

- Project Roadmap: ordered/dependent Phases, each with an outcome, acceptance conditions and Tasks. Show the active Phase, what remains and the next available work.
- Task stepper: the four-stage workflow for one selected Task. Stage selection reads its content; it does not grant approval, finish work or skip prerequisites. Runs are agent executions within a Stage, including retries.

Completing one Task does not complete its Phase. The Phase is ready to finish only when its required Tasks are accepted and its exit conditions are satisfied. Selecting a later Phase is an inspection action; it must not silently advance the project.

## Compact workspace presentation

The user's latest visual requirement supersedes the original full-page Roadmap/stepper composition. Preserve the existing compact agent roster and selected-Run workspace, with Live / Diff / Timeline as the primary content.

- A tracked Run shows one compact task-stage row beside a current-Phase Roadmap disclosure. The row describes its Task; it does not turn Run completion into Task acceptance.
- The Roadmap is closed initially. Opening it reveals a small anchored window with Phases and their Tasks; narrow screens expand it inline to keep it inside the viewport.
- Stage clicks reveal a short summary without advancing the workflow. Phase clicks inspect the plan; selecting a Task with an active Run opens that Run's workspace.
- A direct Run hides the stage row and Roadmap entirely. The optional mode and proposed agent tool remain design proposals; the concept uses sample associations, not a production mode switch.
- Human Review stays a compact inline decision. Accepting the example Task removes its Run from the active roster and retains accepted Task progress in the plan. A change request returns the Task to Development and marks later reviews for rerun.

The revised standalone concept source is `output/run-workspace-roadmap.html`, published to the existing private concept Site. The earlier `output/task-roadmap.html` fragment is the superseded composition. No real agent, provider, execution state or project data is connected to either concept.

Revised-concept validation: script syntax and 13 final browser interaction/layout checks passed. First-pass captures cover desktop dark, 736/390px light, and 320px dark/touch; no page overflow/errors were observed. A Phase-click popup dismissal defect was corrected. The final capture tools timed out, so final pixel verification remains incomplete; the detector retains one advisory for an inherited color explicitly recorded in DESIGN.md. The earlier six-check validation below applies to the superseded composition.

## Iteration and decisions

Proposed defaults, pending the user's answers:

- The user confirms scope and acceptance conditions before Development. Development and Agent Review hand off automatically; Human Review is explicit.
- Agent Review includes independent code review plus workbench-observed checks, each against the same Candidate. Independent review/check contexts remain required; a stage label does not merge their evidence or imply support already exists.
- Agent or human change requests return the same Task to Development within its current Phase. Human Review is distinct from a tool approval. New code invalidates review/check/acceptance for the old Candidate.
- A changed requirement returns the affected Task to clarification and reevaluates affected work. New ideas become explicit scope changes or additional Roadmap Tasks rather than silently expanding the current Phase.
- After acceptance, show the next unfinished Task; after the Phase exit gate is met, show the next available Phase. Automatic Phase advancement has not been decided.

## Continuity without Run History

Propose keeping the confirmed Roadmap, Task specs and explicitly accepted task/phase progress in project-owned files, so reopening the workbench can answer "where are we and what is next?" This is project planning state, not a transcript or past-Run archive. File format, approval records and exact storage boundary remain to be settled before implementation.

Run conversations, live events and old Sessions remain nonpersistent under the user's existing decision. Reading a saved plan must never imply reconnecting an agent, restoring a permission callback or trusting an interrupted check result. A previously active execution needs a fresh Run or an explicit supported recovery path.

## Proposed implementation slices

1. Establish the Roadmap/Phase/Task/Stage model and public `work` Interface, with transition and version rules tested independently of UI/provider output. Add only real behavior; no empty framework.
2. Display the current Phase, selected Task and stepper in the compact workbench. Read stage artifacts in existing Live / Diff / Timeline views; no History page.
3. Connect scoped requirement confirmation and Development, then independent Agent Review and checks. `execution` owns processes/workspaces; `evidence` owns Candidate applicability; `work` owns transitions. `app` only adapts transport and rendering.
4. Connect Human Review and next-task/next-phase selection. Verify change requests, failed/cancelled checks, duplicate decisions, changed code/spec and reopening a plan without resurrecting execution.

The conversation preview uses synthetic sample phases/tasks to explore these rules. It does not perform inference, modify a real project or claim the workflow is implemented. Real Codex connectivity/approval/cancellation acceptance remains open. Containerization remains deferred.

Preview validation: light/dark at 736px and 320px, stage inspection without advancing, Task acceptance without completing its Phase, selecting the next Task, requirement confirmation, returning to Development with review invalidation, and inspecting a future Phase without advancing the project. The final detector is clean. Product runtime code was not changed for this proposal.

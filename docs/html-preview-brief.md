# Standalone workbench preview

Mode: Operate. Extend the existing oat-agents-inspired roster/detail design into a directly openable HTML + CSS prototype, as explicitly requested by the user. This is not a backend or provider integration milestone.

## Direction contract

THESIS: Make the proposed terminal workbench tangible in a browser, preserving one row per agent and a selected-Run detail panel.

OWN-WORLD: Inherit DESIGN.md's native monospace, fine rules, cyan selection and amber decisions. Default to the dark reference appearance with an explicit light/dark control. The responsive page has no iframe, host runtime, CDN or build dependency.

STORY: Open index.html, inspect three projects, select a Run, view its own Diff/Timeline/Results, respond or approve locally, and reset the demo to try another path. Results is the user-chosen label for the verification summary; unexecuted checks remain explicit.

FIRST VIEWPORT: A project sidebar shows source repo paths, agent membership and attention counts beside the compact roster and selected Run. Each Run shows its own sandbox path and Services summary. Live/Diff/Timeline/Results gain a Services tab; mobile navigation becomes a compact expandable project list above the workbench.

FORM: User-pinned Noopher-AI/oat-agents, extending the already reviewed preview. No new visual-world seed is needed for this scoped extension. The user explicitly requested HTML/CSS implementation.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Signature interaction: accept a command, observe accepted→simulated delivery, then reset and reject or answer the PM. Reset during a pending simulated delivery invalidates that delivery. Every action remains synthetic.

Services extension: reuse a project's service definition per isolated Run, never one mutable shared stack per project. Start the whole stack in dependency order, distinguish starting from health-ready, stop/restart individual services with dependent handling, filter timestamped logs, and show preview endpoint information. A seeded service failure joins the attention list. PM has no service environment. Every status/endpoint is a clearly labeled local simulation; no process, container, port or network request is created. Switching Runs must not redirect an in-flight operation, and reset/stop must invalidate pending callbacks.

Open: real provider execution, credentials, isolation and workflow orchestration remain in M0 and later milestones.

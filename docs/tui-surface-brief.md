# Terminal workbench

Mode: Operate. The user has now moved past the browser demo and requested the next phase, the real TypeScript + React + Ink terminal interface. This is an extension of the approved compact composition, not a new visual world.

Interface copy is now English, per the user. Keep labels short enough for the 60-cell minimum, preserve actual provider option meanings, and distinguish acceptance, transport delivery and task verification. User content and historical logs remain verbatim. See english-ui-brief.md for this copy-only refinement.

THESIS: One terminal keeps agents, their timeline and pending decisions in view.

FIRST VIEWPORT: a quiet workbench / fixture / connection header, one bounded agents roster and one detail viewport defaulting to Timeline. A one-line key hint closes the screen. Paths, actions, help and reply input stay closed until requested. Pending decisions appear inline with their actual once-only choices and an explicit focused request.

- Preserve native terminal typography and theme colors, thin single-line frames, cyan selection, amber decisions and explicit state text. No browser surface colors, shadows, ornamental icons, sidebar, extra counters or Results diagnostics.
- Adapt to terminal cell dimensions. Target 120×36 and 80×24; keep 60×20 usable and show a resize prompt below the minimum. Long CJK paths, messages and diffs cannot write past the viewport; scroll the detail viewport with PgUp/PgDn and g/G.
- Signature interaction: j/k selects a Run, w jumps to another waiting Run, Tab selects another pending request, a/r answers only the visibly focused request's once-only provider choice. After answering, another request requires explicit navigation before it can be answered. Paste is consumed separately from shortcuts. Run drafts remain independent.
- n starts a fixture, i opens reply, Esc preserves its draft, h/l or 1–3 changes views, p shows paths, s shows available actions, ? shows help, : accepts allowlisted UI commands. q / Ctrl+C detaches the TUI; the background server keeps its Runs alive.
- Reuse the existing loopback browser transport. Bootstrap if no server is listening, attach if compatible; do not restart or replace an existing server. No mutation is replayed automatically after an ambiguous connection failure. Reconnect gets a fresh snapshot and cursor, and clears old request focus when the server instance changes.
- This slice is fixture-only and in-memory. A daemon restart loses Runs; it does not restore live requests. Real providers, worker acceptance, persistent recovery, Services and the multi-role pipeline remain separate milestones.

FINISH: public transport + Ink input integration checks, captured real Ink frames at the terminal target sizes, a fresh finish review and a preservation check against DESIGN.md. The HTML/CSS detector does not judge a terminal renderer.

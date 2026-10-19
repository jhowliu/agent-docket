---
name: Agent Workbench Preview
description: Provisional visual system shared by the standalone and conversation HTML workbench prototypes.
colors:
  aw-bg: "light-dark(#f6f8fa, #10151c)"
  aw-panel: "light-dark(#ffffff, #131a23)"
  aw-raised: "light-dark(#edf2f6, #1a2431)"
  aw-text: "light-dark(#1b2a38, #d9e2ed)"
  aw-muted: "light-dark(#526477, #9aaabd)"
  aw-line: "light-dark(#c4d0da, #334458)"
  aw-cyan: "light-dark(#006d78, #78d4df)"
  aw-cyan-wash: "light-dark(#e0f0f3, #17313b)"
  aw-amber: "light-dark(#87500a, #efbd72)"
  aw-amber-wash: "light-dark(#fff4dc, #30291e)"
  aw-green: "light-dark(#277242, #93c7a3)"
  aw-red: "light-dark(#ac343f, #f09aa3)"
typography:
  body:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans TC', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  title:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans TC', monospace"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.55
  note:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans TC', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans TC', monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.55
  brand:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans TC', monospace"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.55
    letterSpacing: "-0.02em"
  input-mobile:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans TC', monospace"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  frame: "8px"
  control: "3px"
spacing:
  compact-row: "5px"
  tight-gap: "6px"
  action-gap: "8px"
  row: "9px"
  inset: "10px"
  section: "12px"
  toolbar: "16px"
components:
  button-neutral:
    backgroundColor: "transparent"
    textColor: "{colors.aw-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
  button-neutral-hover:
    backgroundColor: "{colors.aw-raised}"
  button-selected:
    backgroundColor: "{colors.aw-cyan-wash}"
    textColor: "{colors.aw-cyan}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
  button-primary:
    backgroundColor: "{colors.aw-cyan}"
    textColor: "{colors.aw-bg}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
  input:
    backgroundColor: "{colors.aw-bg}"
    textColor: "{colors.aw-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
    width: "100%"
  tab-active:
    backgroundColor: "transparent"
    textColor: "{colors.aw-cyan}"
    padding: "8px 10px"
  roster-row-selected:
    backgroundColor: "{colors.aw-cyan-wash}"
    textColor: "{colors.aw-text}"
    padding: "9px 12px"
    width: "100%"
  decision-panel:
    backgroundColor: "{colors.aw-amber-wash}"
    textColor: "{colors.aw-text}"
    padding: "12px"
  detail-frame:
    backgroundColor: "{colors.aw-bg}"
    textColor: "{colors.aw-text}"
  project-navigation:
    backgroundColor: "{colors.aw-panel}"
    textColor: "{colors.aw-text}"
  service-table:
    backgroundColor: "{colors.aw-bg}"
    textColor: "{colors.aw-text}"
---

# Design System: Agent Workbench Preview

## Overview

**Creative North Star: "Terminal team roster"**

This is a provisional system shared by the [standalone HTML prototype](preview/index.html) and the earlier [conversation preview](output/agent-workbench-preview.html). The user chose [Noopher-AI/oat-agents](https://github.com/Noopher-AI/oat-agents): compact agent rows, fine rules and a selected Run with detail tabs. The built HTML/CSS is the source for these tokens; the production React + Ink interface does not exist yet. The standalone page uses local CSS and JavaScript without a host runtime, CDN or build dependency.

The standalone extends that surface with project/repo navigation and a Services view for each Run. Paths, service processes, health checks, logs and preview endpoints are simulated UI content; this document records only `preview/`, regardless of separately developed runtime work.

The atmosphere is restrained and operational. Native mono text, quiet blue-gray surfaces and small state accents keep simultaneous Runs readable. Commands, evidence and decision receipts retain explicit demo labels: every project, event and result is synthetic. These pixel sizes describe the HTML mock and remain provisional for a real terminal renderer.

**Key Characteristics:**

- Dense agent roster with a clearly selected Run.
- Flat surfaces, fine borders and native mono typography.
- Cyan selection, amber decisions and readable text beside state colors.
- Inline actions with explicit simulated acceptance and delivery.
- Project hierarchy and per-Run service status using the same visual vocabulary.

## Colors

The source uses paired light/dark values through `light-dark()`; the frontmatter preserves that source format. The standalone page defaults to dark and provides an explicit light/dark toggle; its workbench inherits the chosen page appearance. The earlier conversation preview follows its host appearance.

### Primary

- **Signal cyan** (`aw-cyan`) marks selection, active tabs, running status and the one-time approval action. **Cyan wash** (`aw-cyan-wash`) fills selected rows, project/agent navigation, selected filters, delivery receipts and preview-endpoint information.

### Secondary

- **Decision amber** (`aw-amber`) identifies questions, pending approval, unexecuted evidence and services awaiting health/dependencies. **Amber wash** (`aw-amber-wash`) sets apart the inline decision and rejection areas.
- **Outcome green** (`aw-green`) marks the mock's completed review/draft labels, health-ready services and added diff lines. **Change red** (`aw-red`) marks removed diff lines, failed services and stderr log labels. A green example label is not proof that a real check passed.

### Neutral

- **Workbench ground** (`aw-bg`) carries the frame and input; **panel blue-gray** (`aw-panel`) separates the sidebar, table headings and log well; **raised blue-gray** (`aw-raised`) indicates hover.
- **Reading text** (`aw-text`) carries content; **secondary text** (`aw-muted`) carries projects, timestamps and supporting labels; **fine rule** (`aw-line`) separates regions.

**The State Text Rule.** Pair state color with a readable state label; the small colored dot is supplementary.

## Typography

One native monospace stack carries interface, commands and diffs, with the source's CJK fallback preserved in the tokens. There is no display face or hero type. The title role distinguishes the selected Run; bold role names make roster scanning easier. Timestamp and diff counts use tabular numerals.

Body, title, note and label roles are defined above. Below the narrow breakpoint, body text uses the note size, the selected Run title uses the body size, and the input uses `input-mobile` to remain comfortable to edit. Keyboard hints use the same face as surrounding labels.

## Layout

The workbench fills its container. The standalone page centers that container with a maximum width (1280px), outer padding (28px), and narrow-width padding (12px). Its page ground uses the existing light raised tone and dark ground tone. Below the chrome, a project sidebar (230px) sits beside the flexible main region, where the filter strip, roster and selected-Run details retain their vertical order. This composition is the current preview surface, not a requirement for every future product screen. Reused insets, gaps and row density are in the spacing tokens. The standalone uses standard row density; the original conversation preview's optional compact toggle changes row padding from `row` to `compact-row`.

The full roster uses five columns: task, project, state, engine and diff. Between viewport widths (1001–1180px), the sidebar remains beside it and project/diff columns disappear. At the navigation breakpoint (1000px), the sidebar becomes an initially collapsed disclosure above the main region; expanded projects use three columns. At the intermediate breakpoint (800px), diff and the toolbar summary disappear and service controls move below command details. At the narrow breakpoint (600px), project navigation becomes one column, roster rows become task plus project/state lines, and service rows stack name/health, command/check and controls. Event-kind and roster-heading labels disappear, Results becomes one column, metadata and sandbox paths wrap, and the composer stacks. Service logs put the message below its timestamp/source. Tabs wrap if needed and use compact label sizing. Long commands and diffs wrap. Coarse-pointer controls retain a minimum height (44px).

Current standalone review captures are [desktop-overview.png](.impeccable/review/project-services/desktop-overview.png), showing all six agents, [desktop.png](.impeccable/review/project-services/desktop.png), showing ready Services in dark appearance with viewport/app widths (1440px/1280px), and [mobile.png](.impeccable/review/project-services/mobile.png), showing service failure in light appearance with viewport/app widths (390px/366px). These are review sizes, not additional breakpoints. The older `html-preview/` captures precede the sidebar and Services extension.

## Elevation & Depth

The preview uses no shadows, gradients or blur. Depth comes from fine borders, neutral hover fills, cyan selection wash and amber decision wash. It has no entrance animation, CSS transitions or perpetual spinner. The approval receipt's simulated delivery delay is interaction feedback, not a reusable animation token.

## Shapes

The outer frame has the `frame` radius; buttons and inputs have the smaller `control` radius. Inner roster/detail regions are square and bounded by fine strokes (1px). Active tabs use a cyan underline (2px). Status dots are small circles (5px), paired with text.

## Components

- **Buttons:** Quiet outlined controls use neutral text and fine-rule borders. Hover uses the raised fill. Selected filters use cyan text, border and wash. The primary approval action reverses ground text onto cyan; its hover applies `brightness(.93)`. Disabled controls use opacity (`.55`). Standalone buttons and inputs use a cyan focus-visible outline (2px) with an offset (3px); the project disclosure uses an inset offset (−3px). The earlier conversation preview retains native browser focus.
- **Input:** A full-width, labeled mono field with a fine border, ground fill, cyan caret and muted placeholder. The send action is adjacent on wide layouts and follows the input on narrow layouts.
- **Detail tabs:** The standalone has five compact tabs: Live, Diff, Timeline, Results and Services. Results is the user-chosen label for the verification summary; Services includes a ready/total count. The active tab uses cyan text and an underline; hover uses the raised fill. Arrow keys move among tabs and shortcuts `1–5` select a view. The older inline mock retains four tabs ending with Evidence and its `1–4` shortcuts.
- **Roster row:** The full row is a selectable button. Cyan wash and top/bottom cyan rules identify the selected Run. Role names remain bold; task and project labels use secondary text. Arrow keys move among visible Runs.
- **Decision panel:** An amber-wash region keeps the command/question and its actions together. One-time approval and rejection controls precede a plain demo explanation. The receipt visibly distinguishes accepted response, simulated delivery and rejection.
- **Detail frame:** One bordered region contains selected-Run metadata, its sandbox path and Services shortcut, tabs, content, decision/receipt and composer. PM instead shows that it has no execution environment. Results includes explicit unexecuted/example labels. Diff additions and removals use their outcome colors alongside literal `+`/`−` markers.
- **Project navigation:** A flat panel shows global shortcuts, project names, source repo paths and expanded agent children. Selection uses cyan wash and text; supporting paths use the label role and wrap. Project disclosure and toolbar counts reflect the selected project; global shortcuts retain global counts. A failed service makes its Run actionable alongside unanswered decisions.
- **Services:** Fine-rule rows show service/port, health text, command/check and compact start/retry/restart/stop/endpoint controls. Muted stopped, amber starting/dependency-wait, green ready and red failed states retain explicit text. Stack actions follow dependency order; process start remains distinct from health readiness, and readiness remains distinct from functional verification. Project definitions are reused across separate per-Run simulations. Endpoint information uses cyan wash and explicitly makes no connection.
- **Service logs:** A bordered panel well has a bounded vertical viewport (110–220px), timestamp/source/message columns, source-filter buttons and the most recent 60 entries from that environment. Stderr uses red source text; other sources use cyan. Start/stop events also appear in the Run timeline.
- **Standalone page controls:** Theme and reset are compact neutral buttons in the header. Local storage, when available, preserves the selected project/view, log filter, decisions and appearance. Service process states and service logs remain in memory and return to the seeded example on reload. Reset clears these simulations and invalidates pending callbacks while retaining the current appearance. These controls perform no provider or command action.

## Do's and Don'ts

### Do:

- **Do** reuse the paired theme tokens and preserve readable secondary labels in both appearances.
- **Do** keep selection, pending decisions and outcome text visually distinct.
- **Do** retain demo, unexecuted and simulated-delivery labels while the preview has no live connection.
- **Do** preserve visible focus and keyboard access; use the standalone page's cyan outline for its buttons and inputs.

### Don't:

- **Don't** treat this HTML preview or its synthetic green states as a finished Ink app or verified provider behavior.
- **Don't** replace the user-pinned oat-agents reference with Root-IO-Labs/Open Agent Teams.
- **Don't** add ornamental elevation or perpetual activity motion to the observed flat terminal system.

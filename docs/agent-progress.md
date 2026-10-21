# Agent-authored progress

2026-10-19. Local Codex and the deterministic ACP fixture are given a Run-specific `report_progress` MCP tool. The agent chooses what is meaningful and writes its own short update. There is no keyword classifier, progress-category catalogue, or second model summarizing its conversation.

## Small reporting contract

The tool accepts one field:

```json
{
  "summary": "Located the theme configuration. I am tracing preference initialization before proposing changes; no files have been modified."
}
```

The instructions ask for English, at most 50 words, and updates when there is meaningful progress, a discovery, a blocker, a needed decision, or an outcome. These are examples of useful moments, not required categories or a fixed reporting schedule. Ordinary conversation and the final answer remain in Live.

Validation trims outer whitespace and accepts 1–50 whitespace-separated words, with a secondary 2,000-character bound and no terminal control sequences. It does not classify the meaning or detect language. An invalid call returns a tool error so the agent can revise it; the workbench does not truncate or rewrite the summary. Existing journal redaction still applies.

The tool takes no Run ID, status, percentage, verdict or approval choice. A sentence about a blocker does not create an approval, change Run state or pass verification. Actual ACP permissions continue through `attention` and its existing controls.

## Ownership and transport

`execution` owns the private tool, current-turn identity, validation, redaction, journal events and cleanup. It adds an `agent.progress { summary }` event to its public Interface; `app` only reads and renders it.

For each supported Run, execution provides a private MCP stdio configuration through ACP `session/new.mcpServers`. Each prompt preserves the original user text as its first block, followed by a reporting-instructions text block. The first block must remain user input because the pinned Codex adapter dispatches slash commands such as `/mcp` from that block. The existing `turn.start` event still records the original accepted user input only. The source project and the user's CLI configuration are not edited.

The standard MCP server uses the pinned TypeScript SDK 1.32.1. It exposes only `report_progress`; it follows MCP's [tool discovery/call contract](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) and [stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio). No additional network listener is created.

A private temporary JSONL file carries reports back from the adapter-owned MCP process. Reports are bound to the channel's current turn, read every 100 ms, and drained before `turn.end`. The tool's acknowledgment means the report was written locally, not that a user viewed it. At most 1 MiB of progress records is accepted per Run. The event journal keeps its existing 2,000-event default limit. Stopped or different-turn records are not projected as current progress.

Cancellation/startup failure/shutdown owns cleanup of the temporary channel after stopping the managed process. Local process groups also cover ordinary MCP descendants. This is the existing local execution model, not OS security isolation; escaped processes and crash recovery retain their prior limitations. Progress transport errors are surfaced as diagnostics rather than invented updates.

Container/SSH reporting is not configured in this slice: a host executable or host file channel must not be handed to a remote environment. Claude local execution remains unsupported. No fallback infers progress from chat text when the tool is unavailable or unused.

## Presentation and upgrade

Timeline shows these explicit reports with a cyan `Progress` label and the full summary wrapped to terminal cells. Scrolling counts rendered rows. The previous first-line/240-character Agent previews are removed from Timeline. Existing operational facts, tool grouping, permissions, file notices and neutral turn endings remain. Live keeps the original conversation and also recognizes progress reports; CLI, browser and polling recognize the new event.

Reopening the TUI applies the new presentation, but reports need a new Session on the upgraded daemon so the tool is registered. Existing sessions have no such tool and old conversation is not retroactively converted into reports. No existing user-owned daemon or Run is restarted by this change. The current three tabs remain; there is no `z` mode or tab removal.

The temporary reporting channel and bounded daemon journal are not durable. Reports remain available while the same daemon is running; a new daemon starts empty. See [Run lifecycle](run-lifecycle.md). Reports do not implement workflow-stage transitions, Candidate-bound verification or an independent review pipeline. A real model may omit reports despite the instructions; its autonomous use and report quality require live provider acceptance.

## Validation

`test/progress.test.tsx` uses a real ACP fixture process, a real MCP client and the bundled MCP server through execution's public Interface. It covers discovery/calls, exact free-form wording, 50/51-word limits, empty/control input, Run separation, redaction, cancellation, public polling/reconnection, and complete rendering at 60×20, 80×24 and 120×36. Fixture transport acceptance is not real Codex/Claude model acceptance.

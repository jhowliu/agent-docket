# Turn outcomes and state colors

2026-10-24. The user saw a Run read `Idle` while its agent was stuck on a 404 from GitHub. The agent had asked through `request_user`, the request was marked done, and nothing showed the agent was still waiting; the explanation was only in Live. They asked to see, in the roster and the Timeline, whether an agent is blocked, finished or waiting for an answer, without opening Live.

## Who decides

The agent does, through the Run's private tools; the workbench shows what it declared and never classifies chat. Only the agent knows whether it is stuck or done. A second model or keyword rules reading the reply would guess, cost time and break the 2026-10-19 no-inference rule.

- `request_user` (`action` or `question`) means blocked or asking.
- `report_progress` gained an optional `finished: true`: the agent says the requested work is done. It is the agent's claim, never verification or Task acceptance. For a question, the instructions ask for the answer in brief as the summary, not a note that it answered.
- The instructions now ask the agent to use `request_user` when it cannot continue, for example on missing access or a failing environment, rather than only saying so. They also tell it the session cannot use the person's Git or GitHub credentials, signed-in CLIs or browser sessions, and that it should ask the person to fetch a remote into the shared repository instead of signing in.

## What a turn ends as

Each turn's own events decide it; an open request outranks a done one, and any request outranks a finished report.

| Agent declared             | Roster (left column / right title)                 | Timeline result row                                                        |
| -------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| `request_user` action      | `◉ blocked` / `Blocked`                            | `Blocked · <title> · 25s · 5 tools`; the request row above lists its steps |
| `request_user` question    | `◉ question` / `Question`                          | `Question · <title> · …`                                                   |
| `report_progress` finished | `● finished` (unread) or `○ finished` / `Finished` | `Finished · <summary>` at the report, then `Finished · 25s · …`            |
| nothing                    | `● unread` or `○ idle`                             | `Turn ended · 25s · …`                                                     |

Every result row of a turn that replied ends with `Space reply · N lines` and has the reply's last paragraph beneath it, dimmed.

- **Done is not a reply.** `y` (or Mark done in the browser) closes the request but tells the agent nothing. So the Run stays `◉ blocked` (`Blocked · reply to continue` in the title), the Timeline row reads `Marked done · reply to continue · <title>` in yellow, `w` still stops there and the footer says Enter tells the agent it can continue. The next prompt resolves it and the row turns gray.
- **The reply's last paragraph** is the reply's text after its last blank line, word for word, at most 400 characters, and never interpreted. Since 2026-10-24 it shows under every outcome: a question answered with `finished` kept its answer only in the reply, and the Timeline neither showed it nor pointed to Live.
- **Reading the reply.** `Space` opens the selected row's turn reply over the right pane (the latest reply when no row is selected): its request on the first row, then the reply with its Markdown rendered (below). ↑ / ↓, `Ctrl+U/D`, `PgUp/PgDn` and `g/G` scroll it, the lower frame shows `4–22 of 34`, `Esc` or `Space` closes it, and any other key closes it and acts, so Enter answers what was just read. In Timeline ↑ / ↓ (and the mouse wheel, sent as arrows) select rows with a subtle background; `G` follows the end again. `j/k` alone move between Runs. Chosen over a side-by-side view, which would halve the pane and break the reply's tables, and over mouse clicks, which would take selection away from the terminal.
- **Failures** are unchanged: `✕ failed` means the Run or its agent process broke. A blocked agent is not a failure, so it does not send you to a new Run.
- **No cut rows.** Every Timeline row wraps instead of ending in `…` (2026-10-24, after the user saw tool commands, `Blocked` and `Marked done` rows cut): continuation lines indent two cells, notes four, and a numbered step's later lines hang under its text. Tool titles keep their first line, at most 240 characters.
- Background notices follow the same words: `is blocked: <title>`, `asks: <title>`, `reports finished`, `ended a turn`.

## Markdown in replies

Live and the reply preview render the agent's Markdown instead of printing its markup (2026-10-24, after the user saw `###`, `**` and table pipes in a long answer). `src/app/tui-markdown.ts`, no new dependency:

- headings bold without `#`; `**bold**`, `*italic*`, `~~strike~~`, links as underlined text with the URL dimmed; `\` escapes;
- inline and fenced code on a faint background (`#2b303b`), code blocks indented and never reflowed; quotes behind a dim bar; rules as a dim line;
- lists with `•` (numbers kept) and wrapped lines hanging under the item's text;
- GFM tables in aligned columns with a bold header, honouring `---:` / `:---:`; a table wider than the pane goes row by row;
- CJK wraps anywhere, other text at spaces; the agent's own line breaks stay.

Underscores are not emphasis, since replies are full of snake_case names, and an unclosed marker stays as written. `**…**` closes after CJK punctuation (`**先確認。**不足`), as authors mean, where CommonMark would not. Nested `***` endings, setext headings, HTML and images are not rendered. The reply ending under a result row drops the markers and keeps the words (`inlineText`). Only the display changes; the journal keeps the raw text.

## Colors

One meaning per color across the roster glyph, its state word, the right title, Timeline labels and notices:

| Color   | Meaning                     | Where                                                                                                                                           |
| ------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Yellow  | You need to act             | Approve, Blocked, Question, Sign in, Commit, Worktree; `Needs you`, `Blocked`, `Question`, `Marked done · reply to continue`; the pending count |
| Red     | Something broke             | Failed, Interrupted; `Run failed`, `Tool failed`, `Checks failed`                                                                               |
| Green   | Reported finished or passed | `Finished` (the agent's claim), `Checks passed`, `Tool completed`, `Reply delivered`                                                            |
| Blue    | Working                     | Running, Starting; `Turn started`, `Tool running`                                                                                               |
| Magenta | New to you                  | Unread; turn notices                                                                                                                            |
| Cyan    | Focus and narration         | Selection, the active section, `Progress`, `Request` (your prompt)                                                                              |
| Gray    | Quiet                       | Idle, `Turn ended`, `Ready for prompt`, expired or resolved rows, reply endings                                                                 |

Green never means verified or accepted unless a check passed. Yellow is reserved for "waiting on you", so a resolved `Marked done` row turns gray.

## Module map

- `execution`: `progress-protocol.ts` (`finished` in `progressInput`/`progressRecord`, instructions), `progress-server.ts`, `progress.ts`, `runtime.ts` (`agent.progress.finished`), `index.ts`/`contract.ts` event type and schema. Older daemons simply never send `finished`.
- `src/app/tui-outcome.ts` (new): `outcomeOf(turnEvents, attention)`, `latestOutcomes(events, attention)`, `lastParagraph(text)`, `startsTurn(event)`.
- `tui-timeline.ts` `turnReplies(events)` keys each turn's request and reply by its first event; `TimelineEntry.turn` names a row's turn. `tui-view.tsx` draws the selected row, the reply and the frame hint (`FrameEdge`) and reports the scroll it shows (`onViewport`) so keys never scroll past an end; `tui-app.tsx` holds the row selection and the open reply. `tui.tsx` turns on alternate scroll (`CSI ?1007h`). Fixture: `lines:<n>` replies with n lines. `tui-markdown.ts`: `markdownLines(text, width)`, `inlineSpans`, `inlineText`; the view draws its spans (`Spans`).
- `tui-timeline.ts`: `Finished` progress rows, request steps as `notes`, the result row per turn, `Marked done` turning gray once a new turn starts. `tui-view.tsx` renders `notes` as dim indented lines and gives `runStatus` the outcome. `tui-notices.ts` words turn notices by outcome. `tui-app.tsx` lets `w` and the footer treat unreplied done requests as waiting.
- Fixture: `done:<summary>` reports finished.

## Validation and gaps

`test/turn-outcome.test.tsx` covers:

- `finished` reaching the journal only when declared;
- blocked with steps, staying blocked after Done until a reply;
- the resolved `Marked done` turning gray;
- a silent turn showing its reply's last paragraph;
- finished in green without verification words;
- a question.

Older tests now expect `Blocked`, `Turn ended`, `ended a turn` and the reply ending. `test/reply-peek.test.tsx` reads a 40-line reply with Space, scrolls it by arrows, Ctrl+D and `g/G` without overshooting the end, selects a Timeline row with ↑, answers with Enter from the reply, and checks that `j/k` still move between Runs while arrows scroll Live. `test/markdown.test.tsx` covers inline styles, unclosed markers and snake_case, blocks without markup, wrapping within the width with hanging list lines and unreflowed code, and aligned or row-by-row tables.

Whether real Codex calls `request_user` and `finished` at the right moments still needs a live run. When it declares nothing, the reply's last paragraph remains the fallback.

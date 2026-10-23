# Ink TUI：M1 第一個切片

2026-10-20。這是可執行的 React + Ink 終端介面，連接 M0 runtime。依使用者決定移除 History，Run／事件／核准只保留於本次程序的有界記憶體。同一 daemon 現已支援多個本機 Git 專案；完整 M1 的兩家 provider、崩潰環境對帳、遠端 worker 與 Services 尚未完成。

Update: [Local Codex mode](local-execution.md) adds trusted server-side launch configuration through `WORKBENCH_LAUNCH`, a `LOCAL / no OS isolation` status and `:auth <method-id>` for advertised authentication methods. New Session now offers a compact project/starting-branch form with explicit Codex local or Fixture selection. Project selection needs no launch file; see [New Session](session-creation.md). Local Git directory sources use [worktrees](worktrees.md): clean close collects the worktree, unsaved changes remain as `Commit required`, and `c` / `:commit <message>` saves to the local branch before collection. Home/tmp are cleaned after confirmed stop. Scoped real-provider acceptance is recorded in `codex-live-acceptance.md`.

## 啟動與離開

```sh
npm ci
npm run tui
```

需要 Node.js ≥22.16、互動式 stdin/stdout，建議 80×24 以上；最低可用 60×20。低於最低尺寸顯示放大提示，仍可 q／Ctrl+C 離開。一般模式使用 alternate screen，離開後還原 terminal；`INK_SCREEN_READER=true` 時不啟用 alternate screen，尚未做真實輔助科技驗收。

TUI 先連接 `http://127.0.0.1:4177`。只有服務無法連線時才嘗試啟動獨立的本機背景程序；不相容的 listener 不會被替換。啟動 log 為 `.workbench/daemon-<port>.log`，不含控制 token。兩次 TUI 連線及瀏覽器頁面共用同一個 runtime，沒有各自啟動一份 agent。

`q`／Ctrl+C 僅離開 TUI，不取消 Run。重開 TUI 取得目前快照與有界 timeline；仍在等待的核准沿用同一筆 ID。這是重新附著到存活的程序。背景服務程序停止後再啟動則從空白開始，沒有舊 Run、事件或核准可恢復；畫面清除舊核准焦點。崩潰後外部程序是否已清理仍需對帳。草稿與選取狀態只留在當次 TUI，不跨退出保存。詳見 [Run 生命週期](run-lifecycle.md)。

```sh
npm run tui -- --connect
npm run daemon
npm run daemon:stop
```

`--connect` 禁止自動啟動；`daemon` 是前景服務，與 `ui` 同一入口；`daemon:stop` 明確停止該 port 的背景服務，取消／清理它管理的所有 Run。`WORKBENCH_PORT=4180` 可套用到上述任一命令。若連接先前啟動的舊 M0 server，shutdown 可能未提供；使用原服務的 Ctrl+C，不能以 TUI 相容性推定其支援新生命週期命令。

Choose a port supported by HTTP Fetch, such as 4177, 4180 or 4182, and available on your machine. Ports in the [Fetch Standard's blocked list](https://fetch.spec.whatwg.org/#port-blocking), including 4190 and 6000, are rejected before connection or daemon startup. Previously, 4190 could start a server that the TUI could never reach; retrying then produced `EADDRINUSE`. Changing ports leaves the existing server and its Runs intact.

編譯後可用 `node dist/src/app/tui.js`、`node dist/src/app/tui.js --stop`；需保留 checkout 的 `preview/` 與 `fixtures/`。非互動式環境使用 `npm run dev -- fixture` 或 `--help`。

## 最小操作

1. `n` 建立 Run，`i` 輸入 `fix`，Enter 送出。這會啟動真實的 deterministic ACP fixture 程序。
2. 收到核准時，顯示聚焦請求的標題與實際一次性選項。`a` 允許一次，`r` 拒絕；`Tab` 換另一筆，`w` 換另一個等待的 Run。一次回答後，須明確選定下一筆，避免長按誤答。
3. `1` 看完整回覆與工具活動，`2` 看實際 before／after 文字，`3` 回 timeline。`PgUp/PgDn` 捲動；`g/G` 頂端／末端。Timeline 只列操作事件摘要；Live 與 Diff 可讀取換行內容。
4. 右上方 Project tree 顯示目前 Run 的實際資料夾與檔案；`p` 聚焦後用 `j/k` 移動、`h/l` 收合／展開或回父層／進入子項、`R` 重新整理，Esc 回工作區。`Ctrl+w h/l` 切換工作區／Project 焦點並保留展開狀態；`[`／`]` 與 Enter 仍可操作。Run 工作目錄與 worktree 分支顯示於底部。`x` 或 `:cancel` 停止 Run 並讓核准失效；乾淨 worktree 回收後從名單移除，有修改則保留 `Commit required`，用 `c`／`:commit <message>` 保存至本機分支後回收。
5. `q` 離開後重開 `npm run tui`，等待中的請求仍在。

Run 名單依專案分組，每組第一行寫專案名、下一步與目前 Phase；需要你處理的 Run 排在前面，其餘維持啟動順序。詳見 [Project overview](project-overview.md)。

`:active` 顯示進行中的 Run，`:inbox` 顯示待核准的 Run。`PgUp/PgDn`、`g/G` 只捲動目前保留的事件視窗；沒有過去 Run 名單、歷史分頁或自動存檔。

`:prompt question` 觸發文字提問，閒置後用 i 回覆 `reply:名稱`。`:prompt two-permissions` 同時提出兩筆核准；`:prompt wait` 等取消；`:prompt crash` 測異常退出。一般文字指令只在 idle 接受，尚無執行中 steering。

## Timeline and streaming output

At 80+ columns, the **Project** panel above Workflow shows real folders and filenames from the selected Run workspace. The bottom status bar shows that Run, provider and working path. `p` focuses browsing; `j/k` selects entries, `h/l` collapses/expands folders or moves to their parent/first child, and `g/G` selects first/last. Arrows follow the same focus; `[` / `]`, Enter and `R` remain selection, toggle and reload controls. `Ctrl+w h/l` focuses the workspace/Project and `Ctrl+w w` switches between them without clearing expansion. Focus is labeled and framed in cyan. Esc closes browsing; Tab retains approval selection. Narrow terminals use **p Project**. This is read-only directory metadata through execution, not file contents or a cwd change. Fixture/local workspaces are supported; old daemons need a new server on another port. See [Project tree](project-tree.md) for limits and transport details.

Optional project planning is available in the compact workspace: `:roadmap <title>` creates a plan, `:spec <text>` and `:confirm` confirm requirements, `o` opens the small outline, and `:direct` detaches tracking. Project plans survive a daemon restart; Run associations, transcripts and permissions do not. Current stage tracking does not pass a review. See [Roadmap operation and module map](roadmap-operation.md) for attachment, Phase/Task commands, storage, concurrency and remaining gates.

The TUI keeps three views. Timeline shows Request previews, explicit agent-authored Progress reports, one activity row per tool per turn, named approval receipts, file-change notices and failures. Reports are at most 50 words and wrap in full; ordinary chat no longer becomes a first-line Timeline preview. Turn endings include elapsed time and tool/file counts instead of the raw `end_turn` label and another Idle row. Technical diagnostics stay in Live and the environment header. A turn ending is not task acceptance, and a provider-reported tool status is not authoritative verification.

Timeline uses the user's revised status palette: green for provider-reported tool completion or a delivered human answer, blue for starting/running, cyan for messages, yellow for attention and red for failures. Idle and turn endings are gray: a turn ending alone does not establish success. This deliberately changes Oat's green-start/blue-exit convention. Timestamps are dim; event labels are colored and bold; commands and paths are bold; descriptions stay ordinary text. Decisions/retries will use magenta when their reporting protocol exists. Colors use the terminal theme, and every status remains readable without color. Role colors await actual role identities.

Live holds accepted prompts, full assistant text and tool activity. Consecutive text deltas in the selected Run are concatenated exactly before sanitizing and wrapping to terminal cells. Whitespace, newlines and split Unicode sequences are preserved; other Runs do not split a message. A tool, approval, lifecycle or turn-ending event in the same Run closes the text group. Projections leave raw journal entries and cursors unchanged. Activity grouping is TUI-only; browser and legacy debug CLI also recognize the new `turn.start` event. The in-memory live window remains bounded to 2,000 events. Older events are dropped and cannot be loaded from disk; the retained window may lack a message or turn's opening context.

The information split follows the inspected [oat-agents tabs](https://github.com/Noopher-AI/oat-agents/blob/c830f3e59726086fcb3d86dd6e0415687bd40d9b/src/tui/tabbed.rs#L15-L24): its Timeline reads workflow-log entries, Live shows the real tmux terminal, and Log reads the agent transcript. Its [Timeline filters](https://github.com/Noopher-AI/oat-agents/blob/c830f3e59726086fcb3d86dd6e0415687bd40d9b/src/tui/mod.rs#L77-L118) select all workflow events, lifecycle or decisions; “all” does not mean every streamed token. Our Live continues to render ACP data directly; no native CLI attachment or separate Log tab was added.

See [Timeline ingestion](timeline-ingestion.md) for oat-agents' actual producers/JSONL reader, our event ownership and compatibility. Reopening the TUI improves old retained events; Request records require new prompts handled by an upgraded daemon. Existing prompt text cannot be reconstructed from lifecycle-only history.

Operational summaries remain single-row previews. Explicit Progress reports wrap in full, with rendered rows used for page scrolling. Full retained assistant messages remain in `1 Live`. See [Agent progress](agent-progress.md) for the Run-specific MCP tool, 50-word limit and upgrade requirements. Oat uses [single-line Timeline summaries](https://github.com/Noopher-AI/oat-agents/blob/main/src/tui/text.rs#L293-L335); its [Log view wraps the transcript or full event fields](https://github.com/Noopher-AI/oat-agents/blob/main/src/tui/tabbed.rs#L249-L280). Its Timeline `e` key cycles filters, not expansion. Our earlier proposed general `z` toggle and tab removal were not implemented.

Use `:prompt stream` in fixture mode to reproduce six small ACP chunks forming `summarize its purpose.`. `test/streaming.test.tsx` covers the original per-fragment display bug, selected-Run/turn boundaries, whitespace/CJK/emoji, terminal widths 60/80/120, Timeline filtering, incremental polling and reconnection.

Use `:prompt progress` in fixture mode to exercise the actual MCP reporting path. `:prompt progress:<summary>` submits a chosen report; excessive/empty reports return a tool error. This is a deterministic fixture, not a live model. New real Sessions receive the same reporting tool and brief instructions.

詳細按鍵、草稿與貼上行為見 [tui-keyboard.md](tui-keyboard.md)。所有 `:` 命令都是工作台白名單，沒有 shell 執行。`a` 不會自動選永久允許；d 顯示實際選項與細節，可用 `:answer N` 明確指定。

## Module 與傳輸

```text
Ink TUI ─┐
         ├─ loopback Request/Response ─ app composition ─ execution / attention
Browser ─┘
```

- `execution/index.ts` 提供啟動、輸入、取消、快照、有界事件與訂閱；`submit` 只確認本次程序已接受輸入。`attention/index.ts` 管核准有效性、一次回覆、交付與關閉；兩者不提供磁碟 History 或歷史分頁。
- Domain 擁有快照／事件／收據 schema；`app/workbench-protocol.ts` 組合傳輸 envelope，執行期驗證快照、事件、回覆與命令；不公開 ACP 的來源 request ID 或程序 handle。
- `app/workbench-client.ts` 封裝同源 token bootstrap、游標增量、事件視窗、斷線與 server instance 切換。重連不自動重送 mutation，避免回覆遺失時執行第二次操作。
- `app/workbench-daemon.ts` 只負責連線與背景 server 啟動；不持有 Run 規則。`app/tui-app.tsx` 負責本機輸入／選取／草稿，`tui-view.tsx` 只投影資料，`tui-input.tsx` 做 terminal 編輯與貼上。

Daemon 同時最多 4 個活躍 Run，每次程序最多新建 64 個 Run，live 視窗最多 2000 事件，核准紀錄最多保留 500 筆於記憶體。終止狀態暫留在本次程序的有界快照中供取消／失效判斷，操作名單不提供過去 Run。TUI 每 400ms 取游標增量，單一 client 的 poll 合併進行，畫面最多 20fps。這些設定不是延遲／CPU benchmark。

## 已驗證與缺口

`npm test` 包含原有 domain／CLI／browser 測試，以及 Ink 輸入、並行核准、一次性回覆、貼上隔離、獨立草稿、中文／emoji 編輯、斷線、遺失回覆不重送、server instance 切換與真實背景程序啟停。`npm run build` 編譯全部入口。

`npm run qa:tui` 用自有暫存 fixture 產出 `.impeccable/review/tui/` 的 120×36、80×24、60×20 Ink frame。PNG 是保留 cell 位置的 review wrapper 截圖，**不是 OS terminal 截圖**。輸入測試使用 Ink 模擬串流；真實 terminal 的 IME、kitty 協定、色盤與 screen reader 仍需人工試用。

History 的 SQLite、封存與分頁測試已隨功能移除；目前以公開 Interface 驗證重新連線保留活躍請求、程序重啟清空狀態且不能回答舊核准，以及沒有歷史入口。兩個 daemon listener 測試仍需允許綁定的環境。真實 Codex 的限定檔案登入／改檔／核准／取消／commit 流程已通過；其他登入方式、physical terminal、worker image／container 驗收、崩潰環境對帳、Services 與獨立階段仍未完成。可信 fixture 的暫存副本不是 OS sandbox，不可據此承諾真實 agent 隔離。

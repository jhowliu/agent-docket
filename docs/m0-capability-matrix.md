# M0 能力與驗證紀錄

2026-10-21 current result: real local Codex ACP 2.2.2 with one existing copied file login passed the scoped checks below. The test used actual Ink input and in-memory app transport, without a listener or physical terminal. Restricted execution reproduced the routing failure; the same read probe succeeded with approved network access. Full evidence and opt-in reproduction: [Codex live acceptance](codex-live-acceptance.md).

| Current Codex local check                                                           | Result                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Initialization, model inference, project reading, bounded progress                  | Passed for the existing file login                                                               |
| Task requirements context, sample edit, Diff, independent before/equal/after checks | Passed; 3 Node tests passed                                                                      |
| Genuine Allow once and Reject once                                                  | Passed; accepted/delivered events and actual marker presence/absence checked                     |
| Cancellation while a command PID is alive and Run is Running                        | Passed; Cancelled and process stopped                                                            |
| Source preservation and Git discovery within the Run                                | Passed; sample originals unchanged and parent-repository regression fixed                        |
| Local project worktree, dirty close reminder, explicit branch commit and collection | Passed with real Codex and Ink input; source HEAD unchanged, local branch kept, worktree removed |
| Other authentication flows, native races, physical terminal, Claude, containers     | Unverified                                                                                       |

Build and all **91** deterministic source tests passed. Worktree-specific checks cover clean collection, staged/binary/untracked changes, failed commit/retry, locks/branch changes and source preservation. These checks do not complete all M0/M1 acceptance or implement Candidate-bound evidence and review gates.

## Earlier results (historical)

2026-10-19 update: explicit [local Codex mode](local-execution.md) is implemented using pinned codex-acp 2.2.2. Native orchestration, separate code/home copies, cancellation and TUI authentication routing are exercised with deterministic peers. The real adapter completed an unauthenticated ACP v1 initialization/new-session handshake and advertised API-key sign-in; no prompt or existing login was used. Model/account acceptance and container isolation remain unverified. Earlier worker-only scope below is historical.

日期：2026-10-18。Node 22.16.0，ACP SDK 1.9.0，TypeScript 5.9.3。本機只確認版本：Codex CLI 0.163.0、Claude Code 2.1.302；未使用這兩個本機程序執行開發任務。Worker image 規劃釘選 codex-acp 2.2.2、claude-agent-acp 0.93.0，尚未 build。

| 能力                                     | 固定 ACP fixture                   | Codex adapter                 | Claude adapter                |
| ---------------------------------------- | ---------------------------------- | ----------------------------- | ----------------------------- |
| 初始化與新 Session                       | stdio 實測通過                     | 啟動入口已寫，未實測          | 啟動入口已寫，未實測          |
| 串流文字／工具／diff                     | 實測通過                           | 未實測                        | 未實測                        |
| 核准／拒絕，opaque option 精確映射       | 實測通過，含同時兩筆請求           | 未實測                        | 未實測                        |
| accepted／transport delivered／stale     | 實測通過                           | 未實測                        | 未實測                        |
| 文字提問及下一回合回答                   | 實測通過                           | 未實測                        | 未實測                        |
| 取消、重複操作、取消與回答競態           | 實測通過                           | 未實測                        | 未實測                        |
| 程序異常退出／啟動中關閉                 | 實測通過                           | 未實測                        | 未實測                        |
| 多 Run 程式副本分離                      | 實測通過；可信測試程序，非 OS 隔離 | Container／network 邏輯未實測 | Container／network 邏輯未實測 |
| 真實模型、登入、計費／訂閱               | 不適用，沒有模型                   | 未實測                        | 未實測                        |
| Client filesystem／terminal callback     | 明確不宣告；檔案 callback 拒絕實測 | 不宣告                        | 不宣告                        |
| Structured elicitation／resume／steering | 未實作／不宣告                     | 未實作／不宣告                | 未實作／不宣告                |
| 真實 Services／預覽代理                  | HTML 模擬                          | 未實作                        | 未實作                        |

21 個公開 Interface／CLI／瀏覽器傳輸測試已通過；`npm run build` 通過，先前編譯後 demo 及 replay 也已成功。新增測試驗證雙 Run 的允許／拒絕與實際 diff、副本清理、失效／重複核准、busy 拒絕、游標增量／重設、異常退出，以及瀏覽器控制輸入／來源限制。已完成的 fixture checks 不代表兩家 provider 支援相同行為。完整 M0 驗收仍需兩家各自完成真實文字、工具、diff、核准、問答與取消，以及隔離／清理前後比對。

尚待提供 remote worker／登入設定。直接 shell 存取 Docker socket 被拒；`npm run doctor` 的 Node 子程序讀到 Docker Server 28.0.4。不同命令路徑的可達性不一致，沒有據此啟動 container，也沒有用本機真實 agent 程序替代隔離執行。

瀏覽器原型 `preview/index.html` 已驗證 project scoping、各 Run 的服務分離、依賴順序、停止／重設的 callback 失效、log 篩選與故障重試；1440／1024／800／390／320px 無水平 overflow。此多專案／Services 原型仍未連線。

新增 `npm run ui` 的 M0 測試台預設連接真實 fixture runtime。已從實際 loopback HTTP 在瀏覽器操作允許／拒絕、各 Run diff、文字問答／回覆與等待取消；相同五種寬度無水平 overflow。2026-10-20 依使用者決定取消 History，以公開 Interface、記憶體內 Request/Response 與 Ink 輸入驗證 [Run 生命週期](run-lifecycle.md)：同程序重連保留活躍請求，新程序從空白開始。沒有在此切片重跑 listener 驗收。真實 Services、模型、登入與遠端 daemon 尚未完成。

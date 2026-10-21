# M0 操作與模組說明

2026-10-19 update: [Explicit local Codex execution](local-execution.md) is now available through a trusted `WORKBENCH_LAUNCH` file. Default startup remains the fixture. Configured servers start only their selected Run type; executable/path settings are still rejected from client commands. Local copies survive cancellation/shutdown, and the TUI supports advertised `:auth` methods. The fixture/container-specific sections below describe the earlier M0 scope; account inference and container isolation acceptance remain outstanding.

這是整合驗證切片。`npm run demo`／`npm run dev -- fixture` 與 `npm run ui` 瀏覽器測試台已能執行。M1 的第一個切片已加入 `npm run tui`：Ink 終端入口與本機背景服務，詳見 [TUI 操作](tui-operation.md)。`preview/index.html` 的多專案原型仍是獨立示例資料；`preview/runtime.html` 經測試服務開啟時會操作真實 ACP fixture。兩家真實 provider 的實測是尚未完成的 M0 門檻。

## 瀏覽器測試台

`npm run ui` 後開啟 `http://127.0.0.1:4177`；若 port 已被占用，設定 `WORKBENCH_PORT=4180 npm run ui`，使用服務顯示的網址。僅監聽 `127.0.0.1`，瀏覽器輸入只會啟動內建可信 fixture，不接受 shell 命令、worker 設定或真實 provider。來源 repo 與暫存執行路徑分別列出。

1. 按 n 新增 Run，按 s 展開操作後觸發改檔核准，或以 `:fix` 觸發。待處理數彙整所有 Run；點選 Run 處理 provider 提供的核准選項。
2. 一個允許、一個拒絕。Diff 列出實際變更前後文字；拒絕不會產生 diff。Timeline 可追溯 request 的 accepted／transport delivered／stale，Live 顯示訊息與工具狀態。
3. 在 idle Run 展開操作後點「Text question」，等回合結束後按 i 輸入名稱並送出。這是一般文字的下一回合回覆，沒有假裝支援 structured questions 或即時 steering。
4. 用「Wait for cancel」、`:permissions` 及 `:crash` 測試取消、兩筆核准與異常退出。取消終止整個 Run，舊核准失效；需要再測時新增 Run。

這仍是瀏覽器操作 Demo，可與 Ink TUI 連到同一個 server。名單只顯示進行中的測試或待核准項目，沒有過去 Run 入口。分頁為 Live／Diff／Timeline；程式版本與連線識別可在 Timeline 展開「Technical details」。

依新參考精簡為上方 agents、下方 timeline，預設不常駐來源側欄、測試按鈕或回覆表單。專案路徑按 p、執行操作按 s、回覆按 i 展開；Esc 保留草稿並收起，成功送出後也會收起。核准顯示精簡操作列，傳送狀態使用頁尾，不另增獨立區塊。

介面每 600ms 取得快照與游標增量，背景頁每 2 秒更新；保留最近 2000 事件，游標過期時明確重取目前視窗。斷線保留草稿但停用操作，回覆遇到失效驗證要求重新整理。工具完成或 idle 不代表功能驗證通過。Vim 風格按鍵、命令欄及輸入防誤觸見 [鍵盤操作](tui-keyboard.md)。

控制傳輸有固定資產白名單、來源／Host 檢查、每次啟動的回覆 token、8KiB body 上限。同時最多 4 個活躍 Run，每次程序最多新建 64 個 Run。本機 server 可由 TUI 自動啟動並在 TUI 退出後存活；Run／事件／核准只在本次程序的有界記憶體，重啟從空白開始。詳見 [Run 生命週期](run-lifecycle.md)。遠端部署／環境對帳尚未實作。

關閉頁面不會停止 Run。Ctrl+C／SIGTERM 停止服務時，runtime 清理自己建立的程序與目錄。編譯後可執行 `node dist/src/app/web.js`，需保留 checkout 中的 `preview/` 與 `fixtures/`。

## Module 地圖

| Module／入口     | 公開 Interface                                   | 封裝的規則                                                                                                       |
| ---------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `attention`      | `src/attention/index.ts`                         | 建立決策、回答、送達、失效、快照與訂閱；阻擋重複或無效選項，pending 上限 100／記憶體紀錄 500                         |
| `execution`      | `src/execution/index.ts`                         | 啟動、登入、prompt、取消、Run 快照、timeline、關閉；ACP、來源 request／option／連線世代、worker 與清理均留在內部 |
| `work`           | `src/work/index.ts`                              | 可選 Roadmap／Phase／Task、需求版本與確認、階段位置、計畫儲存、目前 Run 關聯與 Task context；不宣稱審核通過 |
| `app`            | `src/app/cli.ts`                                 | CLI 命令與顯示、設定輸入、匯出／閱讀紀錄；只呼叫上述公開 Interface                                               |
| `app` 瀏覽器入口 | `src/app/web.ts`、`src/app/web-workbench.ts`     | Node loopback 與 Request／Response 轉接、固定資產及輸入驗證；Run 與核准規則仍只使用 domain 公開 Interface        |
| `app` TUI 入口   | `src/app/tui.tsx`、`src/app/workbench-client.ts` | Ink 鍵盤與畫面、每 Run 草稿、token／快照／游標轉接；共享同一個 server，不持有工作流規則                          |

`work` 已有第一個計畫追蹤切片，詳見 [Roadmap 操作](roadmap-operation.md)。`evidence`、`delivery` 尚無實際行為，因此沒有先建立空 Module。Review／Verify 獨立交接與 PR 規則仍在後續里程碑。Services 的真實管理會由 `execution` 封裝環境與程序生命週期，`attention` 呈現故障，Results 保留測試與服務健康的不同意義。

## 核准與取消

ACP SDK 使用正式 v1 entry point 與 fluent client。收到 permission 時，execution 保留原始 JSON-RPC request ID、Session、option ID 及當次連線世代；UI／attention 只看自己的 item／choice ID。

`pending → accepted → delivered` 分開記錄。`delivered` 指對應 JSON-RPC 回覆已寫入 adapter 的 stdio transport，不代表 provider 已收到、執行成功或測試通過。原始 opaque option 會精確映射；重複回答沒有第二次副作用。

取消會使未決及已接受但尚未寫出的決策失效，後到回覆改為 cancelled；已開始寫出的訊息無法收回，因此 Run 取消也會停止並移除自己管理的執行環境。Adapter 異常退出會留下 interrupted；prompt 回合結束只回到 idle，不等於 Task 完成。執行中不支援 steering，新的 prompt 會被拒絕並要求等 idle。

目前不宣告 client filesystem／terminal callback，也不宣告 structured elicitation／resume；未實作的方法由 SDK 拒絕，不能繞回本機工具。一般文字問答使用下一回合 prompt。

## 隔離與 worker

`fixture` 是可信任的固定測試程式：每個 Run 複製到獨立暫存目錄，以不含使用者 API keys 的最小環境執行。它驗證協定與副本分離，**不是 OS sandbox**，不能拿來執行真實 agent 或不可信工具。

真實 provider 的 Docker／SSH 入口會建立各自的 container 與 network；無本機 repo、CLI home、Docker socket 的可寫掛載，也不發布 host ports。容器非 root、根檔案系統唯讀，workspace、CLI home、tmp 各為私有 tmpfs；有記憶體、CPU 與 PID 上限。來源是內建 fixture，或 HTTPS Git URL + 完整不可變 commit SHA。Git checkout 的 hooks 關閉。

這些容器／網路限制已寫入啟動程式，**尚未實際驗證**。直接 shell 存取 Docker socket 被拒，`npm run doctor` 的 Node 子程序卻讀到 Server 28.0.4；尚未據此啟動容器。本機 Docker 仍會消耗本機運算資源；remote Linux worker 符合目前主要方向。

準備 worker：

1. 在你選定的 Linux worker 安裝 Docker 與可供非互動連線的 SSH。這個專案不會修改 SSH、known_hosts 或本機 CLI 登入設定。
2. 將專案中的 `worker/Dockerfile` 與 `fixtures/project` 放到 worker；在專案目錄執行 `docker build -f worker/Dockerfile -t agent-workbench-m0:0.1 .`。Image 釘選兩個 adapters 的發布版本，尚未在此建置。
3. 在 worker 以權限受限的 env file 提供該 provider 的登入環境。內容不放進 source／image／命令列。Codex adapter 支援 `CODEX_API_KEY`／`OPENAI_API_KEY`；Claude SDK 的 API-key 路徑使用 `ANTHROPIC_API_KEY`。訂閱／OAuth 登入不可由 API-key 路徑推定相同，需另外實測。
4. 修改 `worker/*.example.json` 的 SSH alias、image 和 worker 端 env file。也可明確使用 `{"transport":"docker","image":"agent-workbench-m0:0.1"}`；程式不會在失敗後自動切換模式。
5. `npm run dev -- launch <config.json>`。若回報 authentication-required，使用畫面列出的 `auth <method-id>`；未提供登入頁面轉送，不會把 native CLI UI 接到工作台。

取消與關閉會刪除該 Run 的 container／network。若 worker 失聯或刪除失敗，會回報清理錯誤；可在 worker 依 `workbench.run=<Run ID>` label 對帳。Daemon crash 後的自動對帳、閒置期限、清理重試與持久化屬於 M1。

## Services 後續接法

專案儲存服務定義：命令、工作目錄、依賴、healthcheck、環境內 port。實例屬於 Run／Environment；不能把不同 candidate 的可寫 DB 或開發程序合併為同一組。M1 優先在 worker 端重用 Docker Compose 的依賴與 logs 能力，再經 `execution` 的完整操作呈現給 UI。啟動依賴要明確使用健康條件；Compose 只看到 running 並不代表服務 ready。

預覽網址由 worker 的存取受控代理提供，不把每個 Run 的 3000／8000 直接占用成本機 port。服務故障形成可去重的 attention item；使用者能從同一處定位 log 並重試。此管理器、代理及故障持久化目前尚未實作，HTML Services 只做交互示意。

## 紀錄與除錯

`npm run doctor` 僅檢查本機 CLI 版本與 Docker 可達性，不會連接模型。Adapter stderr 持續排空但不存入 timeline，避免直接保存任意登入診斷；不要把它當成完整 provider log 收集器。

Timeline 是有序且有界的記憶體紀錄，預設最多 2000 事件。過期 cursor 會明確失敗；取得新快照後才能補錄。Daemon 不自動保存 Run 歷史。獨立文字 CLI 的 `save` 仍可明確匯出目前保留的紀錄，檔案以私有權限建立；已存在檔案的權限沿用檔案本身。內容包含專案輸出，token pattern 遮罩不是完整秘密掃描。

`replay` 只讀取／顯示有序事件，不會恢復程序或舊核准。`npm run build` 後也可用 `node dist/src/app/cli.js demo`，仍需保留 checkout 裡的 fixture 目錄。SDK／adapter 來源與本次結果見能力矩陣。

來源：[ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)、[Codex adapter](https://github.com/agentclientprotocol/codex-acp)、[Claude adapter](https://github.com/agentclientprotocol/claude-agent-acp)、[Claude SDK](https://code.claude.com/docs/en/agent-sdk/overview)、[Compose health dependency](https://docs.docker.com/compose/how-tos/startup-order/)、[Compose logs](https://docs.docker.com/reference/cli/docker/compose/logs/)。

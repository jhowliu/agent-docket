# Agent Workbench

TypeScript 開發中的多專案 agent 工作台。已有 React + Ink 終端介面、共用的本機 fixture 背景服務，以及瀏覽器操作 Demo。

## 從 terminal 使用

```sh
npm ci
npm run tui
```

需要 Node.js 22.16 以上與互動式 terminal。TUI 自動連接本機 `127.0.0.1:4177`；沒有服務時啟動背景服務，不需另外開一個 terminal。畫面保留 agents＋timeline，按需展開回覆、路徑和操作。

- `n` 開啟 New Session：輸入 Git 專案根目錄、Enter 讀取分支，選起始分支後 Enter 建立獨立 worktree。路徑欄 `Tab` 可列資料夾並補全，用方向鍵與 Enter 選取；`Shift+Tab` 回 Agent 欄選 Fixture 測試模式。建立後 Enter（或 `i`）輸入需求。
- 工作區焦點下，`j/k` 切換 Run，`h/l` 或 `1–3` 切換 Live／Diff／Timeline；`PgUp/PgDn` 捲動。`w` 跳到待核准，`a/r` 允許一次／拒絕；`Tab` 選下一筆核准。
- 左欄列出各專案的 agents；Run 工作路徑顯示於底部。`s` 看操作、`?` 看按鍵、`:` 輸入白名單命令。
- `Esc` 收起回覆並保留草稿；`q`／Ctrl+C 只離開 TUI，重開可繼續處理原本的 Run。

TUI 與同網址的瀏覽器共享 Run 和核准。啟動不會自動連線模型；New Session 可明確選擇本機 Codex 或可信 Fixture，不需用環境變數／JSON 指定專案。不同專案的路徑與 Roadmap 隨所選 Run 切換，也可選之前保存的分支接續程式碼。詳見 [New Session 操作](docs/session-creation.md) 與 [本機 Codex 模式](docs/local-execution.md)。本機 Git 專案使用每 Run 的獨立 worktree／分支與 CLI home，仍不是 OS sandbox。`x` 停止後回收乾淨 worktree；有修改則顯示 `Commit required`，按 `c` 輸入訊息或用 `:commit <message>`，保存至本機分支後回收目錄，不自動 push。詳見 [worktree 操作](docs/worktrees.md)。選取有本機 worktree 的 Run 按 `m`（或 `:map`），會在瀏覽器開啟 [Change map](docs/change-map.md)：從按鍵經 HTTP route、模組 Interface 到被修改函式的 flow，以及逐函式 diff；flow 為靜態推得，不代表 review 或驗證。Run／事件／核准只保留在背景服務的有界記憶體；不保存或查閱過去 Run，服務重啟從空白開始。草稿只保留在當次 TUI。停止服務：`npm run daemon:stop`；只連線不自動啟動：`npm run tui -- --connect`。服務 log 在 `.workbench/daemon-4177.log`。詳見 [Run 生命週期與重啟限制](docs/run-lifecycle.md)。

可用 `WORKBENCH_PORT=4180 npm run tui` 選擇另一個 port；停止時使用同一個 `WORKBENCH_PORT`。TUI 不會替換已存在的服務；先前的 M0 服務可連線，但若不支援 shutdown，仍需回原服務的 terminal 用 Ctrl+C 停止。前景 `npm run ui`／`npm run daemon` 的 Ctrl+C 也會清理其 Runs。

詳見 [TUI 操作與範圍](docs/tui-operation.md) 和 [鍵盤操作](docs/tui-keyboard.md)。

Project 區顯示目前 Run 的實際 [資料夾結構](docs/project-tree.md)，支援 fixture／local 工作目錄的唯讀檔名瀏覽。舊 daemon 不支援目錄介面時，使用新 port 啟動新版，例如 `WORKBENCH_PORT=4188 npm run tui`，保留既有服務與 Run。

真實 Codex 的既有檔案登入、改檔／Diff、測試、一次性允許／拒絕與執行中取消已完成限定案例驗收。可用 `npm run qa:codex -- --launch /absolute/path/to/local-config.json` 在可連線環境重跑；它使用真實模型操作內建小型測試專案副本，與 Fixture 選項不同。範圍與證據見 [真實 Codex 驗收](docs/codex-live-acceptance.md)。

已提供可選的 [Roadmap 追蹤](docs/roadmap-operation.md)：`:roadmap <title>` 建立計畫，`:spec <requirements>`／`:confirm` 確認需求，`o` 開啟小型 outline，`:track 2.1` 接續既有 Task，`:direct` 回一般 Run。瀏覽器從 Actions → Use Roadmap 操作。只保存專案計畫與需求版本，Run 對話與核准仍不存檔；獨立審核與驗收門檻尚待後續切片。

直接用瀏覽器開啟 [HTML 原型](preview/index.html)。左側查看專案來源路徑與 agents，選取 Run 後可試用 Services；這裡的核准、服務與結果均為模擬。

M0 已實作 ACP v1 client、集中核准、各 Run timeline、隔離 worker 啟動入口與可重播 fixture。Codex／Claude 的真實隔離往返仍待可用 worker 與登入設定，尚未達成完整 M0 驗收。

## 從介面測試

```sh
npm ci
npm run ui
```

開啟終端顯示的 `http://127.0.0.1:4177`。這仍是瀏覽器操作 Demo，與 Ink TUI 使用相同傳輸；如果 TUI 已啟動服務，直接開啟網址即可，不需重複執行 `npm run ui`。精簡版只常駐 agents 和 timeline。按 n 開啟 New Session，選 Fixture 並建立後，按 s 展開操作選「Request edit approval」；可分別允許／拒絕再比較 Diff／Timeline，也可用命令欄觸發情境。

可用 `j/k` 選擇、`h/l` 切換分頁、`a/r` 回答核准、`i` 展開回覆、`Esc` 收起、`p` 查看來源路徑、`s` 展開操作、`:` 輸入命令、`?` 查看說明。名單只顯示進行中的 Run 或待核准項目；協定診斷收進 Timeline 的技術細節。詳見 [鍵盤操作](docs/tui-keyboard.md)。

選 Fixture 時使用真實 ACP fixture 程序與各自的暫存副本，不連接模型；選 Codex 時使用所選 Git 專案的 worktree。可信 fixture 並非 OS sandbox。按 p 可找到原本的多專案／Services 原型，其中仍是模擬資料。

同時最多 4 個活躍 Run，每次服務啟動最多新建 64 個 Run，事件視窗最多 2000 筆。關閉瀏覽器頁面不會取消 Run；在終端以 Ctrl+C 停止服務會清理自己的程序與暫存環境，本機 Git worktree 依保存／回收規則處理。要改 port，啟動前設定 `WORKBENCH_PORT`。開發／編譯後啟動與驗證限制見 [操作說明](docs/m0-operation.md)。

## 啟動

需要 Node.js 22.16 或以上；在專案根目錄：

```sh
npm ci
npm run demo
npm run dev -- fixture
```

`demo` 只會自動回答內建 fixture 的核准，示範兩個獨立程序、允許／拒絕、文字問答與取消，並產生 `.workbench/replays/m0-demo.jsonl`。不會連接模型。

互動入口內可以輸入：

```text
prompt fix
answer 1 1
inbox
start fixture
runs
use 2
prompt question
prompt reply:token-boundary
cancel
save
quit
```

核准項目與選項依畫面顯示的編號回答；可以在不同 Run 執行期間繼續下指令。一般 prompt 必須等所選 Run 回到 idle，尚無即時 steering。這個舊文字 CLI 的退出會清理自己建立的環境；它與 TUI 的背景服務分開。

```sh
npm run doctor
npm test
npm run build
npm run dev -- replay .workbench/replays/m0-demo.jsonl
```

## 真實 provider

先複製 `worker/codex.local.example.json` 並填入絕對路徑，再啟動本機 Codex：

```sh
WORKBENCH_LAUNCH=/absolute/path/to/local-config.json WORKBENCH_PORT=4180 npm run tui
```

需準備登入資料，專案路徑需指向已有 commit 的 Git 根目錄；詳見 [本機模式設定、認證與限制](docs/local-execution.md)。既有檔案登入的真實模型流程與 worktree commit／清理已有限定驗收，其他登入方式與 Container 隔離仍是後續工作。

原有 container worker 模板仍可設定後使用：

```sh
npm run dev -- launch worker/codex.example.json
npm run dev -- launch worker/claude.example.json
```

這兩份設定需先替換 SSH alias、image 與 worker 上的 env file 路徑。Container 啟動失敗不會自動切換為本機模式。

詳見 [M0 操作與模組說明](docs/m0-operation.md)、[能力矩陣](docs/m0-capability-matrix.md) 與 [整體計畫](docs/implementation-plan.md)。

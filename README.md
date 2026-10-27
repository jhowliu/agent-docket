# Agent Workbench

TypeScript 開發中的多專案 agent 工作台。已有 React + Ink 終端介面、共用的本機 fixture 背景服務，以及瀏覽器操作 Demo。

## How to use

### 1. 啟動

```sh
npm ci
npm run tui
```

- 需要 Node.js 22.16 以上與互動式 terminal。TUI 會連上 `127.0.0.1:4177` 的背景服務，沒有就自動啟動。
- 用本機 Codex 前，先在這台電腦用 Codex CLI 登入一次（產生 `~/.codex/auth.json`）。每個 Run 會複製一份私有的登入資料，不會改動原檔。也可以在啟動服務的環境設定 `CODEX_API_KEY`／`OPENAI_API_KEY`。
- 用本機 Claude 前，執行一次 `claude setup-token`，把印出的 token 單獨存成 `~/.config/agent-docket/claude-token`（`chmod 600`）。每個 Run 用私有的 Claude 設定，不會載入你 `~/.claude` 的 hooks／plugins。詳見 [Claude 登入與設定](docs/local-execution.md#claude-login-and-configuration)。
- 已經有舊版服務在跑時，重開 TUI 不會更新它。要用新版就換一個 port：`WORKBENCH_PORT=4242 npm run tui`。

### 2. 開一個 Session

1. 按 `n`。Agent 預設是 **Codex · local**；`Shift+Tab` 再用 ←/→ 可改選 **Claude · local**，或 **Fixture · no model**（不連模型、只用來試操作）。
2. 輸入 Git 專案根目錄（`Tab` 補全），按 `Enter` 讀分支。不是 Git 的資料夾會詢問要不要初始化，預設 No。
3. 選起始分支後按 `Enter`。工作台會建立新的 `workbench/run-…` 分支和獨立 worktree，不會動到你原本的 checkout。

### 3. 跟 agent 工作

- `Enter`（或 `i`）打開輸入欄，打需求後按 `Enter` 送出；`Esc` 收起，草稿會保留。
- `1` Live、`2` Diff、`3` Timeline；`Space` 讀該回合的完整回覆；`j/k` 切換 Run。
- agent 要權限時，`w` 跳到等你處理的 Run，`a` 允許一次，`r` 拒絕一次，`d` 看細節。agent 請你在工作台外做事時，做完按 `y`；要回話就直接下 prompt。
- 左欄每個 Run 都會顯示狀態，黃色（`approve`、`respond`、`commit`、`review`、`checks`）代表輪到你。

### 4. 用 Task 流程驗證成果（可選）

```text
:check npm ci && npm test        專案的檢查指令，在乾淨的副本上跑
:roadmap Token validation        建立計畫與第一個 Task，綁定目前選取的 Run
:spec Reject expired tokens.     寫需求
:confirm                         確認需求，進入 Development
```

之後照常下 prompt，Task 的內容會自動附上。agent 回報 finished 之後：

- 工作台會自動跑 Check。失敗時把輸出送回 agent 修。
- Check 通過後，另一個 reviewer Run 會在唯讀副本上依需求審查（左欄會多一個 `Review · …` Run，審完就消失）。有問題時會把 findings 送回 agent 修。Check 失敗和 review 意見合計最多送回兩次，還是不行就停下來等你（左欄顯示 `checks` 或 `agent review`）。
- review 核可後 Task 進入 Human Review（左欄顯示 `review`）：用 `:accept` 接受，或用 `:changes <要改什麼>` 退回，意見會送給 agent。review 只是建議，Check 通過時你隨時可以 `:accept`。
- 想讓另一個模型審：`:reviewer claude`（或 `codex`），之後這個專案的 Agent Review 都改由它來做；`:reviewer same` 改回各 Run 自己的 agent。
- 隨時可以按 `v` 手動驗證。要加下一個 Task：`:task 1 <title>`，再用 `:track 1.2` 綁定。`:direct` 回到不綁 Task 的一般 Run。
- accepted 不代表已經 commit 或 merge。

### 5. 看改動與收尾

- `m` 在瀏覽器開啟 Change map，顯示從按鍵到被修改函式的 flow 和 diff；`2` Diff 可以直接看 git diff。
- `x` 停止並移除 Run：worktree 裡的改動會自動 commit 到這個 Run 的分支（不會 push），提示會顯示分支名稱。想自己寫 commit 訊息，就先到 worktree 路徑（顯示在底部狀態列）自己 `git commit`，再按 `x`。Run 自己結束（中斷、失敗）且還有改動時，也可以按 `c` 輸入訊息。
- 要接續工作：按 `n`，選同一個專案，分支選那個 `workbench/run-…`。
- 要合併：回到原本的 repo 自己執行 `git merge workbench/run-…`。工作台不會 merge，也不會 push。

### 6. 離開與停止

- `q`／Ctrl+C 只會關掉畫面，Run 會繼續跑；再執行 `npm run tui` 就能接回。
- `npm run daemon:stop` 會停止服務並取消所有 Run。服務重啟後是空的：沒有歷史紀錄，也不能恢復舊對話，程式碼只留在分支裡。
- agent 連續 10 分鐘沒有任何動靜，該回合會被中斷（`No agent activity for 10 minutes`）。
- 本機模式沒有 OS 隔離，agent 擁有你這個使用者的權限。

完整按鍵見 [鍵盤操作](docs/tui-keyboard.md)，流程細節見 [Task flow](docs/task-flow.md)、[worktree 操作](docs/worktrees.md)。

## TUI 細節與限制

畫面保留 agents＋timeline，按需展開回覆、路徑和操作。左欄列出各專案的 agents；Run 工作路徑顯示於底部。`s` 看操作、`?` 看按鍵、`:` 輸入白名單命令。

TUI 與同網址的瀏覽器共享 Run 和核准。啟動不會自動連線模型；New Session 可明確選擇本機 Codex 或可信 Fixture，不需用環境變數／JSON 指定專案。不同專案的路徑與 Roadmap 隨所選 Run 切換，也可選之前保存的分支接續程式碼。詳見 [New Session 操作](docs/session-creation.md) 與 [本機 Codex 模式](docs/local-execution.md)。本機 Git 專案使用每 Run 的獨立 worktree／分支與 CLI home，仍不是 OS sandbox。`x` 停止並移除 Run：worktree 的修改先自動 commit 到 Run 分支再回收目錄；Run 自己結束且還有改動時，可用 `c`／`:commit <message>` 自己寫訊息；不自動 push。詳見 [worktree 操作](docs/worktrees.md)。選取有本機 worktree 的 Run 按 `m`（或 `:map`），會在瀏覽器開啟 [Change map](docs/change-map.md)：從按鍵經 HTTP route、模組 Interface 到被修改函式的 flow，以及逐函式 diff；flow 為靜態推得，不代表 review 或驗證。Run／事件／核准只保留在背景服務的有界記憶體；不保存或查閱過去 Run，服務重啟從空白開始。草稿只保留在當次 TUI。停止服務：`npm run daemon:stop`；只連線不自動啟動：`npm run tui -- --connect`。服務 log 在 `.workbench/daemon-4177.log`。詳見 [Run 生命週期與重啟限制](docs/run-lifecycle.md)。

可用 `WORKBENCH_PORT=4180 npm run tui` 選擇另一個 port；停止時使用同一個 `WORKBENCH_PORT`。TUI 不會替換已存在的服務；服務的程式碼若跟 TUI 不同（例如更新程式前就啟動），header 會顯示 `Server out of date · npm run daemon:stop`。先前的 M0 服務可連線，但若不支援 shutdown，仍需回原服務的 terminal 用 Ctrl+C 停止。前景 `npm run ui`／`npm run daemon` 的 Ctrl+C 也會清理其 Runs。

詳見 [TUI 操作與範圍](docs/tui-operation.md) 和 [鍵盤操作](docs/tui-keyboard.md)。

真實 Codex 的既有檔案登入、改檔／Diff、測試、一次性允許／拒絕與執行中取消已完成限定案例驗收。`npm run qa:loop` 會在一次性的範例專案上用真的 Codex 跑完整個 Task flow（Check → Agent Review → Human Review → accept），2026-10-27 一次就通過、Check 失敗後修正、review findings 修正三種情境都已通過（`-- --scenario fix-checks`／`fix-review`）。`-- --provider claude` 改由 Claude 開發、`-- --reviewer claude` 改由 Claude 審查（尚未實測）。可用 `npm run qa:codex -- --launch /absolute/path/to/local-config.json` 在可連線環境重跑；它使用真實模型操作內建小型測試專案副本，與 Fixture 選項不同。範圍與證據見 [真實 Codex 驗收](docs/codex-live-acceptance.md)。

已提供可選的 [Roadmap 追蹤](docs/roadmap-operation.md)：`:roadmap <title>` 建立計畫，`:spec <requirements>`／`:confirm` 確認需求，`o` 開啟小型 outline，`:track 2.1` 接續既有 Task，`:direct` 回一般 Run。瀏覽器從 Actions → Use Roadmap 操作。只保存專案計畫與需求版本，Run 對話與核准仍不存檔。確認後的 Task 會在 agent 回報 finished 時自動跑 Check、做 Agent Review，再進入 Human Review（[Task flow](docs/task-flow.md)）；agent 提案拆分 Task 尚待後續切片。

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

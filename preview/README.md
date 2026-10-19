# Agent Workbench 介面原型

需要操作實際 M0 fixture 時，在專案根目錄執行 `npm run ui`，開啟 `http://127.0.0.1:4177`。`runtime.html`／`runtime.js`／`runtime.css` 是新的測試台，呼叫既有 execution／attention，能測多 Run 核准、文字回覆、取消、diff 與紀錄；不連接真實模型。直接以檔案開啟 `runtime.html` 只會顯示啟動提示，必須經測試服務開啟才能操作。

以下的 `index.html` 仍是可離線開啟的多專案模擬原型；兩種資料分開呈現，可從「專案 p」展開後的連結切換。

操作 demo 已依最新參考精簡為 header、agents、timeline。沒有常駐側欄或回覆表單。p 展開專案來源及舊原型連結，s 展開測試操作，i 展開回覆，Esc 收起。進行中的核准自動出現，詳細資料可再展開。

`runtime.html` 仍是瀏覽器操作 Demo；React + Ink 終端入口已另以 `npm run tui` 實作，與同 port 瀏覽器共用 fixture runtime，詳見 [TUI 操作](../docs/tui-operation.md)。此 Demo 已加入 Vim 風格按鍵和命令欄；`?` 查看說明，`:` 輸入如 `new`、`use 2`、`inbox` 的畫面命令。測試專案與執行名稱已標示為內建範例，取消／中斷的執行預設收在歷史；Results 診斷頁已移除，必要資訊可在 Timeline 展開。

直接以瀏覽器開啟 `index.html`。macOS 可在專案根目錄執行：

```sh
open preview/index.html
```

不需要安裝套件或 build。檔案分成 `index.html`、`styles.css`、`app.js`、`services.js`，沒有 CDN、網路請求或 agent 連線。

左側顯示各專案的來源 repo 路徑、所屬 agents 與待處理數；詳情顯示所選 Run 的隔離路徑。手機版可展開 Projects 查看位置。

Services 分頁示範前後端與資料庫的全部啟動／停止、單項重啟、健康檢查、log 篩選與預覽網址。服務依所選 Run 隔離，停止依賴服務時連帶停止依賴者；`services.js` 封裝模擬狀態與啟停順序。`habit-log` 預設有一個失敗案例，會出現在待處理事項，重試後解除。服務狀態與 logs 只保留到本次頁面重載；一般選擇與核准決策可保存。鍵盤 `1–5` 切換詳情分頁。

可切換 agent、待辦篩選與 Live／Diff／Timeline／Results；也能模擬允許／拒絕、回答 PM 問題及輸入訊息。Results 彙整驗證命令、Review 結果與候選版本，未執行或示例狀態仍會明確標示。右上角可切換外觀與重設示例；瀏覽器允許時會在本機保存示例選擇。重設會取消尚未送達的模擬回覆。

所有專案、程式碼、事件與結果都是示例；不會執行畫面上的命令，也不會建立 PR。

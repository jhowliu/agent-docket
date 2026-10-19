# Agent 工作台

集中管理多專案的 agent 開發與交付，讓使用者能提出需求、處理人工決策、追蹤執行並理解程式碼變更。

## Language

**Project**：
一個被開發的專案及其驗收約定；可同時存在多個互不相依的 Project。
_Avoid_: 用工作台本身代稱所有被開發專案

**Task**：
具有明確範圍、驗收條件、依賴與交付目標的一份工作；可歷經多個階段與重試。
_Avoid_: 把 Task 與 agent、Session、Run 當成同義詞

**Task spec**：
Task 已定案的需求與驗收約定；修改後形成新版本，原有證據須重新評估適用性。
_Avoid_: 把整段對話直接視為 Task spec

**Role**：
執行工作的責任種類，包括 PM、Dev、Review、Verify 與 PR。
_Avoid_: 用 Python、Codex 或 Claude 作為 Role 名稱

**Profile**：
某個 Role 執行時採用的能力組合，包括技術專長、skills、plugins、工具與執行環境。
_Avoid_: 把 Profile 與 Role 或 provider 當成同義詞

**Run**：
某個 Role 的一次執行；一次失敗後的重試屬於新的 Run。
_Avoid_: 用 Session 代稱 Run

**StageRun**：
Task 在 Dev、Review、Verify 或 PR 階段的一次 Run；PM 的需求討論可獨立於這些階段存在。
_Avoid_: 把每次模型回覆當成一個 StageRun

**Session**：
某個 Run 內的一段 agent 對話；對話回合結束不代表 Run 或 Task 已通過驗收。
_Avoid_: 用 Task 或完成狀態代稱 Session

**Environment**：
某個 Run 專用的執行空間，包含程式副本、CLI home、工具、程序與網路；來源 repo 路徑與 Environment 中的工作路徑不同。
_Avoid_: 把使用者本機的來源 repo 直接視為 agent 可寫環境

**Service definition**：
專案的開發服務設定，包括命令、工作目錄、依賴、健康檢查與環境內 port；可套用到不同 Environment。
_Avoid_: 將可重用設定當成共用的可寫執行實體

**Service stack**：
在一個 Environment 中依 Service definition 啟動的一組前端、後端或資料庫實體；生命週期、logs 與預覽端點屬於該 Environment。
_Avoid_: 將所有 agent 的服務合併成專案唯一一組

**Candidate**：
一個可重建、可審查、可驗證的程式碼候選版本；版本改變後，證據與交付必須重新判斷適用性。
_Avoid_: 用持續變動的工作目錄代稱 Candidate

**Attention item**：
需要使用者核准、回答或做決策的具體事項，帶有等待原因及所屬工作；失效或已處理的事項不再屬於待處理清單。
_Avoid_: 把所有 pending 工具或未讀完成通知都稱為等待核准

**Artifact**：
執行或交付所產生、可追溯到相關工作的紀錄或內容，包括 diff、findings、驗證紀錄與報告。
_Avoid_: 把 Artifact 一律視為通過驗收的證明

**Evidence**：
能支持或反駁特定 Candidate 滿足 Task spec 的可追溯依據；未執行或不適用的檢查不能當成通過證據。
工作台以 Results 作為相關結果摘要的分頁名稱；服務健康就緒不等同功能驗證通過。
_Avoid_: 把 agent 的結論或推測直接視為 Evidence

**Delivery**：
針對特定 Candidate 組成的交付內容，包括 PR、變更說明、相關證據與 review comments；準備完成與已發佈是不同狀態。
_Avoid_: 用 agent 回合結束代稱 Delivery 完成

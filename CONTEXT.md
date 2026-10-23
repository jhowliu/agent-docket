# Agent 工作台

集中管理多專案的 agent 開發與交付，讓使用者能提出需求、處理人工決策、追蹤執行並理解程式碼變更。

## Language

**Project**：
一個被開發的專案及其驗收約定；可同時存在多個互不相依的 Project，同一 Git repository 的 linked worktrees 共用專案計畫的身分。
_Avoid_: 用工作台本身代稱所有被開發專案

**Roadmap**：
Project 的分階段交付計畫，描述各 Phase 的目標、依賴及完成條件。
_Avoid_: 把 Run 紀錄或 agent 對話清單稱為 Roadmap

**Phase**：
Roadmap 中以交付目標劃分的一段工作，包含相關 Task 與驗收條件；同一 Phase 的 Task 可處於不同 Stage。
_Avoid_: 把 Phase 與 Stage、Task 或一次 Run 當成同義詞

**Task**：
具有明確範圍、驗收條件、依賴與交付目標的一份工作；可歷經多個階段與重試。
_Avoid_: 把 Task 與 agent、Session、Run 當成同義詞

**Stage**：
Task 工作流程中的一個步驟，包括 Requirement clarification、Development、Agent Review、Human Review；目前工作位置與階段通過是不同概念。
_Avoid_: 用 Stage 代稱 Roadmap 的 Phase，或把畫面選取步驟視為階段已通過

**Direct mode**：
Run 不綁定 Task 的直接對話與執行方式；切回此模式不會刪除專案的計畫。
_Avoid_: 把 Direct mode 視為專案沒有 Roadmap，或視為取消 Run

**Roadmap mode**：
Run 與 Task 建立關聯，依該 Task 的 Stage 與所屬 Phase 追蹤工作；位置追蹤不代表審核通過或任務完成。
_Avoid_: 把模式套用到整個專案的所有 Run，或把讀取計畫視為恢復舊 Run

**Human Review**：
使用者針對特定 Task spec 與 Candidate 做的最終審查，可接受或提出修改要求。
_Avoid_: 把單次工具操作的允許／拒絕核准視為 Human Review 完成

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
Task 在某個 Stage 中由一個 Role 執行的一次 Run；同一 Stage 可包含多個 Role 的 Run 或重試。
_Avoid_: 把每次模型回覆當成一個 StageRun

**Session**：
某個 Run 內的一段 agent 對話；對話回合結束不代表 Run 或 Task 已通過驗收。
_Avoid_: 用 Task 或完成狀態代稱 Session

**Next action**：
使用者在某個 Run 上接下來要做的事（核准、回覆 agent 請求、登入、commit、處理 worktree、下指令），由目前 Run 與 attention 狀態推得；Project 的 Next action 是其中最急的一個。
_Avoid_: 把 Next action 當成 Stage、Task 進度、審查通過或任務完成

**Environment**：
某個 Run 專用的執行空間，包含程式工作目錄、CLI home、工具、程序與網路；工作目錄可由 Git worktree 提供，來源 repo 的工作路徑與 Environment 中的工作路徑不同。
_Avoid_: 把使用者本機的來源 repo 直接視為 agent 可寫環境

**Worktree**：
同一個 Git repository 的獨立工作目錄，擁有自己的檔案、index 與 HEAD，並共用 Git 物件與部分設定、refs；可在移除工作目錄後保留分支與 commit。
_Avoid_: 把 Worktree 視為 OS 安全隔離、Session 對話存檔或獨立 repository clone

**Agent preset**：
由工作台可信設定提供的 provider 與執行方式；新建 Session 可選 preset 的 ID，但不藉此改寫 executable、登入或儲存設定。
_Avoid_: 把 Agent preset 與 Role、Task 或專案位置當成同義詞

**Starting branch**：
新 Run 建立工作分支與 worktree 時採用的本機分支及其已選 commit；可來自先前保存的工作分支。
_Avoid_: 把選起始分支視為恢復舊 Session 對話，或直接切換來源 checkout

**Service definition**：
專案的開發服務設定，包括命令、工作目錄、依賴、健康檢查與環境內 port；可套用到不同 Environment。
_Avoid_: 將可重用設定當成共用的可寫執行實體

**Service stack**：
在一個 Environment 中依 Service definition 啟動的一組前端、後端或資料庫實體；生命週期、logs 與預覽端點屬於該 Environment。
_Avoid_: 將所有 agent 的服務合併成專案唯一一組

**Candidate**：
一個可重建、可審查、可驗證的程式碼候選版本；版本改變後，證據與交付必須重新判斷適用性。
_Avoid_: 用持續變動的工作目錄代稱 Candidate

**Check**：
專案層級、由使用者設定的一行 shell 指令，在 Candidate 的乾淨 checkout 上執行；以 exit code 判定結果，agent 不能設定或執行。
_Avoid_: 把 agent 自己跑過的測試或口頭回報當成 Check

**Verification**：
某個 Check 針對某個 Candidate（及當時追蹤的 Task spec revision）的一次執行與其判定；程式碼或規格改變後變成過期，不代表 Task 完成或審查通過。
_Avoid_: 把在持續變動的工作目錄上跑過的檢查稱為 Verification

**Attention item**：
需要使用者核准、回答或做決策的具體事項，帶有等待原因及所屬工作；失效或已處理的事項不再屬於待處理清單。
_Avoid_: 把所有 pending 工具或未讀完成通知都稱為等待核准

**Artifact**：
執行或交付所產生、可追溯到相關工作的紀錄或內容，包括 diff、findings、驗證紀錄與報告。
_Avoid_: 把 Artifact 一律視為通過驗收的證明

**Progress report**：
Agent 對所屬 Run 主動撰寫的簡短進度回報，每則最多 50 個以空白分隔的 words；內容可描述進展、發現、阻塞或下一步，不要求固定分類。
_Avoid_: 從一般對話第一行或工具完成狀態推定進度、核准、驗證通過或 Task 完成

**Evidence**：
能支持或反駁特定 Candidate 滿足 Task spec 的可追溯依據；未執行或不適用的檢查不能當成通過證據。
工作台以 Results 作為相關結果摘要的分頁名稱；服務健康就緒不等同功能驗證通過。
_Avoid_: 把 agent 的結論或推測直接視為 Evidence

**Delivery**：
針對特定 Candidate 組成的交付內容，包括 PR、變更說明、相關證據與 review comments；準備完成與已發佈是不同狀態。
_Avoid_: 用 agent 回合結束代稱 Delivery 完成

**Agent request**：
Agent 透過 `request_user` 明確提出、需要使用者在工作台外動手或回答的事項；跨回合保留，Run 結束即失效，標記完成不會通知 agent，也不代表結果已驗證。
_Avoid_: 從 agent 對話推測需要使用者做事，或把 Agent request 當成權限核准

**Change map**：
某個 Run 的工作目錄相對其 base 的變更導覽：從使用者操作經公開 Interface 到被修改函式的 flow、Interface 變更與逐函式 diff；flow 由靜態分析推得，可能不完整。
_Avoid_: 把 Change map 視為 review 結論、驗證通過或 Evidence

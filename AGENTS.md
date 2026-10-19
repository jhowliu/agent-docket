# 專案開發規則

開始工作先讀 `recap.md`、`CONTEXT.md` 與 `docs/implementation-plan.md`。有意義的工作完成前更新 `recap.md`；專案用語定案時同步更新 `CONTEXT.md`，其中只保存名詞定義。

**已選技術與範圍**

- All product interface copy, CLI help/errors and built-in fixture messages use English. Preserve user-authored text, provider output, paths and historical records in their original language.

- 第一版使用 TypeScript + Node.js；TUI 使用 React + Ink，PR 互動報告使用 TypeScript + React。
- ACP v1 串接既有 Codex／Claude adapters；實測 capabilities、登入與取消／恢復能力後再承諾行為。
- 2026-10-19 使用者明確要求先不 containerize：目前允許顯式 `transport: local` 的 Codex 模式，使用每 Run 的專案／home 副本，不能稱為 OS sandbox。Container 隔離記錄為後續工作；不因 container 失敗自動改為 local。操作與限制見 `docs/local-execution.md`。
- 當前有 HTML／CSS 多專案模擬原型，以及 M0 的 `execution`／`attention` TypeScript 切片、CLI 與 ACP fixture 測試。`npm run tui` 已提供 Ink 終端介面與自動啟動的本機背景服務；與同 port 瀏覽器共用 fixture Runs，退出 TUI 不停止 Run，服務重啟不恢復。`preview/index.html` 的多專案／Services 原型仍是模擬。兩家真實 provider、container／network 隔離與登入尚待實測。詳見 `docs/tui-operation.md`、`docs/m0-operation.md` 與能力矩陣，再按計畫切片增加功能。

**Domain 與 deep Modules**

- 依 `work`、`execution`、`attention`、`evidence`、`delivery` 區分業務責任，具體擁有的規則見開發計畫。這些是同一產品內的 Modules，不要求獨立部署。
- 每個 Module 以 `index.ts` 提供公開 Interface，其餘 Implementation 留在 `internal/`。跨 domain 只透過公開 Interface；禁止匯入另一 Module 的內部檔案、資料表或 adapter。
- Interface 包含正確使用 Module 所需的不變條件、順序、錯誤、設定與效能限制。追求小且完整的 Interface，將完整行為、失敗處理與複雜規則封裝在其 Implementation。
- 不以檔案長度、class 數量、函式數量衡量 Depth。若呼叫者仍要協調多個低階步驟、辨識 provider 差異或自行清理程序，應將這些責任收回適當 Module。
- Domain Module 持有自己的規則、儲存存取與錯誤轉換；避免將業務知識散布在全域 `services/`、`repositories/`、`controllers/` 或 `utils/`。
- `app` 只負責入口、依賴組裝與傳輸轉接。TUI／Web 不持有工作流、核准有效性或證據通過規則。
- `work` 協調任務流程；`execution` 管單次 Run；`attention` 管人工決策；`evidence` 管證據適用性；`delivery` 管交付。避免循環依賴。
- 只在確實變動之處建立 Seam。Codex／Claude 是已存在的 adapters；不為尚未需要的資料庫、sandbox 或框架預先增加抽象層。
- 按里程碑建立目錄；不用空 Module 或通用框架填滿預想中的架構。

**資料、狀態與驗證**

- 使用 strict TypeScript 與明確的狀態 union。對 provider、網路、設定及模型產出的資料做執行期驗證；不要以 `any` 或未驗證的型別斷言掩蓋未知輸入。
- ACP request ID、連線世代、原始 option ID 與程序 handle 留在 `execution` 的 Implementation。`attention` 與 UI 使用 domain 的決策資料；回覆前由 `execution` 確認來源請求仍有效並精確映射。
- 區分「已接受回覆」「已送達 agent」「已失效」。重複操作與重繪不觸發重複外部副作用。
- 區分回合結束、Run 結束、階段通過與 Task 完成；歷史紀錄重播不代表活躍 Session 已恢復。
- Evidence 綁定 Task spec 版本與 Candidate SHA，程式碼或規格改變後重新判斷。Review／Verify 使用獨立 context 與執行環境，未驗證不標為通過。
- 長期隔離模式中，Agent、工具、瀏覽器、檔案／terminal callback 均在對應環境執行。目前使用者已授權先做本機模式：啟動工作目錄與設定使用每 Run 副本，來源 repo 不直接作為 agent cwd；仍共享本機 OS 權限，不承諾安全隔離。檔案／terminal callback 尚不宣告；不為串接而直接開放全域設定。

**交付檢查**

- 測試與呼叫者使用相同的公開 Interface，優先驗證可觀察行為、不變條件與失敗路徑；不為 private 函式逐一鏡像撰寫測試。
- 核准競態、取消、失效請求、恢復、版本變更與證據失效需要有意義的測試。真實 provider 整合另行實測，不能只用假資料宣稱支援。
- 每個切片記錄改變的行為、所屬 Module、Interface 影響、驗證結果與缺口。首次實作附模組地圖與啟動／除錯說明。

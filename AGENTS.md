# 專案開發規則

開始工作先讀 `recap.md`、`CONTEXT.md` 與 `docs/implementation-plan.md`。有意義的工作完成前更新 `recap.md`；專案用語定案時同步更新 `CONTEXT.md`，其中只保存名詞定義。

**已選技術與範圍**

- All product interface copy, CLI help/errors and built-in fixture messages use English. Preserve user-authored text, provider output, paths and historical records in their original language.

- 2026-10-24 user removed the TUI Files panel (the former Project tree) as unused: no panel, `p` browsing or `Ctrl+W` focus prefix. `execution.listDirectory` (read-only, bounded directory metadata for fixture/local Runs; UI never chooses an arbitrary absolute root) and `/api/directory` / `client.directory` remain, tested, without a UI caller. This is separate from ACP client filesystem callbacks, which remain unsupported. Run/provider/working path belong in the bottom status bar. See `docs/project-tree.md`.

- 2026-10-21 New Session now selects a Git project and starting local branch in a small form. The standard server offers explicit Codex local / Fixture presets without a project environment variable; adapter/auth/storage settings stay trusted. `execution.inspectLocalProject` owns source/branch validation; `work.createProjectWorkspaces` owns per-project plans and process-local Run association/context routing. Switching Runs selects its path/Roadmap; New Session starts in the selected Run's project folder (fixture Runs and no selection keep the launch folder). No history or conversation restoration. See `docs/session-creation.md`.

- 2026-10-21 TUI project-path Tab completion uses a compact, width-adaptive `ls`-style folder grid before a Run exists. `execution.listProjectFolders` owns bounded one-level source metadata; it is distinct from Run-scoped Project tree reads. Native blue folders, magenta directory links and cyan inverse selection retain `/`, `@/`, `>` text cues. Arrows move between candidates and Tab advances; Shift+Tab focuses Agent, arrows choose and Tab returns to input. Do not reuse path Tab to switch providers.

- 2026-10-22 New Session offers explicit Git initialization for a non-Git folder, or an initial commit for an empty repository. No/Esc remains read-only. Yes snapshots current non-ignored files locally before the normal branch chooser; `execution.initializeLocalProject` owns identity/state rechecks, locking and commit behavior. No implicit initialization, Run creation or retry after a lost reply. Missing Git identity uses a per-initial-commit Workbench identity; global settings/signing policy stay intact. See `docs/session-creation.md`.

- 2026-10-22 agents explicitly ask the person to act or answer with the Run-private `request_user` tool (beside `report_progress`). `attention` owns these agent requests: they outlive a turn, expire with the Run, take no provider choice and are never sent back to the agent; `y` marks done, a reply is an ordinary prompt. Timeline never infers requests from chat. See `docs/agent-progress.md`.
- 2026-10-24 turn outcomes: the agent declares how a turn ends (`request_user` action → blocked, question → question, `report_progress` with `finished: true` → finished, the agent's claim and never verification); the TUI shows it in the roster and a Timeline result row, never classifying chat. Done does not reply: a done request keeps the Run blocked until the next prompt. A turn that declared nothing shows its reply's last paragraph verbatim (replacing `replied · 1 Live`). Blocked is not failed. One meaning per color: yellow you act, red broke, green reported finished/passed, blue working, magenta new, cyan focus/narration, gray quiet. App derivation lives in `tui-outcome.ts`. See `docs/turn-outcomes.md`.

- 2026-10-24 reading replies: every turn result row that replied ends with `Space reply · N lines` and shows the reply's last paragraph under any outcome; `Space` opens that turn's reply over the right pane (not side by side, no mouse clicks), scrolled by ↑/↓, `Ctrl+U/D`, `PgUp/PgDn`, `g/G` and closed by `Esc`/`Space`, any other key closing it and acting. ↑/↓ (and the mouse wheel via alternate scroll `CSI ?1007h`) move within the pane: Timeline rows, Live/Diff lines; only `j/k` move between Runs. The view reports the scroll it shows so keys never overshoot an end. Finished summaries for questions should carry the answer. Live and the reply render the agent's Markdown (`tui-markdown.ts`, no dependency; underscores are not emphasis; tables align or go row by row); the journal keeps raw text. App-only, see `docs/turn-outcomes.md`.

- 2026-10-22 user prioritized a Change map before Candidate evidence. `delivery.describeChange` owns a read-only map of a Run worktree against its base: files/declarations, `src/<module>/index.ts` Interface changes and statically traced flows (key → HTTP route → module Interface → changed functions). The service resolves the checkout from execution's Run record; TUI `m` / `:map` opens `/changes?run=…`; for worktree Runs the Diff tab shows the same Git diff without analysis instead of only agent-reported edits. Flows are not review, verification or Evidence; heuristics are tuned to this codebase and TypeScript only. See `docs/change-map.md`.

- 2026-10-23 user approved a project-grouped TUI roster. `work.ProjectWorkspaces.overview()` owns Next action ranking from current Run/attention state: Runs that ask something of the person (approve, respond, sign-in, commit, worktree) rise in that order, others keep launch order so turns do not reshuffle the list; each project names its most urgent Run. `startSession` owns inspect → register → launch → associate; app keeps presets and Run bounds. TUI only renders the overview, older daemons keep the flat list, browser unchanged. Next actions are guidance, never review or completion. See `docs/project-overview.md`.

- 2026-10-23 Candidate + Verify: `v` freezes a worktree Run into a Candidate (`refs/workbench/candidates/<run>`, worktree/index/branch untouched) and runs the project's `:check` command on a clean temporary checkout; machine-only, no agent session. `execution` owns Git/process steps and content measurement, `evidence` owns applicability (Candidate tree vs current tree, Task spec revision), `work` coordinates and persists check commands. Results are passed/failed/stale/unconfirmed, in daemon memory; never Task acceptance. See `docs/verification.md`.

- 2026-10-23 user picked herdr-inspired TUI items: per-client Unread Runs (idle after a turn this TUI has not shown), one-column state glyphs beside the existing labels with a project-header rollup (herdr's `◉ ✕ ● ○` since 2026-10-24), background notices in the header beside the left column, or beside the roster title when narrower (1 s delay, dropped if handled, 8 s, hidden once selected), `w` reaching unread Runs after waiting ones, and opt-in `WORKBENCH_NOTIFY=bell|osc9`. App-only (`tui-notices.ts`); seen state is never stored and never changes next-action ranking. See `docs/background-notices.md`.
- 2026-10-23 TUI layout: at 80+ columns the left column (30% of the width, 32–44 cells) holds the agents above the Workflow at its bottom, in herdr's style since 2026-10-24 (unframed lowercase `spaces` / `agents` sections, two-line rows, a subtle background on the selected Run; since 2026-10-25 agents sit under a `project ───` label when more than one project has Runs, their second line `state · provider`); the selected Run fills the right, its title sharing the tabs' row so both frames start on one line. Tracked Workflow stages expand when every Run keeps its two lines, an open Roadmap takes half; left rows use short lowercase state words (`approve (1)`, `respond (1)`, `sign in`, `commit`, `worktree`), the right title spells them out. Enter (like `i`) opens the selected Run's reply line, framed by rules; below 80 the roster stays stacked. New Session is a centered modal in front of the dimmed workspace (`tui-text.tsx` `Backdrop`); reply and `:` input stay at the bottom.

- 2026-10-21 real local Codex acceptance passed one copied file-login workflow: project reading/progress, sample edits/Diff/tests, once-only allow/reject and cancellation of an observed active process. `npm run qa:codex -- --launch <local-config>` deliberately uses disposable sample source and real model access; ordinary `npm test` stays deterministic. Local Git discovery stops at the Run directory. Other authentication flows, physical-terminal acceptance, Claude and OS isolation remain unverified. See `docs/codex-live-acceptance.md`.

- 2026-10-20 已有 `work` 的可選 Roadmap 追蹤切片：保存專案計畫與需求版本，Run 關聯只留在目前程序；TUI／Web 保留原工作區並按需顯示小型 Stepper／Roadmap。工作位置不是審核通過，獨立 Review／checks、Candidate-bound 驗收及 agent 提案 tool 仍待實作。詳見 `docs/roadmap-operation.md`。

- 第一版使用 TypeScript + Node.js；TUI 使用 React + Ink，PR 互動報告使用 TypeScript + React。
- ACP v1 串接既有 Codex／Claude adapters；實測 capabilities、登入與取消／恢復能力後再承諾行為。
- 2026-10-19 使用者明確要求先不 containerize：目前允許顯式 `transport: local` 的 Codex 模式。2026-10-21 使用者要求本機 Git 專案改用每 Run 的 worktree／分支與 private home；停止後清理乾淨 worktree，有修改則提醒 commit，保存至本機分支後再清理，不自動 push／merge／刪分支。不新增 worktree 數量設定，不能稱為 OS sandbox。Container 隔離記錄為後續工作；不因 container 失敗自動改為 local。操作與限制見 `docs/local-execution.md`、`docs/worktrees.md`。
- 當前有 HTML／CSS 多專案模擬原型，以及 M0 的 `execution`／`attention` TypeScript 切片、CLI 與 ACP fixture 測試。`npm run tui` 已提供 Ink 終端介面與自動啟動的本機背景服務；與同 port 瀏覽器共用 Runs，退出 TUI 不停止 Run。2026-10-20 使用者明確取消 History：Run／事件／核准只保留在本次 daemon 的有界記憶體，不保存或載入過去 Run；程序重啟從空白開始，不恢復 Session 或舊核准，崩潰後環境清理仍未對帳。詳見 `docs/run-lifecycle.md`。`preview/index.html` 的多專案／Services 原型仍是模擬。Codex 基本本機流程已有前述限定驗收；Claude、其他登入方式及 container／network 隔離仍待實測。詳見 `docs/tui-operation.md`、`docs/m0-operation.md` 與能力矩陣，再按計畫切片增加功能。

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
- 長期隔離模式中，Agent、工具、瀏覽器、檔案／terminal callback 均在對應環境執行。目前使用者已授權先做本機模式：本機 Git 專案以每 Run worktree 作為工作目錄並使用 private CLI home；來源 checkout 不直接作為 agent cwd，Git repository 資料共用，仍共享本機 OS 權限，不承諾安全隔離。檔案／terminal callback 尚不宣告；不為串接而直接開放全域設定。

**交付檢查**

- 測試與呼叫者使用相同的公開 Interface，優先驗證可觀察行為、不變條件與失敗路徑；不為 private 函式逐一鏡像撰寫測試。
- 核准競態、取消、失效請求、恢復、版本變更與證據失效需要有意義的測試。真實 provider 整合另行實測，不能只用假資料宣稱支援。
- 每個切片記錄改變的行為、所屬 Module、Interface 影響、驗證結果與缺口。首次實作附模組地圖與啟動／除錯說明。

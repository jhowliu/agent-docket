# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

此處的 web 指介面預覽與 PR 報告；正式日常操作介面是 terminal TUI。

## Stack

使用者已選 TypeScript + Node.js；TUI 使用 React + Ink，PR 報告使用 React。目前有對話內設計預覽，以及 `preview/index.html` 的獨立 HTML + CSS + JavaScript 原型；後者不需安裝套件或 build。

## Users

同時開發多個專案、混用 Codex 與 Claude Code 的個人開發者。

## Product Purpose

集中看見誰需要核准或回答，直接處理人工決策，追蹤各 agent 的執行，並理解開發到 PR 的變更與驗證依據。

## Operating Context

已實作可選的 Roadmap 計畫追蹤，以 Task stepper 呈現 Requirement clarification → Development → Agent Review → Human Review 的工作位置。同一 Phase 可有多個 Task；計畫、需求版本與位置保存於專案計畫檔，Run 關聯只留在目前程序。獨立審核、Candidate 證據、人工驗收與自動交接仍待後續切片；過去 Run 的對話／事件不自動存檔。

Roadmap 與 Stepper 是選取 Run 後的輔助資訊。保留原本工作區風格，agents 清單及 Live／Diff／Timeline 繼續佔主要空間。Web Stepper 使用緊湊單列；TUI 在 80 欄以上使用右側小型 Workflow 欄，直向顯示步驟，`o` 在同一欄展開 Roadmap，避免流程數字與內容分頁混淆。60–79 欄保留完整輸出寬度，按需展開小視窗。一般 Run 隱藏這些資訊；使用者可手動綁定 Task 或回 Direct。Agent 透過 tool 建議採用 Roadmap 的行為仍屬後續提案。

使用者與 PM 討論需求，之後由獨立階段完成 Dev、Review、Verify、PR；各角色可套用自己的技術 profile、skills 與 plugins。

TUI 右側 Workflow 上方提供實際 folder structure，可展開目前 Run 工作目錄內的資料夾與檔案。按 `p` 瀏覽、`[`／`]` 選取、Enter 展開／收合、`R` 重新整理。底部狀態列顯示 Run、provider 與工作路徑，切換 Run 時同步更新。Direct 模式保留檔案樹，窄終端按需展開。

左側依專案顯示來源 repo 位置與所屬 agents；各 Run 顯示自己的隔離工作路徑。Services 集中呈現前後端／資料庫的啟停、健康狀態與 logs，服務故障也進入待處理事項。專案可共用服務定義，實際執行實體各自隔離。

## Capabilities and Constraints

完整工作台尚未完成。M0 已有 TypeScript ACP client、核准通道、Run timeline、worker 啟動入口及可信 fixture 測試；真實兩家 provider、隔離與登入仍需實測。HTML 預覽尚未接到 runtime，其中的專案、事件與結果均為示例，操作不會送到 agent、啟動服務或建立 PR。

另有 `npm run ui` 的瀏覽器測試台，使用相同 domain 的公開 Interface 實際操作可信 ACP fixture 程序，可測多 Run 核准、文字問答、取消、diff 與紀錄。它與多專案模擬原型是不同入口，不連接模型，也不取代後續 Ink 介面的技術選擇。

瀏覽器 demo 先驗證 Vim 風格導覽、回覆與核准。操作 demo 只顯示進行中的測試或待核准項目；2026-10-20 使用者取消 History，不再保存或查閱過去的 Run。使用者不需要 Results 協定診斷頁，必要診斷以 Timeline 的技術細節提供。

新的 oat-agents 畫面參考要求盡量簡潔：操作 demo 常駐內容收斂為狀態列、agents、timeline。來源、測試操作與回覆皆按需展開，核准只在等待決策時出現；維持鍵盤導覽。

使用者已要求進入下一階段。`npm run tui` 現已實作 React + Ink 終端介面，延續精簡布局並共用本機 fixture server。TUI 可自動啟動背景程序；退出畫面後 Run 仍在，重新連線取得目前快照。Run／事件／核准僅留於本次程序的有界記憶體，背景程序重啟從空白開始。這只是 M1 第一個切片：尚無真實模型完整驗收、多專案／Services 管理或完整階段工作流。來源與能力限制見 `docs/tui-operation.md`。

HTML Services 僅是本機記憶體模擬，重新載入會回到示例服務狀態。真實服務程序、健康監控與預覽代理尚未實作；能力以 `docs/m0-capability-matrix.md` 的實測記錄為準。

## Brand Commitments

The user requested an English-only interface. TUI, CLI, browser demo, sample prototype and new built-in fixture messages use English. User-entered text, provider output, paths and historical logs retain their original language.

使用者指定 Noopher-AI/oat-agents 為版面與外觀參考：https://github.com/Noopher-AI/oat-agents 。參考其 agent roster、細框線、終端密度與詳情分頁；本產品仍在自己的工作台內處理核准與回覆。

## Evidence on Hand

`docs/implementation-plan.md`、`CONTEXT.md`、`AGENTS.md` 記錄已討論需求與規則。`preview/` 提供可直接開啟的工作台原型，已檢查示例互動與桌機／手機排版。PR 解說預覽與工作台均使用示例內容；沒有真實 agent 連線、程式驗證結果、效能或使用者數據。

## Product Principles

- 優先呈現需使用者採取行動的工作。
- Task、Run、Session 與完成／通過狀態清楚區分。
- Review 與 Verify 的證據綁定候選版本。
- 依 domain 設計 deep Modules，讓介面與業務規則分離。

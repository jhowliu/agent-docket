# 鍵盤操作

`npm run tui` 是 React + Ink 終端入口，與同 port 的瀏覽器共用 Runs。按 `n` 在 [New Session](session-creation.md) 選專案與起始分支，或選 Fixture 測試；`WORKBENCH_LAUNCH` 只需用於自訂可信執行設定。現有 `npm run dev -- fixture` 仍是獨立文字命令 CLI，兩者都不是完整 Vim 編輯器。

## Ink TUI

| 模式／按鍵                          | 操作                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| 工作區：`j/k`、↑ / ↓                | 依畫面上的專案分組順序選下一個／上一個可見 Run                                   |
| 工作區：`h/l`、← / →、`1–3`         | 切換 Live／Diff／Timeline                                                        |
| `Ctrl+w` 後 `h/l` 或 `w`            | 聚焦工作區／Project，或切換兩者；保留資料夾展開與選取                            |
| `n` / `i`                           | 開啟 New Session 選專案、分支／在 idle Run 輸入文字                              |
| `p` / `s` / `?`                     | 瀏覽 Project 檔案樹／操作／說明                                                  |
| Project：`j/k`、↑ / ↓、`[` / `]`    | 上下選取項目；略過狀態提示                                                       |
| Project：`h/l`、← / →               | 收合／展開資料夾；已收合時回父層、已展開時進入子項                               |
| Project：`g/G`、Home/End、PgUp/PgDn | 首／末項；上下移動多個項目                                                       |
| `o`                                 | 右側 Workflow 欄切換 Roadmap；窄視窗開關小視窗                                   |
| Project 中 `Enter` / `R`            | 展開／收合資料夾；重新整理檔案樹                                                 |
| outline 中 `[` / `]`                | 瀏覽上一個／下一個 Phase；不推進進度                                             |
| outline 中 `{` / `}`                | 捲動 Task 清單                                                                   |
| `a` / `r`                           | 回答畫面聚焦的核准：允許一次／拒絕一次                                           |
| `y`                                 | 將選取的 agent request（Needs you）標為完成；不會通知 agent，需要時用 `i` 回覆   |
| `Tab` / `Shift+Tab`                 | 選定同 Run 的下一筆／上一筆待處理核准                                            |
| `w` / `d`                           | 跳到等待核准的 Run／展開核准細節與選項                                           |
| `PgUp/PgDn`、`g/G`                  | 詳情捲動、頂端／末端；離開末端後暫停追蹤                                         |
| `x`                                 | 停止 Run 並檢查 worktree；乾淨則回收，有修改則提醒 commit；停止後可再次檢查      |
| `c` / `:commit <message>`           | 停止的 worktree：輸入訊息後 commit 全部非 ignored 修改至本機分支，再回收工作目錄 |
| `m` / `:map`                        | 在瀏覽器開啟所選 Run 的 [Change map](change-map.md)；footer 同時顯示網址         |
| `:`                                 | 開啟白名單命令欄                                                                 |
| 輸入中 `Enter` / `Esc`              | 送出／收起並保留草稿                                                             |
| 導覽中 `Esc`                        | 收起 Project、操作與說明，回工作區焦點                                           |
| `q` / Ctrl+C                        | 只離開 TUI，背景 Run 繼續                                                        |

路徑、操作、說明與核准細節一次只展開一組，新要求的資訊會取代上一組。每個 Run 有自己的草稿，送出後沒有繼續改字才會清空／收起；草稿不跨 TUI 退出保存。輸入中的 jkar 都是文字；左右、Home／End、Backspace／Delete、Ctrl+A／E／U 可編輯，刪除以完整 grapheme 為單位。超過 1000 字元的輸入不接受，換行貼上轉成空格。

Bracketed paste 使用獨立通道，導覽模式貼上 a／:cancel 不觸發動作。除導覽模式的 `Ctrl+w` 焦點前綴外，Ctrl／Alt／Command 組合不觸發導覽；kitty terminal 的 repeat／release 不執行 mutation。一般 terminal 沒有 key-up，因此相同 mutation key 連按會鎖住，需先換選或做另一個明確操作。每次回答後，即使下一筆核准補上，也要 Tab／換選 Run 明確選定再答。a/r 沒有對應一次性選項時不會推定其他選項；d 可看原本選項，再用 `:answer N` 明確指定。Tab 從 Project 回工作區選核准，不用來切換面板。輸入文字時不啟用焦點切換。

命令：`new`、`use 2`（目前可見清單的編號）、`active`、`inbox`、`live`、`diff`、`timeline`、`prompt fix`、`answer 1`、`cancel`、`commit <message>`、`help`、`quit`。`g/G` 只捲動目前保留的事件視窗。這些都是工作台操作，不執行 shell。Fixture 情境包含 `fix`、`question`、`reply:名稱`、`wait`、`two-permissions`、`crash`。啟動與限制見 [TUI 操作](tui-operation.md)、[Run 生命週期](run-lifecycle.md)。

本機 Codex 需要登入時，`s` 顯示 agent 廣告的登入方法；在命令欄輸入 `auth <method-id>`。取消會停止本機管理的程序群組並清理暫存 home；Git worktree 依[保存與回收規則](worktrees.md)處理，本機模式沒有 OS 安全隔離。

Roadmap 命令：`:roadmap <title>`、`:phase <title>`、`:task <phase> <title>`、`:track <phase>.<task>`、`:focus <phase>`、`:spec <text>`、`:confirm`、`:stage <stage>`、`:direct`。支援的 stage ID 為 `clarification`、`development`、`agent-review`、`human-review`；設定工作位置不等於階段通過。詳見 [Roadmap 操作](roadmap-operation.md)。

New Session 內：`Shift+Tab` 聚焦 Agent，以方向鍵選 preset，`Tab` 回路徑／分支欄。路徑欄 `Tab` 補全／列資料夾，候選依寬度排成多欄、每欄由上往下排序；方向鍵跨格移動，`Tab` 選下一項，超出畫面自動切頁，`Enter` 填入完整路徑。長名稱以 `…` 縮短顯示。先 `Esc` 收候選，再 `Esc` 關表單。藍色 `/` 是資料夾，紫色 `@/` 是資料夾連結，青色反白 `>` 是目前選取。收起清單後，左右鍵恢復文字游標操作。沒有候選清單時，路徑欄 `Enter` 讀分支；分支欄輸入文字篩選、`↑/↓` 選取、`Enter` 建立；`Ctrl+B` 回路徑，`Esc` 取消。此時不啟用工作區導覽或核准快捷鍵。

選到沒有 Git／尚無 commit 的資料夾時，會在表單內確認是否初始化並建立第一個本機 commit。預設 No；方向鍵／Tab 換選，Enter 確認，或直接按 `y`。`n`／Esc 回路徑欄，不寫入。貼上或 repeat key 不會確認。Yes 成功後回正常分支選擇；第一個 snapshot 含未被忽略的現有檔案，遵守既有 `.gitignore`。

## 瀏覽器 Demo

`npm run ui` 的操作 demo 已可試用下列按鍵，沒有完整實作 Vim 編輯器。

| 模式／按鍵         | 操作                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| 導覽：`j` / `k`    | 選下一個／上一個可見執行                                              |
| `h` / `l`、`1`–`3` | 切換 Live／Diff／Timeline                                             |
| `n`                | 開啟 New Session 選專案、分支或 Fixture                               |
| `i`                | 展開所選 agent 的文字回覆欄                                           |
| `p` / `s`          | 展開／收起專案來源與執行操作                                          |
| `o`                | 開關所選 Task 的小型 Roadmap；一般 Run 開啟手動設定                   |
| `a` / `r`          | 允許一次／拒絕；優先回答 Tab 焦點所在的核准，否則回答所選執行的第一筆 |
| `w`                | 跳到下一個需要核准的執行                                              |
| `:`                | 開啟命令輸入欄                                                        |
| `?`                | 展開／收起快捷鍵說明                                                  |
| 輸入中：`Enter`    | 送出文字或命令                                                        |
| `Esc`              | 保留回覆草稿，離開輸入模式；導覽中收起說明                            |

輸入文字、中文組字或按住 Ctrl／Alt／Command 時，不觸發導覽或核准。長按 `a`／`r`／`n` 不會自動重複操作。`a` 不替使用者選擇永久允許；沒有對應一次性選項時，仍須使用 agent 提供的實際選項。

命令欄支援 `new`、`use 2`、`active`、`inbox`、`live`、`diff`、`timeline`、`cancel`、`help`。閒置測試可輸入 `fix`、`question`、`wait`、`permissions`、`crash`，觸發固定情境。這是畫面操作的白名單，不會執行 shell 命令。

精簡版預設只顯示 agents 與 timeline。回覆欄按 i 才展開，Esc 收起並保留草稿；成功送出且未繼續修改的草稿也會收起。路徑、測試情境和說明均按需展開。

兩個介面經共用 server 串接既有 execution／attention 公開 Interface；權限有效性、重複回覆與清理仍由 domain 管理。暫存 fixture 測試不代表真實 Codex／Claude、遠端隔離或跨重啟恢復已完成。

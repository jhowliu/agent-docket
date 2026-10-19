# 鍵盤操作

`npm run tui` 是 React + Ink 終端入口，與同 port 的瀏覽器共用 Runs。預設 fixture；可用 `WORKBENCH_LAUNCH` 選擇 [本機 Codex 模式](local-execution.md)。現有 `npm run dev -- fixture` 仍是獨立文字命令 CLI，兩者都不是完整 Vim 編輯器。

## Ink TUI

| 模式／按鍵             | 操作                                     |
| ---------------------- | ---------------------------------------- |
| 導覽：`j/k`、↑ / ↓     | 選下一個／上一個可見 Run                 |
| `h/l`、← / →、`1–3`    | 切換 Live／Diff／Timeline                |
| `n` / `i`              | 新增已設定類型的 Run／在 idle Run 輸入文字 |
| `p` / `s` / `?`        | 展開路徑／操作／說明                     |
| `a` / `r`              | 回答畫面聚焦的核准：允許一次／拒絕一次   |
| `Tab` / `Shift+Tab`    | 選定同 Run 的下一筆／上一筆待處理核准    |
| `w` / `d`              | 跳到等待核准的 Run／展開核准細節與選項   |
| `PgUp/PgDn`、`g/G`     | 詳情捲動、頂端／末端；離開末端後暫停追蹤 |
| `x`                    | 取消整個所選 Run，讓舊核准失效           |
| `:`                    | 開啟白名單命令欄                         |
| 輸入中 `Enter` / `Esc` | 送出／收起並保留草稿                     |
| 導覽中 `Esc`           | 收起路徑、操作與說明                     |
| `q` / Ctrl+C           | 只離開 TUI，背景 Run 繼續                |

路徑、操作、說明與核准細節一次只展開一組，新要求的資訊會取代上一組。每個 Run 有自己的草稿，送出後沒有繼續改字才會清空／收起；草稿不跨 TUI 退出保存。輸入中的 jkar 都是文字；左右、Home／End、Backspace／Delete、Ctrl+A／E／U 可編輯，刪除以完整 grapheme 為單位。超過 1000 字元的輸入不接受，換行貼上轉成空格。

Bracketed paste 使用獨立通道，導覽模式貼上 a／:cancel 不觸發動作。Ctrl／Alt／Command 組合不觸發導覽；kitty terminal 的 repeat／release 不執行 mutation。一般 terminal 沒有 key-up，因此相同 mutation key 連按會鎖住，需先換選或做另一個明確操作。每次回答後，即使下一筆核准補上，也要 Tab／換選 Run 明確選定再答。a/r 沒有對應一次性選項時不會推定其他選項；d 可看原本選項，再用 `:answer N` 明確指定。

命令：`new`、`use 2`（目前可見清單的編號）、`active`、`inbox`、`history`、`live`、`diff`、`timeline`、`prompt fix`、`answer 1`、`cancel`、`help`、`quit`。這些都是工作台操作，不執行 shell。Fixture 情境包含 `fix`、`question`、`reply:名稱`、`wait`、`two-permissions`、`crash`。啟動與限制見 [TUI 操作](tui-operation.md)。

本機 Codex 需要登入時，`s` 顯示 agent 廣告的登入方法；在命令欄輸入 `auth <method-id>`。取消會停止本機管理的程序群組並清理暫存 home，程式副本保留在 `p` 顯示的路徑。本機模式沒有 OS 安全隔離。

## 瀏覽器 Demo

`npm run ui` 的操作 demo 已可試用下列按鍵，沒有完整實作 Vim 編輯器。

| 模式／按鍵         | 操作                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| 導覽：`j` / `k`    | 選下一個／上一個可見執行                                              |
| `h` / `l`、`1`–`3` | 切換 Live／Diff／Timeline                                             |
| `n`                | 新增內建測試執行                                                      |
| `i`                | 展開所選 agent 的文字回覆欄                                           |
| `p` / `s`          | 展開／收起專案來源與執行操作                                          |
| `a` / `r`          | 允許一次／拒絕；優先回答 Tab 焦點所在的核准，否則回答所選執行的第一筆 |
| `w`                | 跳到下一個需要核准的執行                                              |
| `:`                | 開啟命令輸入欄                                                        |
| `?`                | 展開／收起快捷鍵說明                                                  |
| 輸入中：`Enter`    | 送出文字或命令                                                        |
| `Esc`              | 保留回覆草稿，離開輸入模式；導覽中收起說明                            |

輸入文字、中文組字或按住 Ctrl／Alt／Command 時，不觸發導覽或核准。長按 `a`／`r`／`n` 不會自動重複操作。`a` 不替使用者選擇永久允許；沒有對應一次性選項時，仍須使用 agent 提供的實際選項。

命令欄支援 `new`、`use 2`、`active`、`inbox`、`history`、`live`、`diff`、`timeline`、`cancel`、`help`。閒置測試可輸入 `fix`、`question`、`wait`、`permissions`、`crash`，觸發固定情境。這是畫面操作的白名單，不會執行 shell 命令。

精簡版預設只顯示 agents 與 timeline。回覆欄按 i 才展開，Esc 收起並保留草稿；成功送出且未繼續修改的草稿也會收起。路徑、測試情境和說明均按需展開。

兩個介面經共用 server 串接既有 execution／attention 公開 Interface；權限有效性、重複回覆與清理仍由 domain 管理。暫存 fixture 測試不代表真實 Codex／Claude、遠端隔離或跨重啟恢復已完成。

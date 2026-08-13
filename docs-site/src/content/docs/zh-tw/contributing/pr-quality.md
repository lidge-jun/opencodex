---
title: Pull request 品質合約
description: OpenCodex pull request 的審查就緒門檻、貢獻者責任、信任通道與關閉政策。
---

## 你不需要先取得許可才能修東西

針對你實際遇到的 bug 提出的非計畫 pull request 是受歡迎的。這個專案有幾個很好的修正正是這樣誕生的——路由模型在工具呼叫後卡住、供應商送出錯誤的模型參數、圖片從工具結果中被扁平化（flattened）。這些都不是從規劃討論開始的；如果 gate 要求先有規劃討論，這些修正全都會消失。

先開 issue 對較大型或偏設計的工作確實有幫助，事先就方法達成共識，可以避免你蓋出錯誤的東西。那是建議，不是提交門檻。

## 一個就緒的 pull request 代表什麼

把 PR 標記為可審查，代表這個變更是完整、已理解、且已測試的。開啟它並不代表把分支的責任轉移給維護者。

作者預期要理解每一行變更、為任何驗證聲明指名確切的指令與結果、為行為變更補上聚焦的回歸測試，並保持在場處理 CI 與 review 的回饋。維護者負責找出問題；他們不負責修補貢獻者的分支、補寫缺失的測試，或把自動化發現轉成你的 patch。

沒有指名指令與結果的「有測試」或「CI 通過」不是證據。

## 自動化 gate

有三個決定性的檢查會在人工作業之前執行，每個失敗訊息都會確切告訴你該改什麼：

- **PR 品質（`enforce-target`）。** Pull request 必須以 `dev` 為目標，並帶有真正的描述：變更內容與原因的 **Summary**，加上 **Test plan**（或同等實質內容）。當 diff 更動 `gui/` 下的檔案，或 GitHub 對大型 diff 回傳不完整的變更檔清單時，描述必須包含 UI 變更的截圖；檢查會讓 PR 維持 draft 並留言，直到截圖出現。不完整的檔案清單會保守地視為 GUI 變更。維護者可以針對 `gui/` 變更、GUI 路徑分類誤判、或不完整檔案清單的誤判，加上 `gui-screenshot-waived` label 來豁免截圖要求；新增或移除該 label 會立即重新評估 gate。舊式維護者留言（例如「no gui changes」）在下次 PR 事件時仍會為相容性而辨識，但留言本身不再觸發這個特權 PR gate。貢獻者不能自行豁免截圖要求。
  沒有 repository push 權限的貢獻者 PR 會以 draft 開啟，並維持 draft 直到描述中的四個格子的 review-ready 檢查清單完成：本機 CI 通過、分支位於最新 `dev` commit、所有正確的 Codex 與 CodeRabbit 發現都已修正、以及 ready-for-review 確認。當每個格子都勾選後，檢查會把 PR 標記為可審查，並通知 `MAINTAINERS.md` 中列出的維護者（不含作者）。gate 的狀態與「該做什麼」集中在單一 bot 留言中，每次執行都會重寫，所以只需看一個地方。完成綁定在 PR head 所指的確切 commit：如果之後又推出新 commit，gate 會把 PR 移回 draft、重設檢查清單與維護者通知，並要求你針對最新程式碼再次測試並勾選。重新定位到 `dev` 會自動清除錯誤分支訊息，並被 gate 記住；draft 會一直持續到檢查清單完成。
  在接受完成之前，gate 會驗證它能自行檢查的檢查清單聲明：分支必須位於最新 `dev` commit 或落後最多 10 個 commit，而且目前 head 上所有由 review bot 撰寫的 Codex 與 CodeRabbit review thread 都必須已解決（其他作者未解決的 thread 不會阻擋）。本機 CI 的格子只是作者的 attestation——fork 貢獻者無法啟動 repository CI，必須由維護者啟動——所以 gate 永遠不會反駁它；新的 push 仍會重設每個格子。落在 diff 範圍之外、且只在目前 head 的 review body 中回報的 CodeRabbit 發現，在 bot review thread 開啟期間會計入未解決數；解決所有 bot thread 即可清除該格子。被反駁的聲明會取消勾選對應的格子，並讓 PR 維持 draft。當檢查清單完成且所有 gate 都綠燈時，gate 會加上 `review-ready` label，作為就緒時刻的可見狀態標記。
  CodeRabbit 的狀態留言編輯不會觸發 PR gate。CodeRabbit 成功的 `CodeRabbit` commit status 會透過 `status` 事件喚醒受信任的預設分支 gate。gate 將該 status SHA 對應到確切一個目前 head 仍相符的 open PR，然後在變更檢查清單、label、留言或 draft 狀態之前，重新讀取即時的 review thread 與 review body。模糊或過時的 SHA 關聯會被忽略，且不會以 gate 的具寫入權限 token 執行任何 PR head 程式碼。

- **Hygiene。** 行為變更需要測試；新增 lint 或 type suppression、聚焦或跳過的測試、空的 catch 區塊、編輯產生的輸出，以及未隨 manifest 一起變更的 lockfile，每項都需要明確的核准 label。僅對原始檔做留言層級的變更不算行為變更，也不需要測試。
- **跨平台 CI。** 每個 pull request 的測試套件在 Linux 上分片執行，並在 macOS 上完整執行。Windows 在釋出邊界執行——即提升到 `main` 或 `preview` 時——所以慢速或不穩定的 Windows runner 不能決定你的 pull request 何時變綠。
  這對**每個** pull request 都執行，無論其 base 分支為何——包括 base 是另一個 open PR head 的 stacked child。由 `paths:` filter，而非 base 分支，決定 jobs 是否執行：只碰 docs 或 `devlog/` 的 PR 不會佇列任何 job。

- **Type label。** `label` 檢查會從你的 PR title 推導出 `bug` / `enhancement` / `documentation` / `chore`。沒有可辨識前綴的 title（例如 `stack 3/5: …`）會回退到 PR 的 commits，通常仍是慣例格式；`chore` 家族的 commits（`test:`、`ci:`、`refactor:`）不能推翻 `fix:` 或 `feat:`。真正混合多種型別的 PR 會保持未標記而非猜測，而且人工設定的 label 永不被覆寫。

CodeRabbit 會 review 每個 PR，其發現僅供參考。它說對的就照做；說錯的就說明原因。它不會阻擋 merge。

### 工作流程變更何時生效

`enforce-target` 與 `label` 使用受信任的預設分支自動化。PR gate 在 `pull_request_target` 與 CodeRabbit `status` 事件上執行，兩者都從 repository 的預設分支載入；因此具寫入權限的行為只會在 gate 修訂版提升到 `main` 之後改變。跨平台 CI workflow 在 `pull_request` 上執行，一旦它位於被定位的分支上就立即生效。

## 受贊助的介面

驗證、憑證處理、GitHub Actions workflows、釋出自動化與依賴安裝，都需要維護者贊助該變更（`maintainer-sponsored`）才能 merge。這些介面上的錯誤 merge 代價高昂且難以回復，這是它們成為僅有的以此方式 gate 的介面的原因。其餘一切開放。

## 當 pull request 被關閉時

停滯且帶著未解決 review 回饋的 PR 可能被關閉，並會清楚陳述原因。關閉不是對貢獻者的判決：一旦陳述的原因解決，就重新開啟它，或用乾淨的 PR 取代。若原因不清楚，請詢問。

# wp2 — #8863: localized schtasks status words

## Problem

`windowsCheckedStopLiveDeps().taskState` reads `schtasks /query /tn opencodex-proxy /fo CSV /nh`
and passes stdout to `parseTaskCsvState` (src/service/windows-checked-stop-live.ts:125), which
accepts only `Running` and `Ready|Disabled|Queued`. zh-CN prints `正在运行/就绪/已禁用/已排队`
(System32\zh-CN\schtasks.exe.mui, issue body) and ko-KR prints `실행 중/준비` (issue comment, two
machines). The PowerShell `Get-ScheduledTask` fallback needs 1.6 s to 4.9 s cold, but Part A
caps the whole read at `WINDOWS_STOP_CAPS.managerState` = 1 000 ms
(src/service/windows-checked-stop.ts:375), so the read answers `unknown` and the stop finishes
`evidence-unreadable`; `ocx stop`, `ocx service stop` and `ocx update` fail closed.

## Decision

Recognize the observed words in the CSV parser. Raising `managerState` is rejected: the
scheduler worst case is already 53.5 s of the 60 s default deadline
(src/service/windows-stop-budget.ts), and +5 s with orphan discovery (+3 s) would exceed it and
turn every snapshotless stop into an admission refusal. Words for other locales are not guessed;
they keep the PowerShell fallback. The message rewording the issue suggests (point 3) is a
separate user-facing text change and stays out of this commit.

## Diff

MODIFY src/service/windows-checked-stop-live.ts

```diff
-/** schtasks /query /fo CSV /nh status column. Localized values fall back to PowerShell. */
+/**
+ * Status words of `schtasks /query /fo CSV /nh`. schtasks localizes the column from its .mui
+ * resources, and the PowerShell fallback cannot start inside Part A's 1 s manager-state cap on a
+ * cold machine (#8863), so the words observed from shipped resources are read here: zh-CN from
+ * System32\zh-CN\schtasks.exe.mui, ko-KR from two machines. Any other word stays unknown and
+ * falls back to Get-ScheduledTask's locale-independent State enum.
+ */
+const TASK_CSV_RUNNING = new Set(["running", "正在运行", "실행 중"]);
+const TASK_CSV_NOT_RUNNING = new Set(["ready", "disabled", "queued", "就绪", "已禁用", "已排队", "준비"]);
+
 export function parseTaskCsvState(csv: string): "running" | "not-running" | "unknown" {
   ...
-    const status = fields[fields.length - 1] ?? "";
-    if (/^running$/i.test(status)) return "running";
-    if (/^(ready|disabled|queued)$/i.test(status)) return "not-running";
+    const status = (fields[fields.length - 1] ?? "").normalize("NFC").toLowerCase();
+    if (TASK_CSV_RUNNING.has(status)) return "running";
+    if (TASK_CSV_NOT_RUNNING.has(status)) return "not-running";
     return "unknown";
```

Audit fold (P1): Part A calls `endTask` before the state read whenever the task is registered
(src/service/windows-checked-stop.ts:303-306), and `classifyTaskEnd` (src/service/windows-checked-stop-live.ts:113-121)
recognizes only the English "no running instance" text, so an idle task on zh-CN/ko-KR still ends
`failed` -> `evidence-unreadable`. The live `endTask` therefore re-reads the CSV state inside its
own cap when `/end` failed without a timeout or a denial:

```diff
     async endTask(timeoutMs) {
       if (!gate()) return "failed";
-      return classifyTaskEnd(await run("schtasks", ["/end", "/tn", TASK], timeoutMs));
+      const started = Date.now();
+      const ended = await run("schtasks", ["/end", "/tn", TASK], timeoutMs);
+      const verdict = classifyTaskEnd(ended);
+      if (verdict !== "failed" || ended.timedOut) return verdict;
+      // schtasks localizes "no running instance" too (#8863): an idle task is not-running only
+      // when its own CSV state says so; a running or unreadable state keeps the failure.
+      const left = Math.floor(timeoutMs - (Date.now() - started));
+      if (left < 1) return "failed";
+      const csv = await run("schtasks", ["/query", "/tn", TASK, "/fo", "CSV", "/nh"], left);
+      return csv.status === 0 && !csv.timedOut && parseTaskCsvState(csv.stdout) === "not-running" ? "not-running" : "failed";
     },
```

MODIFY tests/windows/windows-checked-stop-live.test.ts — next to the existing CSV case:

- zh-CN: the four words map to running / not-running x3.
- ko-KR: `실행 중` running, `준비` not-running.
- German `Wird ausgeführt` stays unknown (existing assertion kept).
- `endTask` with a localized `/end` failure: CSV `就绪` -> `not-running`; CSV `正在运行` -> `failed`;
  a timed-out `/end` -> `failed` with no second query; English "no running instance" unchanged.
- `taskState` through `windowsCheckedStopLiveDeps({ run })` with a runner that answers the zh-CN
  CSV and fails the test if `powershell` is invoked: returns `running` with one schtasks call.

MODIFY structure/ops/windows-checked-stop.md — the sentence on the CSV read names the
recognized localized words and the fallback for the rest.

## Verification

- `bun test tests/windows/windows-checked-stop-live.test.ts` red on the base for the new
  assertions, green after.
- `bun test tests/windows/` (platform-faked), `bun run structure:check`.
- NOT RUN: a real zh-CN or ko-KR Windows host.



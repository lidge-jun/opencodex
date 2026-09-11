# Phase timezone: extract only the Santiago fixture

Source PR #3950. Carry ONLY commit 1d8f6ff7e8d48f33c3ce7a1b7118068754bbbe83 onto current dev, retaining luvs01's author and adding a surviving Co-authored-by. MODIFY only gui/tests/usage-custom-range.test.tsx. No JWT, product UI, dependency or workflow change. No UI screenshot is fabricated: describe the test-only scope truthfully in the PR. No new SoT contract beyond fixture isolation; production date interpretation is unchanged.

Activation/acceptance: parent TZ absent and set cases retain exact presence/value and local Date epoch; a child Bun process is created with TZ=America/Santiago and an exact anchored test-name filter, preventing recursion by that timezone value. Child asserts skipped midnight, final-day activity and tooltip as before. Process deadline 12s, child test timeout 10s, parent test timeout 15s; timeout, signal and nonzero exit surface captured diagnostics. Reviewer must check config/preload behavior under direct child invocation and Windows Bun 1.4.0 compatibility. Hosted dashboard test gate explicitly executes this test file; inspect result and logs, not only a generic check badge. Additional fault-path testing is required only if audit reveals a reachable unprotected failure; amend this doc before any code change. Local product tests/build/typecheck/install NOT RUN.

#3950 original stays open until B's separate JWT fix is independently confirmed on dev. No assumption that the original mixed PR's CI certifies this split head. One independent revert covers the timezone test only.

Exact source patch follows:

```diff
diff --git a/gui/tests/usage-custom-range.test.tsx b/gui/tests/usage-custom-range.test.tsx
index 887c31134..02df29f3d 100644
--- a/gui/tests/usage-custom-range.test.tsx
+++ b/gui/tests/usage-custom-range.test.tsx
@@ -154,31 +154,45 @@ for (const connected of [false, true]) {
 }

 test("America/Santiago midnight DST retains final-day activity and tooltip", async () => {
-  const previous = process.env.TZ;
-  process.env.TZ = "America/Santiago";
-  try {
-    expect(new Date(2026, 8, 6, 0).getHours()).toBe(1);
-    await mount();
-    await respond(0, "preset-marker");
-    await enter("2026-09-05T00:00", "2026-09-07T23:59");
-    await apply();
-    const gate = requests.at(-1)!;
-    const data = report(gate, "santiago-marker", "2026-09-07");
-    data.days = ["2026-09-05", "2026-09-06", "2026-09-07"].map(date => ({
-      date, requests: date === "2026-09-07" ? 7 : 0, measuredRequests: 0, reportedRequests: 0,
-      totalTokens: date === "2026-09-07" ? 700 : 0, models: [],
-    }));
-    await act(async () => gate.resolve(Response.json(data)));
-    const active = container.querySelector<HTMLElement>('.heatmap-grid .heatmap-cell:not(.heatmap-cell-0)');
-    expect(active).not.toBeNull();
-    await act(async () => active!.dispatchEvent(new testWindow.MouseEvent("mouseover", { bubbles: true })));
-    expect(container.querySelector(".heatmap-tip-date")?.textContent).toBe("2026-09-07");
-    expect(container.querySelector(".heatmap-tip")?.textContent).toContain("700");
-  } finally {
-    if (previous === undefined) delete process.env.TZ;
-    else process.env.TZ = previous;
+  if (process.env.TZ !== "America/Santiago") {
+    // Restoring an absent TZ can change Bun's effective timezone on Windows.
+    // Start the DST case in its timezone without mutating this suite's clock.
+    const timezone = { present: Object.hasOwn(process.env, "TZ"), value: process.env.TZ };
+    const localTime = new Date(2020, 8, 15, 10, 20).getTime();
+    const child = Bun.spawnSync([
+      process.execPath, "test", import.meta.path,
+      "-t", "^America/Santiago midnight DST retains final-day activity and tooltip$",
+      "--timeout", "10000",
+    ], {
+      env: { ...process.env, TZ: "America/Santiago" },
+      stdout: "pipe", stderr: "pipe", timeout: 12000, killSignal: "SIGKILL",
+    });
+    const diagnostics = `${child.stdout.toString()}\n${child.stderr.toString()}`;
+    expect(child.exitedDueToTimeout, diagnostics).not.toBe(true);
+    expect(child.signalCode, diagnostics).toBeUndefined();
+    expect(child.exitCode, diagnostics).toBe(0);
+    expect({ present: Object.hasOwn(process.env, "TZ"), value: process.env.TZ }).toEqual(timezone);
+    expect(new Date(2020, 8, 15, 10, 20).getTime()).toBe(localTime);
+    return;
   }
-});
+  expect(new Date(2026, 8, 6, 0).getHours()).toBe(1);
+  await mount();
+  await respond(0, "preset-marker");
+  await enter("2026-09-05T00:00", "2026-09-07T23:59");
+  await apply();
+  const gate = requests.at(-1)!;
+  const data = report(gate, "santiago-marker", "2026-09-07");
+  data.days = ["2026-09-05", "2026-09-06", "2026-09-07"].map(date => ({
+    date, requests: date === "2026-09-07" ? 7 : 0, measuredRequests: 0, reportedRequests: 0,
+    totalTokens: date === "2026-09-07" ? 700 : 0, models: [],
+  }));
+  await act(async () => gate.resolve(Response.json(data)));
+  const active = container.querySelector<HTMLElement>('.heatmap-grid .heatmap-cell:not(.heatmap-cell-0)');
+  expect(active).not.toBeNull();
+  await act(async () => active!.dispatchEvent(new testWindow.MouseEvent("mouseover", { bubbles: true })));
+  expect(container.querySelector(".heatmap-tip-date")?.textContent).toBe("2026-09-07");
+  expect(container.querySelector(".heatmap-tip")?.textContent).toContain("700");
+}, 15000);

 test("Apply submits inclusive bounds once; Clear restores the held preset without custom cache entries", async () => {
   await mount();
```

## Audit-driven amendment before implementation

The source patch's explicit 15-second per-test timeout overrides its child CLI 10-second timeout. Change the final test timeout to `process.env.OCX_USAGE_SANTIAGO_CHILD === "1" ? 10000 : 15000`. Add a unique completion marker printed only after the child's last UI assertion; require the marker in the parent as well as exit/signal/timeout checks. Set the child's cwd explicitly to the dashboard root resolved from import.meta.dir. These are same-bug test integrity changes; no production code changes. Preserve the original assertions and parameterized test cases.

Existing hosted Windows/macOS jobs do not run gui/tests. A supplemental verification-only branch will use the already-registered ci.yml workflow_dispatch path, with a separately reviewed minimal workflow that checks out an immutable candidate SHA and executes only focused timezone proof on GitHub-hosted ubuntu/windows/macos. This branch/workflow is excluded from delivery and never merged. Candidate PR CI remains unchanged and required; the supplemental run is independently labeled, not passed off as normal candidate workflow CI. Actions use existing pinned SHAs, contents:read only, no secrets, checkout persist-credentials:false, Bun1.4.0, frozen root and dashboard installs on the hosted machines, and bounded jobs/processes. Never run any of these commands locally. Negative controls must restore candidate bytes before the final positive run and record source identity.

The proposed hosted verification starts in gui/: `bun test --isolate ./tests/usage-custom-range.test.tsx`, with TZ absent, Etc/UTC, Asia/Seoul and America/Santiago in distinct subprocess environments. Verify parent environment and next tests, child success marker, nonzero-exit/absent-marker propagation and process deadline; no fixture/process may survive teardown. Exact workflow YAML, pinned commit and control script are reviewed before dispatch. The repository's Windows product runtime suite is distinct from this Windows dashboard proof.

### Exact test-integrity follow-up diff atop the original source commit

```diff
--- a/gui/tests/usage-custom-range.test.tsx
+++ b/gui/tests/usage-custom-range.test.tsx
@@ -1,5 +1,6 @@
 import { afterEach, beforeEach, expect, test } from "bun:test";
 import { Window } from "happy-dom";
+import { resolve } from "node:path";
 import { act } from "react";
 import type { Root } from "react-dom/client";
 import { LanguageProvider } from "../src/i18n/provider";
@@ -154,7 +155,7 @@
 }

 test("America/Santiago midnight DST retains final-day activity and tooltip", async () => {
-  if (process.env.TZ !== "America/Santiago") {
+  if (process.env.OCX_USAGE_SANTIAGO_CHILD !== "1" && process.env.TZ !== "America/Santiago") {
     // Restoring an absent TZ can change Bun's effective timezone on Windows.
     // Start the DST case in its timezone without mutating this suite's clock.
     const timezone = { present: Object.hasOwn(process.env, "TZ"), value: process.env.TZ };
@@ -164,17 +165,20 @@
       "-t", "^America/Santiago midnight DST retains final-day activity and tooltip$",
       "--timeout", "10000",
     ], {
-      env: { ...process.env, TZ: "America/Santiago" },
+      cwd: resolve(import.meta.dir, ".."),
+      env: { ...process.env, TZ: "America/Santiago", OCX_USAGE_SANTIAGO_CHILD: "1" },
       stdout: "pipe", stderr: "pipe", timeout: 12000, killSignal: "SIGKILL",
     });
     const diagnostics = `${child.stdout.toString()}\n${child.stderr.toString()}`;
     expect(child.exitedDueToTimeout, diagnostics).not.toBe(true);
     expect(child.signalCode, diagnostics).toBeUndefined();
     expect(child.exitCode, diagnostics).toBe(0);
+    expect(child.stdout.toString().split(/\r?\n/), diagnostics).toContain("OCX_SANTIAGO_CASE_COMPLETED");
     expect({ present: Object.hasOwn(process.env, "TZ"), value: process.env.TZ }).toEqual(timezone);
     expect(new Date(2020, 8, 15, 10, 20).getTime()).toBe(localTime);
     return;
   }
+  expect(process.env.TZ).toBe("America/Santiago");
   expect(new Date(2026, 8, 6, 0).getHours()).toBe(1);
   await mount();
   await respond(0, "preset-marker");
@@ -192,7 +196,8 @@
   await act(async () => active!.dispatchEvent(new testWindow.MouseEvent("mouseover", { bubbles: true })));
   expect(container.querySelector(".heatmap-tip-date")?.textContent).toBe("2026-09-07");
   expect(container.querySelector(".heatmap-tip")?.textContent).toContain("700");
-}, 15000);
+  if (process.env.OCX_USAGE_SANTIAGO_CHILD === "1") console.log("OCX_SANTIAGO_CASE_COMPLETED");
+}, process.env.OCX_USAGE_SANTIAGO_CHILD === "1" ? 10000 : 15000);

 test("Apply submits inclusive bounds once; Clear restores the held preset without custom cache entries", async () => {
   await mount();
```

C review amendment: use the dedicated child marker as the sole recursion guard, even when the parent already starts in Santiago. This preserves all original DST assertions and makes completion/state checks run for every parent TZ. Accepted CodeRabbit finding; final source/evidence checkout SHA will be repinned and hosted proof rerun. Prior Linux/Windows proof8223788bd remains historical, not finalhead evidence.

Final candidate ce71d9171 passed independent marker-guard source re-audit. Evidence workflow7d5f1097e/run34170111719 checks out exactcandidatece71d9171; Linux/Windows/macOS each completed10scenarios, fivepositive/fiveexpectednegative, with exactfailure attribution, timeoutPIDabsence and candidatebytesrestored. Actual evidence JSON logs checked. Normal PR3967CI34170093095 pending; no completion/landing claim yet. Existing maintainer gui-screenshot-waived exception applied for test-only change after workflow/label policy inspection. No UI screenshot fabricated, no product gate waived.

NormalCI attempt1 of34170093095 was cancelled at macos1 job20-minute deadline. Last emitted test was the unchanged client-connect CLI rejection case, followed by dangling-process cleanup and no completion. This root macOS lane does not include gui/tests; exact cause remains under investigation. Preserve cancellation as an unsuccessful/incomplete attempt. One same-head failed-job recheck was requested for diagnosis; a green recheck alone does not establish the unrelated runner stall is fixed. Supplemental3OS timezoneproof remains separately valid.

DONE: PR3967 landedc46c22f3e with luvs01 trailer and exactcandidate file. Final candidatece71d9171 supplemental3OS run34170111719 passed all30expected scenarios. StandardCI34170093095 attempt2 passed19jobs/skipped2; attempt1 macos1 stalled/cancelled20min at unchangedclientconnect boundary remains unresolved reliability residual, not a fixedflake claim. Exact destinationbbea77a48+candidatepatch tree and devancestry verified. BJWT3962/eb4188a9 confirmed ondev; source3950 closure follows reconciliation.

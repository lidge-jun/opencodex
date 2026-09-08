# 3863 implementation contract

Carry with -x excluding config-routes.ts. getStartupHealthSnapshot returns fresh cached value unchanged; stale/empty read schedules refresh and returns immediately. Catch rejected or synchronously thrown detached probe and retain stale conservative health; invalidation generation cannot overwrite newer reading. Replace 100ms production settings assertion with controlled probe fixtures. Exact route wiring remains main responsibility.

Validation: local tests/typecheck/build/install NOT RUN by instruction. Read diff and source; top remote CI exercises changed test paths. Each conditional branch listed above is exercised by controlled fixtures; screenshot inspects GUI state. No new enforcement layer; existing API guards remain authoritative.

## Public source diff (MODIFY/NEW paths)

```diff
diff --git a/src/server/management/config-routes.ts b/src/server/management/config-routes.ts
index 4d551a886..9ddd02300 100644
--- a/src/server/management/config-routes.ts
+++ b/src/server/management/config-routes.ts
@@ -107,7 +107,7 @@ import type { PersistedUsageAttempt } from "../../usage/log";
 import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO } from "../auth-cors";
 import { withProviderServiceTierDTO } from "./provider-capability-config";
 import { applySystemEnvToggle } from "../system-env";
-import { getCachedStartupHealth, invalidateStartupHealthCache } from "../startup-health-cache";
+import { getCachedStartupHealth, getStartupHealthSnapshot, invalidateStartupHealthCache } from "../startup-health-cache";
 import { runWindowsTrayAction } from "../windows-tray-control";
 import { runStartupInstallAction, type StartupInstallAction } from "../startup-action-control";
 import { displayCodexRuntimePath, effortClampAppliesToRuntime, loadLastEffortClamp, resolveCodexRuntime } from "../../codex/runtime";
@@ -329,7 +329,9 @@ export async function handleConfigRoutes(ctx: ManagementContext): Promise<Respon
       oauthOpenBrowser: config.oauthOpenBrowser !== false,
       // Absent means off (today's Design B injection), so the GUI/CLI render a plain switch.
       codexDesktopAuthless: config.codexDesktopAuthless === true,
-      startupHealth: await readStartupHealth(config),
+      startupHealth: deps.getCachedStartupHealth
+        ? await readStartupHealth(config)
+        : getStartupHealthSnapshot(config),
       codexRuntime: {
         path: displayCodexRuntimePath(resolved.runtime.command),
         version: resolved.runtime.version,
diff --git a/src/server/startup-health-cache.ts b/src/server/startup-health-cache.ts
index 70380eb4e..571d81b54 100644
--- a/src/server/startup-health-cache.ts
+++ b/src/server/startup-health-cache.ts
@@ -50,6 +50,22 @@ export interface StartupHealthCacheDeps {
   ) => Promise<StartupHealth | null>;
 }
 
+/**
+ * Return the last completed probe immediately and refresh it in the background.
+ *
+ * Settings are consumed by several dashboard controls. They must not block on a
+ * Windows service-manager probe; the dedicated /api/startup-health route owns
+ * the fresh, bounded diagnostic read.
+ */
+export function getStartupHealthSnapshot(
+  config: Pick<OcxConfig, "codexAutoStart">,
+  deps: StartupHealthCacheDeps = {},
+): StartupHealth {
+  const now = deps.now ?? Date.now;
+  if (!cached || now() - cached.timestamp >= CACHE_TTL_MS) refreshInBackground(config, deps);
+  return cached ? markStartupHealthDiagnosticStale(cached.value) : conservativeFallback(config);
+}
+
 export function markStartupHealthDiagnosticStale(value: StartupHealth): StartupHealth {
   if (!value.localRoutingDependency) return { ...value, diagnosticStale: true };
   return {
diff --git a/tests/service/autostart-health.test.ts b/tests/service/autostart-health.test.ts
index 639f1b34c..48bb7b539 100644
--- a/tests/service/autostart-health.test.ts
+++ b/tests/service/autostart-health.test.ts
@@ -3,7 +3,7 @@ import { deriveStartupHealth, formatStartupRoutingDetail, startupHealthSummary }
 import { unusedProxyWarningLines } from "../../src/cli/status";
 import { classifyCodexRouting, hasInjectedCodexRouting } from "../../src/codex/inject";
 import { handleManagementAPI } from "../../src/server/management-api";
-import { getCachedStartupHealth, invalidateStartupHealthCache, markStartupHealthDiagnosticStale } from "../../src/server/startup-health-cache";
+import { getCachedStartupHealth, getStartupHealthSnapshot, invalidateStartupHealthCache, markStartupHealthDiagnosticStale } from "../../src/server/startup-health-cache";
 import type { OcxConfig } from "../../src/types";
 
 const base = {
@@ -277,6 +277,43 @@ describe("Codex startup health", () => {
     await pendingProbe;
     invalidateStartupHealthCache();
   });
+
+  test("settings snapshot starts a probe without waiting for it", async () => {
+    invalidateStartupHealthCache();
+    let releaseProbe!: (value: ReturnType<typeof deriveStartupHealth>) => void;
+    const pendingProbe = new Promise<ReturnType<typeof deriveStartupHealth>>(resolve => {
+      releaseProbe = resolve;
+    });
+
+    const health = getStartupHealthSnapshot(
+      { codexAutoStart: true },
+      { probe: async () => pendingProbe },
+    );
+
+    expect(health.diagnosticStale).toBe(true);
+    releaseProbe(deriveStartupHealth({ ...base, routingKind: "native" }));
+    await pendingProbe;
+    invalidateStartupHealthCache();
+  });
+
+  test("settings GET uses the non-blocking startup-health snapshot in production", async () => {
+    invalidateStartupHealthCache();
+    const url = new URL("http://localhost/api/settings");
+
+    const response = await Promise.race([
+      handleManagementAPI(
+        new Request(url),
+        url,
+        { port: 10100, providers: {}, defaultProvider: "openai", codexAutoStart: true } as OcxConfig,
+      ),
+      new Promise<null>(resolve => setTimeout(() => resolve(null), 100)),
+    ]);
+
+    expect(response?.status).toBe(200);
+    const body = await response!.json() as { startupHealth?: { diagnosticStale?: boolean } };
+    expect(body.startupHealth?.diagnosticStale).toBe(true);
+    invalidateStartupHealthCache();
+  });
 });
 import { ManagementRequest as Request } from "../helpers/management-auth";
 

```

## Main-owned route handoff

At current dev, settings GET uses `startupHealth: await readStartupHealth(config)` at `src/server/management/config-routes.ts:332`. M changes only this settings read to the exported immediate snapshot and retains the dedicated `/api/startup-health` bounded read. Settings PUT at line 625 is separately present; it must remain reviewed explicitly rather than blindly replaced. C does not modify either call site.

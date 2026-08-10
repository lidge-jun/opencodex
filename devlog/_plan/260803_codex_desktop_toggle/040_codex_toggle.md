# WP5 — the Codex GUI and CLI toggle, with artifact-level restore truth

Research: `001_native_restore_thesis.md`. Read it first; this doc is the diff.

The failure this phase closes is concrete: `restoreNativeCodex()` can leave routed
threads hidden when the history database is locked, yet return `success: true`
because that boolean is copied from config restore alone
(`src/codex/inject.ts:764-794`). There is a second false green in the existing
CLI: `ocx restore back` calls `syncModelsToCodex()` at
`src/cli/index.ts:756`, treats any `ok` result as applied, and prints “now routes
through opencodex” at `src/cli/index.ts:763`; the native restore call is at
`src/cli/index.ts:768`, not the stale `src/cli/index.ts:745` citation used by the
research note. If WP3 turns desired OFF into a bare
successful skip, that command claims a write which did not happen. In the other
direction, `ocx restore` restores native artifacts but records no OFF, so startup's
sync at `src/cli/index.ts:319` can put the routing back.

**The earlier CLI-out-of-scope position is reversed.** WP3's gate changes the
meaning of existing CLI commands, so WP5 owns their user-visible result and
exit-code behavior. The decision is: **`ocx restore` / `ocx eject` persist desired
OFF; `ocx restore back` / `ocx eject back` persist desired ON.** These are explicit
user integration actions, unlike stop, shutdown, or uninstall cleanup, which keep
their existing intent-neutral behavior. This makes CLI and GUI two front ends to
the same desired-state transition and makes either result survive restart.

This phase adds the missing artifact-level result, classifies the held-history
failure, consumes WP3's shared native-integration contract and per-client
coordinator, registers Codex in that route family, and gives the overview card an
honest switch. It adds no operation journal or lifecycle engine.

## Dependency and landing order

WP3 lands first and owns the complete shared contract: the
`"codex" | "claude" | "claude-desktop" | "grok"` native-client union, status and
success envelopes with **required** `desiredEnabled`, the refusal envelope and
helper, desired/observed status helpers, field-scoped intent mutation, and the
per-client single-flight. WP5 imports and extends that contract; it does not
redeclare any of those owners (`020_desired_state.md:172-230,294-367,479-534,623-661`).
WP5 then lands **before WP6**. This is sequential,
not parallel, because WP5 and WP6 both touch
`src/server/management/native-integration-routes.ts`,
`gui/src/pages/integrations/native-api.ts`,
`gui/src/pages/integrations/overview-clients.ts`,
`gui/src/pages/integrations/IntegrationsOverview.tsx`, refusal copy, locale files,
and shared GUI tests (`050_desktop_toggle.md:50-71,104-119,376-382,722-781`). WP6 rebases
its Desktop additions onto WP5's Codex additions.

## IN / OUT

IN:

- `src/codex/history-provider.ts` (MODIFY) — retain the exhausted retry's
  classified reason instead of reducing it to `null`.
- `src/codex/inject.ts` (MODIFY) — return config/catalog/history results and make
  aggregate success mean all required artifacts succeeded.
- `src/codex/sync.ts` (MODIFY) — consume WP3's coordinator and return a
  discriminated disabled skip; re-read desired state at the catalog/cache and
  config/history write boundaries.
- `src/cli/index.ts` (MODIFY) — persist explicit restore intent, distinguish
  applied/disabled/failed sync outcomes, and print no applied claim on a skip.
- `src/cli/models.ts` and `src/cli/provider.ts` (MODIFY) — report an intentional
  disabled skip without turning the provider/custom-model mutation into a false
  failure or a silent sync success.
- `src/server/management/config-routes.ts` (MODIFY) — preserve the discriminated
  skip in `POST /api/sync` instead of flattening it through `ok`.
- `src/server/management/context.ts` (MODIFY) — add Codex mutation seams so route
  tests cannot touch the developer's real Codex home.
- `src/server/management/native-integration-routes.ts` (MODIFY) — add Codex to
  GET and `PUT /api/native-integrations/codex`, persisting WP3 intent before the
  client mutation.
- `gui/src/pages/integrations/overview-clients.ts` (MODIFY),
  `gui/src/pages/integrations/IntegrationsOverview.tsx` (MODIFY),
  `gui/src/pages/integrations/native-api.ts` (MODIFY), and
  `gui/src/pages/integrations/refusal-copy.ts` (MODIFY) — wire the card, dialog,
  structured native API vocabulary, and localized refusal copy.
- `gui/src/i18n/en.ts`, `de.ts`, `ja.ts`, `ko.ts`, `ru.ts`, `zh.ts` (MODIFY) —
  source copy plus all five translations required by `gui/AGENTS.md:13-19`.
- `tests/native-codex-toggle.test.ts` (NEW),
  `tests/codex-history-provider.test.ts` (MODIFY),
  `tests/codex-journal.test.ts` (MODIFY),
  `gui/tests/integrations-overview-rows.test.ts` (MODIFY),
  `gui/tests/overview-state-merge.test.ts` (MODIFY), and
  `gui/tests/consequence-dialog.test.tsx` (MODIFY).

OUT:

- `src/server/management-api.ts`'s route dispatcher and `src/service.ts` — no new
  lifecycle state machine. The coordinator and gates they call are WP3-owned.
- Stop, signal shutdown, service teardown, and uninstall desired-state writes —
  their calls at `src/cli/index.ts:257,528,591` restore dead pointers as cleanup
  but do not opt the user out. Only the explicit restore/eject command at
  `src/cli/index.ts:745-790` changes desired Codex intent. The cleanup writers
  still use WP3's Codex flight; they use its unconditional `teardown` policy, not
  the OFF-only toggle policy.
- `/v1/responses` and every data-plane router — a client flag gates automatic
  Codex config writes, never the shared transport (`003_durable_desired_state.md:117-130`).
- `src/integrations/writer.ts`, operation records, snapshots, undo routes, and the
  superseded `src/integrations/native/codex.ts` idea — turning the switch back on
  is `syncModelsToCodex`, not replay.
- `gui/dist`, docs publishing, releases, deployment, and any live proxy mutation.

## A disabled sync is not an applied sync

WP3 owns the gate and coordinator; WP5 consumes its result in every existing CLI
caller. Against the current `CodexSyncResult` at `src/codex/sync.ts:9-22`, WP3's
contract is discriminated instead of returning only `ok: true` with zero counts:

```diff
export interface CodexSyncResult {
+  /** `skipped` is policy truth, never evidence that Codex was written. */
+  status: "applied" | "skipped";
   ok: boolean;
+  skippedReason?: "desired_disabled" | "desired_state_changed"
+    | "desired_state_unavailable";
@@
 }
```

Every current applied return at `src/codex/sync.ts:61-70,114-129` adds
`status: "applied"`. Desired OFF returns this exact shape before catalog work:

```ts
{
  status: "skipped",
  skippedReason: "desired_disabled",
  ok: true,
  added: 0,
  catalogPath: null,
  catalogExists: false,
  catalogWritten: false,
  cacheSynced: false,
  message: "Codex integration is OFF; no Codex config, catalog, cache, or history was changed.",
}
```

`ok: true` means the policy was honored; `status` says whether the requested write
was applied. No caller may infer application from `ok` alone. The API preserves
both fields. `POST /api/sync` at `src/server/management/config-routes.ts:261-268`
returns HTTP 200 for a disabled policy skip and HTTP 500 only for an attempted
apply with `ok: false`; its JSON still contains `status` and `skippedReason`.

## CLI is an explicit desired-state surface

The current restore block is `src/cli/index.ts:745-790`. Amend that real block,
using WP3's field-scoped desired-state mutation and Codex single-flight owner:
`mutateClientIntegrationEnabled()` is WP3's field-scoped owner. ON delegates to
`syncModelsToCodex()`, which acquires the shared flight itself; OFF wraps the
direct restore in that flight.

```diff
   case "restore":
   case "eject": {
     if (args[1] === "back") {
@@
       if (!live) {
         console.error("No running proxy found. Run 'ocx start' — it injects opencodex automatically.");
         process.exit(1);
       }
+      // Explicit enable: commit desired ON before entering sync's Codex flight.
+      const desired = mutateClientIntegrationEnabled("codex", true);
+      if (desired.status === "unavailable") {
+        console.error(`Codex desired state was not saved (${desired.reason}).`);
+        process.exitCode = desired.reason === "conflict" ? 2 : 1;
+        break;
+      }
-      const synced = await syncModelsToCodex(live.port);
+      const synced = await syncModelsToCodex(live.port, desired.value.config);
-      if (!synced.ok) {
-        process.exitCode = 1;
+      if (synced.status === "skipped") {
+        // OFF won a later serialized transition. Never print the applied claim.
+        process.exitCode = 2;
+        console.error("Codex integration is OFF; restore back did not change Codex. Retry after the competing integration change finishes.");
+        break;
+      }
+      if (!synced.ok) {
+        process.exitCode = 1;
         console.error("Plain `codex` was not switched back to opencodex. Fix the reported Codex config issue and retry.");
         break;
       }
@@
       break;
     }
+    // Explicit disable: unlike stop/uninstall cleanup, restore/eject records OFF.
+    const desired = mutateClientIntegrationEnabled("codex", false);
+    if (desired.status === "unavailable") {
+      console.error(`Codex desired state was not saved (${desired.reason}).`);
+      process.exitCode = desired.reason === "conflict" ? 2 : 1;
+      break;
+    }
     let r: { success: boolean; message: string };
@@
-    try {
-      r = restoreNativeCodex();
-    } catch (err) {
-      r = { success: false, message: err instanceof Error ? err.message : String(err) };
-    }
+    try {
+      r = await runClientIntegrationFlight(
+        "codex",
+        "disable",
+        () => Promise.resolve(restoreNativeCodex({
+          beforeWrite: () => requirePersistedClientIntent("codex", false),
+        })),
+      );
+    } catch (err) {
+      r = { success: false, message: err instanceof Error ? err.message : String(err) };
+    }
@@
-    if (r.success) {
-      console.log("Plain `codex` now runs natively (no proxy). Switch back with: ocx restore back");
+    if (r.success) {
+      console.log("Codex integration is OFF and plain `codex` now runs natively. Switch back with: ocx restore back");
```

Exit `2` means “the requested integration transition was not applied because a
retryable policy/config flight won”; exit `1` means a non-retryable mutation or
artifact failure; exit `0` means the explicit transition reached its stated
observed result. This distinction matters to scripts without relabeling a
deliberate `ocx sync` policy skip as corruption.

Every direct `syncModelsToCodex()` caller branches on `status` before `ok`:

| Caller | Disabled output | Exit / parent outcome |
|---|---|---|
| startup (`src/cli/index.ts:319`) | one indented line: `Codex integration OFF; startup left Codex native.` | proxy start remains 0 |
| ensure, live and newly started (`src/cli/index.ts:367-369,409-411`) | same explicit skip, then the existing proxy-running line | ensure remains 0 |
| `restore back` (`src/cli/index.ts:751-764`) | never prints “now routes”; prints the competing-OFF error above | 2 for skipped, 1 for attempted failure |
| `sync` (`src/cli/index.ts:827-842`) | `Codex integration is OFF; sync skipped and no Codex files changed.` | 0: requested policy is already satisfied |
| custom-model refresh (`src/cli/models.ts:102-107`) | `Custom model saved; Codex integration is OFF, so its catalog was not changed.` | parent mutation remains 0 |
| provider `--sync` (`src/cli/provider.ts:232-239`) | `Provider saved; Codex integration is OFF, so Codex sync was skipped.` | provider mutation remains 0 |
| `POST /api/sync` / `ocx system sync` (`src/server/management/config-routes.ts:261-268`, `src/cli/system-command.ts:104-107`) | structured `status:"skipped", skippedReason:"desired_disabled"`; human formatter prints the message | HTTP/CLI 0 |

Background provider/model refreshes do not print, but they must return/record the
same skipped reason for tests and diagnostics. A silent background no-op is
acceptable; a foreground command claiming an apply is not.

## The structured result

MODIFY `src/codex/history-provider.ts` at the current
`CodexHistorySyncResult` (`src/codex/history-provider.ts:162-168`):

```ts
export type CodexHistoryFailureReason = "busy" | "permission";

export interface CodexHistorySyncResult {
  rows: number;
  files: number;
  ejectedRows?: number;
  /** The mutation was skipped after every retry; zero rows is not a successful no-op. */
  failed?: true;
  /**
   * Why the retry budget was exhausted. `failed` alone caused the Codex-toggle
   * incident: SQLITE_BUSY and EACCES both became the same boolean, then
   * restoreNativeCodex converted that boolean to prose while keeping
   * `success: true`. Callers need this discriminator to recommend a retry only
   * for contention and to stop treating an ACL failure as a lock that will pass.
   */
  failureReason?: CodexHistoryFailureReason;
}
```

MODIFY `src/codex/inject.ts` above `restoreNativeCodex()` (currently line 764):

```ts
export type CodexRestoreArtifactState = "ok" | "skipped" | "failed";

export interface CodexRestoreConfigResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  action: "journal-restored" | "owned-fields-stripped" | "external-provider-preserved" | "failed";
  message: string;
}

export interface CodexRestoreCatalogResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  removed: number;
  kept: number;
  path: string | null;
  message: string;
}

export interface CodexRestoreHistoryResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  reason?: CodexHistoryFailureReason;
  rows: number;
  files: number;
  ejectedRows: number;
  message: string;
}

export interface CodexNativeRestoreResult {
  /**
   * True only when every artifact required for a native Codex view succeeded.
   * The former boolean described config only, so the held-history incident
   * returned true while routed threads remained tagged opencodex and invisible.
   * Consumers must inspect `artifacts` for the failed boundary; they must never
   * recover structure by parsing `message`.
   */
  success: boolean;
  message: string;
  externalProvider?: string;
  artifacts: {
    config: CodexRestoreConfigResult;
    catalog: CodexRestoreCatalogResult;
    history: CodexRestoreHistoryResult;
  };
}

export interface CodexNativeRestoreOptions {
  /** Called separately immediately before config/journal, catalog, and history writes. */
  beforeWrite?: () =>
    | { ok: true; config: OcxConfig }
    | { ok: false; reason: "desired_state_changed" | "desired_state_unavailable" };
}
```

`restoreNativeCodex(options: CodexNativeRestoreOptions = {}):
CodexNativeRestoreResult` keeps the existing operation
order but catches and records each artifact boundary separately. Config uses
`restoreJournalState()` and then the existing `removeCodexConfig()` fallback
(`src/codex/inject.ts:770-774`); catalog delegates once to
`restoreCodexCatalog()` (`src/codex/catalog/sync.ts:572-597`); history delegates
once to `syncCodexHistoryProvider("openai", ...)` (`src/codex/inject.ts:775-783`).
Aggregate `success` is `config.state !== "failed" && catalog.state !== "failed"
&& history.state !== "failed"`. Existing callers can keep reading `.success` and
`.message`, but a history failure now makes `.success === false`.

The external-provider courtesy is a successful skip, not a fake restore. When
`currentExternalCodexModelProvider()` returns (currently lines 765-768), remove
only the stale journal and return all three artifacts as `state: "skipped"`,
config action `external-provider-preserved`, and `externalProvider`. No catalog
or history function runs. That preserves the existing behavior for `custom`
while giving the card a stable fact to show.

## The route

Method and path: `PUT /api/native-integrations/codex` with
`Content-Type: application/json`.

Request:

```ts
{ enabled: boolean }
```

Success (`200`), consuming WP3's envelope and adding optional Codex detail.
`desiredEnabled` is required; omitting it was the WP5/WP6 composition bug:

```ts
{
  ok: true;
  clientId: "codex";
  changed: boolean;
  state: "absent" | "current" | "unsafe";
  desiredEnabled: boolean;
  message: string;
  reason?: "external_provider_preserved" | "catalog_warning";
  externalProvider?: string;
  artifacts?: CodexNativeRestoreResult["artifacts"];
}
```

Disable enters WP3's Codex flight, persists `clientIntegrations.codex = false`
through its field-scoped `mutatePersistedConfig()` owner, then checks teardown
ownership and calls structured `restoreNativeCodex()`. That order is intentional:
desired OFF survives an ownership refusal or drift so a later automatic apply
cannot reverse the request. `mutatePersistedConfig()` already clones, rebases,
freshness-checks, and commits under the shared config lock
(`src/config.ts:1846-1906`); WP5 must not clone a long-lived request config and
whole-file-save it.

Enable uses the same flight, persists true, resolves the running listener from
`readRuntimePort(process.pid)` with request/config fallback, and calls
`syncModelsToCodex(port, freshlyLoadedConfig, null)`. Bare
`injectCodexConfig()` is forbidden: the full sync refreshes the catalog before
injecting (`src/codex/sync.ts:83-110`). Every success response reports the
freshly re-read desired value, not the request body copied back as fact.

GET `/api/native-integrations` adds a Codex row. Its `state` is observed routing
from `getCodexRoutingKind()` (`src/codex/inject.ts:255-273`), not merely desired
intent: `opencodex-local` is `current`, `native` is `absent`, and
`custom-local|custom-remote|unknown` is `unsafe` unless an external
`model_provider` explains it, in which case it is `absent` with
`reason: "external_provider_preserved"` and a message naming that provider.
`disableBlocked` carries `home_mismatch` only while teardown would touch our
artifacts. Consume WP3's status helper and effective-state reader; no WP5 caller
open-codes the map's defaulting rule. The current route has no desired field
(`src/server/management/native-integration-routes.ts:41-74`); WP3 adds it before
this diff lands.

Every refusal consumes WP3's widened refusal helper, including desired and last
observed state after persistence. WP5 does not call the old four-argument helper
at `src/server/management/native-integration-routes.ts:76-87`:

| HTTP | reason | Trigger | Observable state |
|---|---|---|---|
| 409 | `config_busy` | WP3 desired-state persistence or Codex single-flight loses a real contention race | No unreported Codex write occurs; retry is correct |
| 409 | `home_mismatch` | disable sees an installed service owned by another Codex/OpenCodex home | Desired OFF is durable; Codex artifacts are untouched |
| 409 | `history_busy` | config and catalog restored, history retries exhaust on busy/locked contention | Desired OFF is durable; native routing is active, but routed threads remain hidden until retry |
| 500 | `history_permission` | config and catalog restored, history fails with `EPERM`/`EACCES` | Desired OFF is durable; user must fix permissions, not wait |
| 500 | `write_failed` | desired-state persistence cannot open its lock, config/catalog restore fails, or enable sync returns `ok: false` | Message names the failed boundary; no retry promise unless the cause is known |

Malformed JSON and non-boolean `enabled` retain the route family's existing
plain `400` responses
(`src/server/management/native-integration-routes.ts:206-215,381-391`); these are
request errors, not native refusals. An external provider is not a refusal: the
desired flag changes and the response is `200`, reason
`external_provider_preserved`, while the config/catalog/history stay untouched.

Refusal/failure response (WP3's shared envelope, not a WP5 redefinition):

```ts
{
  error: "native integration change refused" | "native integration change failed";
  code: "native_integration_refused" | "native_integration_failed";
  clientId: "codex";
  reason: "config_busy" | "home_mismatch" | "history_busy"
    | "history_permission" | "write_failed";
  message: string;
  desiredEnabled: boolean;
  observedState?: "absent" | "current" | "unsafe";
}
```

Invalid bodies remain `{ error: "invalid JSON body" }` or
`{ error: "enabled must be a boolean" }` with HTTP 400.

MODIFY `src/server/management/native-integration-routes.ts`. The contract types,
union, refusal helper, and flight primitive in this hunk are imports/owners landed
by WP3; WP5 adds only Codex detail and behavior. The real current GET anchor is
`clients: [claudeStatus(config, getConfigPath()), grokStatus()]` at
`src/server/management/native-integration-routes.ts:374-378`; WP3 first changes
Grok to its desired-aware helper, so the WP5 hunk below deliberately applies to
that post-WP3 line rather than pretending the phases are parallel:

```diff
+import {
+  currentExternalCodexModelProvider,
+  getCodexConfigPath,
+  getCodexRoutingKind,
+  restoreNativeCodex,
+  type CodexNativeRestoreResult,
+} from "../../codex/inject";
+import { syncModelsToCodex } from "../../codex/sync";
+import {
+  loadConfig, mutateClientIntegrationEnabled, readRuntimePort,
+} from "../../config";
+import {
+  requirePersistedClientIntent,
+  runClientIntegrationFlight,
+} from "../../integrations/desired-state";
+function codexStatus(ctx: ManagementContext): NativeStatus {
+  const { deps } = ctx;
+  const externalProvider = (deps.currentExternalCodexModelProvider
+    ?? currentExternalCodexModelProvider)();
+  const routing = (deps.getCodexRoutingKind ?? getCodexRoutingKind)();
+  const owned = routing === "opencodex-local" ? assertNativeTeardownOwned() : null;
+  return withDesiredState(loadConfig(), {
+    clientId: "codex",
+    state: externalProvider ? "absent"
+      : routing === "opencodex-local" ? "current"
+      : routing === "native" ? "absent" : "unsafe",
+    installed: true,
+    configPath: getCodexConfigPath(),
+    disableBlocked: owned && !owned.ok
+      ? { reason: "home_mismatch", message: owned.message } : null,
+    ...(externalProvider ? {
+      reason: "external_provider_preserved" as const, externalProvider,
+    } : {}),
+  });
+}
@@
-      clients: [claudeStatus(config, getConfigPath()), grokStatus(config)],
+      clients: [codexStatus(ctx), claudeStatus(config, getConfigPath()), grokStatus(config)],
@@
+  if (url.pathname === "/api/native-integrations/codex" && req.method === "PUT") {
+      let body: { enabled?: unknown };
+      try {
+        body = await readManagementJsonBody(req);
+      } catch (error) {
+        rethrowManagementBodyTooLarge(error);
+        return jsonResponse({ error: "invalid JSON body" }, 400);
+      }
+      if (typeof body.enabled !== "boolean") {
+        return jsonResponse({ error: "enabled must be a boolean" }, 400);
+      }
+      const enabled = body.enabled;
+      const desired = mutateClientIntegrationEnabled("codex", enabled);
+      if (desired.status === "unavailable") {
+        return desiredStatePersistenceFailure("codex", desired.reason, ctx);
+      }
+      const operationConfig = desired.value.config;
+
+      if (!enabled) {
+        const owned = assertNativeTeardownOwned();
+        if (!owned.ok) return refusal({
+          status: 409, clientId: "codex", reason: "home_mismatch",
+          desiredEnabled: false, observedState: codexStatus(ctx).state,
+          message: owned.message,
+        });
+        const restore = await runClientIntegrationFlight(
+          "codex",
+          "disable",
+          () => Promise.resolve((deps.restoreNativeCodex ?? restoreNativeCodex)({
+            beforeWrite: () => requirePersistedClientIntent("codex", false),
+          })),
+        );
+      if (!restore.success) {
+        const history = restore.artifacts.history;
+        const otherArtifactsOk = restore.artifacts.config.state !== "failed"
+          && restore.artifacts.catalog.state !== "failed";
+        if (otherArtifactsOk && history.state === "failed" && history.reason === "busy") {
+          return refusal({ status: 409, clientId: "codex", reason: "history_busy",
+            desiredEnabled: false, observedState: "absent", message: history.message });
+        }
+        if (otherArtifactsOk && history.state === "failed" && history.reason === "permission") {
+          return refusal({ status: 500, clientId: "codex", reason: "history_permission",
+            desiredEnabled: false, observedState: "absent", message: history.message });
+        }
+        return refusal({ status: 500, clientId: "codex", reason: "write_failed",
+          desiredEnabled: false, observedState: codexStatus(ctx).state,
+          message: restore.message });
+      }
+      return jsonResponse({
+        ok: true, clientId: "codex",
+        changed: desired.status === "committed"
+          || Object.values(restore.artifacts).some(a => a.changed),
+        state: "absent",
+        desiredEnabled: false,
+        message: restore.message, artifacts: restore.artifacts,
+        ...(restore.externalProvider ? {
+          reason: "external_provider_preserved" as const,
+          externalProvider: restore.externalProvider,
+        } : {}),
+      } satisfies NativeToggleEnvelope);
+      }
+
+    const externalProvider = (deps.currentExternalCodexModelProvider
+      ?? currentExternalCodexModelProvider)();
+    const runtime = (deps.readRuntimePort ?? readRuntimePort)(process.pid);
+    const port = runtime?.port ?? (Number(url.port) || operationConfig.port);
+    // syncModelsToCodex is the lowest shared ON owner and enters the Codex
+    // flight itself; acquiring an outer route flight would self-deadlock.
+    const synced = await (deps.syncModelsToCodex ?? syncModelsToCodex)(
+      port, operationConfig, null,
+    );
+    if (synced.status === "skipped") return refusal({
+      status: 409, clientId: "codex", reason: "config_busy",
+      desiredEnabled: false, observedState: codexStatus(ctx).state,
+      message: "Desired OFF superseded this enable before its write; retry the explicit enable.",
+    });
+    if (!synced.ok) return refusal({ status: 500, clientId: "codex",
+      reason: "write_failed", desiredEnabled: true,
+      observedState: codexStatus(ctx).state, message: synced.message });
+    return jsonResponse({
+      ok: true, clientId: "codex",
+      changed: desired.status === "committed" || !externalProvider,
+      state: externalProvider ? "absent" : "current", message: synced.message,
+      desiredEnabled: true,
+      ...(externalProvider ? {
+        reason: "external_provider_preserved" as const,
+        externalProvider,
+      } : synced.warning ? { reason: "catalog_warning" as const } : {}),
+    } satisfies NativeToggleEnvelope);
+  }
```

MODIFY `src/server/management/context.ts` with typed optional seams for
`restoreNativeCodex`, `syncModelsToCodex`, `getCodexRoutingKind`, and
`currentExternalCodexModelProvider`. The production defaults are the real
functions; `tests/native-codex-toggle.test.ts` supplies deterministic results.
This follows the existing reason for `saveConfigPreservingClaudeCode` and Grok's
writer/catalog seams (`src/server/management/context.ts:12-37`).

## Coordination consumed from WP3

An entry guard is insufficient. Today catalog discovery awaits inside
`syncModelsToCodex()` before the irreversible injection at
`src/codex/sync.ts:83-110`; OFF can be persisted during that await. WP5 therefore
uses WP3's one Codex flight for **every** producer, not a route-local promise:

- GUI `PUT /api/native-integrations/codex`;
- CLI `restore`, `restore back`, `sync`, startup, and both ensure paths;
- stop/shutdown/uninstall restore under the intent-neutral `teardown` operation;
- `POST /api/sync` and provider/model/combo refreshes;
- custom-model/provider CLI sync; and
- startup/background catalog refresh and injection.

The flight serializes irreversible client operations. Desired intent may still
change while catalog work awaits — that is why the last-moment read is separate
and mandatory. It is the same client key across GUI, CLI, startup, and background
entry points; adding another `let codexToggleFlight` in the route would leave the
accepted race intact. A second write operation joins an identical reconciliation
or receives the shared `config_busy`/retry outcome for an opposing transition; it
never overlaps another Codex write.

Serialization does not replace fresh policy reads. Desired state is loaded from
persisted config — never only from the request-scoped `config` object —
immediately before each irreversible boundary:

| Direction | Irreversible boundary | Required fresh state |
|---|---|---|
| ON | catalog/cache write inside `refreshCodexModelCatalog()` | ON |
| ON | config/profile/journal write inside `injectCodexConfig()` | ON |
| ON | history provider retag inside injection | ON |
| OFF | journal restore or owned-field strip in `restoreNativeCodex()` | OFF |
| OFF | catalog restore in `restoreCodexCatalog()` | OFF |
| OFF | history retag/manifest consumption in `syncCodexHistoryProvider("openai")` | OFF |

The lower write owners accept the WP3 flight's `beforeWrite()` assertion, because
a check immediately before calling an async catalog helper is still too early.
If the assertion observes the opposite desired state, that boundary does not
write and returns the discriminated superseded/config-busy outcome. Already
completed earlier artifacts are reported as changed; the response never rolls
intent back and never claims the opposite observed state.

Lifecycle teardown is the named exception to the *gate*, not to the fresh read or
flight. It re-reads desired intent at each boundary for diagnostics but restores
native artifacts regardless, because a stopped proxy must not leave a dead
pointer. It never writes the desired map. A later start sees the preserved ON and
may re-enable; that is teardown recovery, not an explicit `ocx restore` opt-out.

The external `model_provider` courtesy remains ahead of Codex-owned writes:
desired state changes, the stale journal is removed where current behavior does
so (`src/codex/inject.ts:765-768`), and config/catalog/history are structured
skips. WP5 does not seize an externally owned provider in either direction.

## Desired OFF converges after interruption

Desired OFF is not merely permission to skip future ON writes. Startup enters the
same Codex flight and re-runs the idempotent remover whenever persisted intent is
OFF. That reconciliation runs before startup would otherwise sync at
`src/cli/index.ts:319`; it does not stop the proxy or disable `/v1/responses`.
WP5 registers Codex's observed-state probe (`getCodexRoutingKind`) and remover
(`restoreNativeCodex`) in WP3's exhaustive reconciliation registry; it does not
add another startup hook. WP3 already invokes the registry for startup, ensure,
and status (`020_desired_state.md:629-685`).

The retry walk is explicit:

| Persisted/observed state after a crash | Startup re-run |
|---|---|
| OFF saved; config, catalog, and history still routed | restore/strip config, restore catalog, retag history |
| config native; catalog still has routed rows; history still tagged opencodex | config reports `skipped`/unchanged, catalog removes routed rows, history retags |
| config and catalog native; history still tagged opencodex or backup manifest remains | first two artifacts report unchanged, history alone retries and consumes the manifest on success |
| all three native; stale journal remains | journal cleanup completes; all other artifacts are unchanged |
| external `model_provider` owns routing | remove only the stale opencodex journal and return three courtesy skips |

If history is busy, startup reports the classified partial outcome and leaves OFF
durable; the next startup or explicit OFF retries. Permission failure is also
re-run but remains a 500/non-retry-advice outcome until permissions change. No
state is reconstructed by parsing `restoreNativeCodex().message`.

## History-lock classification

The current low-level code cannot distinguish the two outcomes after retry. It
recognizes `SQLITE_BUSY`, `SQLITE_LOCKED`, `EBUSY`, `EPERM`, and `EACCES` in one
predicate (`src/codex/history-provider.ts:511-523`), then `withHistoryRetry()`
discards the final error and returns `null`
(`src/codex/history-provider.ts:536-548`). The caller therefore has
no code left to inspect at line 577. Saying the GUI can classify this today would
be false.

The minimal change is one classifier and one internal discriminated retry helper:

```ts
export function classifyRecoverableHistoryError(
  error: unknown,
): CodexHistoryFailureReason | null {
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (["SQLITE_BUSY", "SQLITE_LOCKED", "EBUSY"].includes(code)
    || message.includes("database is locked")
    || message.includes("database is busy")
    || message.includes("resource busy")) return "busy";
  if (["EPERM", "EACCES"].includes(code)
    || message.includes("operation not permitted")
    || message.includes("permission denied")) return "permission";
  return null;
}
```

`isRecoverableHistoryError(error)` becomes
`classifyRecoverableHistoryError(error) !== null`, preserving its public boolean
contract and existing tests. New internal `withHistoryRetryResult()` returns
`{ ok: true, value } | { ok: false, reason }`; exported `withHistoryRetry()` wraps
it and still returns `T | null`, preserving callers/tests at
`tests/codex-history-provider.test.ts:309-361`. `syncCodexHistoryProvider()` uses
the detailed helper and emits `{ rows: 0, files: 0, failed: true,
failureReason: retry.reason }`. Neither `restoreNativeCodex`, the route, nor the
GUI parses error prose.

## GUI

`codexRow` currently hard-codes `toggle: null` and ignores the native family
(`gui/src/pages/integrations/overview-clients.ts:118-150`). Make its status merge
match Claude/Grok: find `nativeCodex`, wait for `nativeSettled`, set
`toggle: "codex"`, `toggleBlocked`, `togglePath`, and `toggleOn` from that row,
and keep the badge/applied count based on observed `native.state`. The switch is
driven by required `native.desiredEnabled`; this is how a partial disable shows
OFF while the observed badge remains current/amber. When `native.reason` is
`external_provider_preserved`, use the localized detail key with the structured
provider name so the card says another provider owns routing instead of saying
opencodex is applied.

MODIFY `gui/src/pages/integrations/overview-clients.ts`:

```diff
 export interface OverviewRow {
@@
   applied: boolean;
+  /** Desired switch position; absent means use observed `applied`. */
+  toggleOn?: boolean;
@@
 }

-function codexRow(payload: CodexRoutingPayload | null): OverviewRow {
+function codexRow(
+  payload: CodexRoutingPayload | null,
+  native: NativeStatus | undefined,
+  nativeSettled: boolean,
+): OverviewRow {
   const base = {
@@
-    toggle: null,
-    toggleBlocked: null,
-    togglePath: null,
+    toggle: "codex" as const,
+    toggleBlocked: native?.disableBlocked ?? null,
+    togglePath: native?.configPath ?? null,
+    toggleOn: native?.desiredEnabled,
@@
+  if (!nativeSettled) return { ...base, state: "unknown", installed: false, applied: false, detailKey: null };
+  if (!native) return { ...base, toggle: null, state: "unknown", installed: false, applied: false, detailKey: null };
+  if (native.reason === "external_provider_preserved") {
+    return { ...base, state: native.state, installed: true, applied: false,
+      detail: null, detailKey: "integrations.native.msg.codexExternalProvider",
+      detailVars: { provider: native.externalProvider ?? "" } };
+  }
@@
 export function buildOverviewRows(sources: OverviewSources): OverviewRow[] {
+  const nativeCodex = sources.native?.find(status => status.clientId === "codex");
@@
-    codexRow(sources.codex),
+    codexRow(sources.codex, nativeCodex, sources.nativeSettled),
```

MODIFY the current switch/request sites at
`gui/src/pages/integrations/IntegrationsOverview.tsx:113-128,499-507`:

```diff
-              on={row.applied}
+              on={row.toggleOn ?? row.applied}
@@
-              label={row.applied
+              label={(row.toggleOn ?? row.applied)
@@
-              onToggle={row.toggle ? () => requestToggle(row, !row.applied) : null}
+              onToggle={row.toggle
+                ? () => requestToggle(row, !(row.toggleOn ?? row.applied))
+                : null}
```

WP6 consumes this `toggleOn` owner for Desktop. When rebased after WP5, WP6 drops
its duplicate interface-field hunk at `050_desktop_toggle.md:727-731` and keeps
only the Desktop-row use at `050_desktop_toggle.md:733-745`.

`IntegrationsOverview.tsx` adds `CODEX_DISABLE_COPY`, admits `codex` anywhere the
native toggle union is narrowed, refreshes `codexResource` after the mutation,
and chooses copy by `pendingToggle.id` instead of always rendering Grok's copy.

```diff
+const CODEX_DISABLE_COPY: ConsequenceCopy = {
+  titleKey: "integrations.dialog.codex.title",
+  changesKey: "integrations.dialog.codex.changes",
+  breakageKey: "integrations.dialog.codex.breakage",
+  undoKey: "integrations.dialog.codex.undo",
+  sideEffectKey: "integrations.dialog.codex.sideEffect",
+  confirmKey: "integrations.dialog.codex.confirm",
+};
@@
-      } else if (row.toggle === "claude" || row.toggle === "grok") {
+      } else if (row.toggle === "codex" || row.toggle === "claude" || row.toggle === "grok") {
@@
-    if (row.status || next || row.id === "claude" || row.toggle === null) {
+    if (row.status || next || row.id === "claude" || row.toggle === null) {
       void toggleCard(row, next);
       return;
     }
-    // Grok disable is the only native action that edits another program's file.
+    // Codex and Grok disable both alter another client's on-disk state and earn
+    // the consequence gate; Claude changes only our own flag and stays immediate.
@@
-          copy={{ ...GROK_DISABLE_COPY, vars: { path: pendingToggle.togglePath ?? "" } }}
+          copy={{
+            ...(pendingToggle.id === "codex" ? CODEX_DISABLE_COPY : GROK_DISABLE_COPY),
+            vars: { path: pendingToggle.togglePath ?? "" },
+          }}
```

The same `IntegrationsOverview.tsx` diff handles the Codex-only success caveat and
refreshes both observed sources:

```diff
+        } else if (result.reason === "external_provider_preserved") {
+          setCardResult(row.id, { tone: "ok", text: t(
+            "integrations.native.msg.codexExternalProvider",
+            { provider: result.externalProvider ?? "" },
+          ) });
+        }
@@
   const refreshNativeDetails = () => {
     nativeResource.refresh();
+    codexResource.refresh();
     claudeResource.refresh();
```

`gui/src/pages/integrations/native-api.ts` consumes WP3's complete mirror. WP3
replaces the current two-client union and runtime allowlist at lines `3` and
`51-62` with all four native clients, requires `desiredEnabled` on status and
success, and owns every shared refusal reason. WP5 does **not** repeat those
diffs. It only adds Codex-specific optional detail to the already-WP3-owned
status/success interfaces:

```diff
 export interface NativeStatus {
@@
+  reason?: "external_provider_preserved";
+  externalProvider?: string;
@@
 export interface NativeToggleEnvelope {
@@
+  externalProvider?: string;
+  artifacts?: CodexNativeRestoreArtifacts;
```

Define the GUI's structural `CodexNativeRestoreArtifacts` beside the envelope;
do not import a runtime type across the `src/`/`gui/` package boundary. The shape
matches the three server artifacts exactly and keeps `reason` typed as
`"busy" | "permission"` on history.

```ts
export interface CodexNativeRestoreArtifacts {
  config: {
    state: "ok" | "skipped" | "failed";
    changed: boolean;
    action: "journal-restored" | "owned-fields-stripped"
      | "external-provider-preserved" | "failed";
    message: string;
  };
  catalog: {
    state: "ok" | "skipped" | "failed";
    changed: boolean;
    removed: number;
    kept: number;
    path: string | null;
    message: string;
  };
  history: {
    state: "ok" | "skipped" | "failed";
    changed: boolean;
    reason?: "busy" | "permission";
    rows: number;
    files: number;
    ejectedRows: number;
    message: string;
  };
}
```

MODIFY `gui/src/pages/integrations/refusal-copy.ts` at the existing native reason
switch (`gui/src/pages/integrations/refusal-copy.ts:56-71`):

```diff
   if (refusal.reason === "not_installed") return t("integrations.native.error.notInstalled");
   if (refusal.reason === "config_busy") return t("integrations.native.error.configBusy");
+  if (refusal.reason === "history_busy") return t("integrations.native.error.historyBusy");
+  if (refusal.reason === "history_permission") return t("integrations.native.error.historyPermission");
   return refusal.message || t("integrations.error.generic");
```

The English source text is exact:

- `integrations.dialog.codex.title` — `Disable the Codex integration?`
- `integrations.dialog.codex.changes` — `opencodex will remove its routing from {path}, remove its generated profile, restore the native model catalog, and retag resumable threads for native Codex.`
- `integrations.dialog.codex.breakage` — `Plain codex will connect directly to OpenAI, and models routed from other providers will disappear from Codex. The proxy and /v1/responses stay running for other clients.`
- `integrations.dialog.codex.undo` — `Turning this back on rebuilds the routed catalog from the models available then and injects Codex again. Resume history is made usable in the matching direction, but its files are not restored byte for byte.`
- `integrations.dialog.codex.sideEffect` — `If you selected a routed root model after opencodex injected the config, disabling removes that model selection and turning the integration back on cannot reconstruct it; select the model again. If an external model_provider owns Codex, opencodex removes only its stale journal and leaves the config, catalog, and history unchanged.`
- `integrations.dialog.codex.confirm` — `Disable`

The model-selection sentence is deliberately stronger than the superseded copy.
The fallback strip removes any root slash-qualified `model = "provider/slug"`
after post-injection drift (`src/codex/inject.ts:315-327,688-705`), and no restore
record exists from which enable could rebuild it. Resume history is reversible in
provider meaning but appends/patches metadata rather than restoring bytes
(`src/codex/history-provider.ts:52-90,480-508`).

Refusal/success copy in `gui/src/pages/integrations/refusal-copy.ts` and the native
result branch:

- `history_busy` — `Codex routing is disabled, but routed threads are still hidden because Codex or an IDE is holding the history database. Close Codex and the IDE, then turn the integration off again.`
- `history_permission` — `Codex routing is disabled, but opencodex does not have permission to retag the history database. Fix the Codex history file permissions, then turn the integration off again.`
- `external_provider_preserved` — `Codex is using the external model provider {provider}. opencodex left its config, catalog, and history unchanged.`

`history_busy` and `history_permission` replace server prose by reason, just as
`orphaned_marker` and `config_busy` do today
(`gui/src/pages/integrations/refusal-copy.ts:56-71`). `write_failed` continues to
show the server's boundary-specific message. A refusal is rendered in the card's
notice area after the dialog closes; it never opens a second modal, matching the
established direction (`../../_fin/260803_integrations_toggle_all/002_consequence_dialog_ux.md:124-149`).

## i18n

Add these exact keys to all six locale files:

```text
integrations.dialog.codex.title
integrations.dialog.codex.changes
integrations.dialog.codex.breakage
integrations.dialog.codex.undo
integrations.dialog.codex.sideEffect
integrations.dialog.codex.confirm
integrations.native.error.historyBusy
integrations.native.error.historyPermission
integrations.native.msg.codexExternalProvider
```

`gui/src/i18n/en.ts` is the English source and `TKey` authority. Add matching
translations to `de.ts`, `ja.ts`, `ko.ts`, `ru.ts`, and `zh.ts`; do not hardcode
the dialog or refusal text in JSX (`gui/AGENTS.md:13-30`). `{path}` appears in
`changes`; `{provider}` appears in `codexExternalProvider`.

## Test plan

`tests/codex-history-provider.test.ts`:

1. `SQLITE_BUSY`, `SQLITE_LOCKED`, `EBUSY`, and the existing lock/busy message
   fallbacks classify as `busy`.
2. `EPERM`, `EACCES`, `operation not permitted`, and `permission denied` classify
   as `permission`.
3. Corruption/programming errors classify `null` and still throw.
4. Exhausted detailed retry preserves the last reason; exported
   `withHistoryRetry()` still returns `null` for compatibility.
5. `syncCodexHistoryProvider()` against a held real `BEGIN IMMEDIATE` transaction
   returns `failed: true, failureReason: "busy"`; an ACL/code fixture returns
   `permission`. The real lock case is the activation proof, not only a mocked object.

`tests/codex-journal.test.ts`:

1. A complete restore reports all three artifact objects and `success: true`.
2. A config failure, catalog failure, and history failure each name only that
   boundary and make aggregate success false.
3. External `model_provider = "custom"` removes only the journal, invokes neither
   catalog nor history mutation, and returns three structured skips.
4. A drifted post-injection root `model = "provider/slug"` is removed; reinjection
   does not recreate it. This pins the dialog's destructive sentence.
5. Desired-OFF reconciliation resumes from each partial boundary: config native
   with routed catalog/history; config+catalog native with routed history; and all
   native with only stale journal cleanup. Each re-run changes only remaining
   artifacts and ends converged.
6. Before-write desired assertions flip ON between each pair of artifact writes;
   the next boundary does not write and the structured result reports the exact
   completed/aborted artifacts.

`tests/codex-sync-api.test.ts` (the current structured-result owner at
`tests/codex-sync-api.test.ts:47-84`): desired OFF returns
`status:"skipped"/skippedReason:"desired_disabled"`; catalog fetch, catalog/cache
write, injection, history, and project-warning probes remain uncalled. A desired
flip during paused catalog discovery is observed at the lower before-write guard,
so no late catalog or config write lands after OFF.

`tests/native-codex-toggle.test.ts`:

1. GET includes `clientId: "codex"` and reports observed native/current/unsafe
   routing without reading desired intent as disk truth.
2. Missing WP3 flag defaults ON; explicit false survives a fresh config load.
3. Disable persists false, passes ownership, calls structured restore once, and
   never calls a stop/drain function.
4. Enable persists true and calls `syncModelsToCodex` with the running listener's
   port; a test fails if the route calls bare injection.
5. Held history returns HTTP 409, reason `history_busy`, code
   `native_integration_refused`; config/catalog are already native and desired OFF
   remains persisted. The response is never 200/green and never raw 500.
6. Permission failure returns HTTP 500, reason `history_permission`, code
   `native_integration_failed`, with no retry advice.
7. Home mismatch returns 409 after desired OFF is persisted and before any Codex
   artifact mutation.
8. External `custom` returns 200 `external_provider_preserved`; all three artifact
   states are skipped and the status row carries the courtesy message.
9. Invalid JSON/non-boolean bodies return 400; config-lock contention is 409 while
   an unopenable lock is 500, matching `tests/native-claude-code-toggle.test.ts:120-154`.
10. Start a real test proxy with another routed client, disable Codex through the
    management route, then POST that client's deliberately local fixture request
    to `/v1/responses` and assert its expected response. Also assert `/healthz`
    identifies the same PID before and after. This proves the shared endpoint and
    process stayed alive; checking only the PUT response would not prove C4.
11. GET and every 200 response require `desiredEnabled`; every post-persist
    refusal includes desired plus observed state. A schema/parser test fails if
    Codex, Claude, Desktop, or Grok disappears from WP3's four-client union.
12. Pause GUI enable in catalog fetch, issue CLI restore/OFF, then release the
    fetch. The shared Codex flight and lower before-write assertion permit no late
    catalog/config/history write. Repeat with startup and background refresh as
    the paused producer. Route-local-only exclusion fails this test.

`tests/cli-restore-back.test.ts` changes from source-string assertions
(`tests/cli-restore-back.test.ts:11-35`) to isolated process-level cases. Every child receives temporary
`OPENCODEX_HOME` and `CODEX_HOME`, `CI=1`, and a reserved non-10100 port; teardown
terminates only the recorded child PID and removes only those temporary roots.

1. Start desired OFF with native artifacts, run `ocx restore back`, and assert
   exit 0, desired ON on a fresh config load, routed config plus at least one
   routed catalog row, and no disabled-skip text. Restart that isolated proxy and
   assert desired remains ON and observed routing remains current.
2. Start desired ON/current, run `ocx restore`, and assert exit 0, desired OFF on
   a fresh config load, native config/catalog/history, and the explicit OFF
   sentence. Restart and assert startup reconciliation leaves desired OFF and
   observed native.
3. Force the distinct disabled result after `restore back`'s initial liveness
   check through the coordinator seam. Assert it never prints “now routes”, exits
   2, and reports the competing OFF. An attempted artifact failure exits 1.
4. Run `ocx sync` while OFF: exit 0 with explicit skipped copy and no Codex file
   timestamp change. Exercise startup, ensure, custom-model, provider `--sync`,
   and `ocx system sync` to pin every caller outcome in the table above.

GUI tests:

1. `gui/tests/integrations-overview-rows.test.ts` — settled native Codex gains a
   toggle/path/blocker; required desired state drives `toggleOn` while observed
   state drives badge/count; missing or unsettled native evidence remains unknown
   with no active switch; external provider renders the courtesy detail and no
   applied claim.
2. `gui/tests/overview-state-merge.test.ts` — widen client/reason validators and
   prove localized `history_busy` and `history_permission`; keep raw
   `write_failed` detail.
3. `gui/tests/consequence-dialog.test.tsx` — render the Codex copy in slot order,
   assert the root-model loss, non-byte-identical history, external-provider
   courtesy, and `/v1/responses` survival sentences, plus focus return and the
   pending double-submit guard already tested for Grok.

## Verification

Static and automated gates:

```bash
bun run typecheck
bun test tests/codex-history-provider.test.ts tests/codex-journal.test.ts tests/codex-sync-api.test.ts tests/native-codex-toggle.test.ts tests/cli-restore-back.test.ts
bun run test
cd gui && bun test tests && bun run lint && bun run lint:i18n && bun run build
cd .. && bun run privacy:scan
```

No C-gate command targets the user's proxy on port 10100 or the user's real
Codex home. The process-level CLI/restart tests above are the activation proof:
they launch a recorded child on a reserved non-10100 port with temporary
`OPENCODEX_HOME`/`CODEX_HOME`, drive both restore directions, terminate that child,
restart it, and inspect the emitted config/catalog/history. The held-history case
uses a real `BEGIN IMMEDIATE` lock against the temporary `state_5.sqlite`, then
retries after releasing it. This proves 409 busy versus 500 permission without
opening the installed Codex app or mutating live state.

Render grounding uses an isolated test server and temporary Codex home. Open the
Integrations overview, keyboard-activate Codex OFF, capture desktop and constrained
width screenshots, and read them back. The dialog must show root-model destruction,
non-byte-identical history, external-provider courtesy, and `/v1/responses`
survival before confirmation. After a forced history-busy response, the switch
must show desired OFF while the observed card remains partial; after retry it must
show observed native. No browser run confirms against port 10100.

## Accept criteria

- **C5 — Codex toggles both directions from the overview with the proxy running.**
  Disable calls structured `restoreNativeCodex`; enable calls
  `syncModelsToCodex(runtimePort)`. Isolated-process GET and on-disk catalog/config evidence
  agree after both directions, and no stop/drain path runs.
- **CLI has the same durable meaning.** `ocx restore` persists OFF and
  `ocx restore back` persists ON. The process-level test restarts after each and
  proves the chosen state remains observed. A disabled sync is explicitly
  `status:"skipped"`; no caller prints an applied claim, and exit 0/1/2 follows
  the caller table rather than `ok` alone.
- **C6 — a held history DB is explained, never false green.** A real held lock
  yields `409 native_integration_refused / history_busy`; config and catalog are
  reported separately, desired OFF persists, the card says why routed threads
  remain hidden, and no layer parses `message`.
- **C4 — other clients keep serving.** The proxy PID/health identity is unchanged
  across disable and enable, `/v1/responses` remains registered, and another
  client's fixture request completes while Codex is OFF.
- **OFF converges and ON cannot write late.** Startup re-runs the remover from
  every config/catalog/history partial state. The shared Codex flight covers GUI,
  CLI, startup, and background producers, and persisted desired state is re-read
  immediately before every irreversible write.
- **WP3's contract remains singular.** Server and GUI status/success shapes always
  include required `desiredEnabled`; WP5 declares no competing native-client
  union or refusal helper. WP5 lands before WP6 in every overlapping file.
- External `model_provider` ownership remains untouched and visible on the card;
  resume history is described as semantically reversible, not byte-identical;
  and the dialog states that a post-injection routed root model selection is
  destroyed and cannot be reconstructed.

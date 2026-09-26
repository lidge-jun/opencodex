# 030 — wp4 Management API and CLI (diff-level build contract)

## Goal and boundary

Expose the independent CLI first-party intent through `/api/claude-code`, the `ocx claude config` command, `ocx ensure`, capability discovery, and the native `ocx claude` escape hatch. This phase consumes wp2's `cliFirstParty`, `firstPartyDesired`, `reconcileClaudeFirstPartySettings`, and union-preserving `removeDesktopFirstParty(config)`; wp3 supplies live client routing. **IN:** those consumers, deterministic tests, and generated skill surface. **OUT:** schema/ownership writer implementation (wp2), listener classification (wp3), GUI/docs copy (wp5), live user settings or a proxy run during planning. Preserve D1–D9 and the accepted shared-settings limitation in `000_plan.md`.

Build order: land wp2 and wp3 first; implement management preflight/save/reconcile, ensure, parser/capabilities, native launch; run focused tests and the generated-surface check. The status classifier below specifies wp2's export; the management diffs consume it. Re-read line numbers after prior phases land.

### Replan G observed-status contract (wp2 classifier, wp4 emitter, wp5 selector)

The exported wp2 type has exactly these values; wp4 and wp5 import it rather than declaring another union:

```ts
export type FirstPartyProxyStatus = "none" | "live" | "stopped" | "disabled" | "broken" | "foreign" | "local" | "unknown";
```

The classifier's one executable definition is the wp2 diff of `src/claude/first-party-settings.ts` in `010_foundations.md` (guarded URL parse: a malformed or out-of-range port yields `broken`). This document only consumes it through `readFirstPartyProxyStatus`.

The wp5 notice selector, normalization and exhaustiveness constant are defined once in `040_surfaces.md` (`gui/src/pages/claude-code-first-party.ts`); wp4 guarantees the GET enum and `interceptEligible` boolean they consume. Precedence (informative): unknown, foreign, local, residual (no client desired and `sharedProxy !== "none"`), disabled, routingOff for stopped/broken with ineligible routing, stopped, broken, notApplied, shared, null. The classifier above remains unchanged: `stopped` and `broken` describe settings/listener observation even when routing is ineligible. GUI normalizes a missing `interceptEligible` to `true` for older caches, and explicit values with `=== true`.

GUI normalization, notice copy and the ten catalog payloads are owned by `040_surfaces.md`; this phase emits the GET enum and eligibility bit plus the PUT `warnings` codes. `FirstPartyNotice` gains `routingOff`; its cause-neutral copy is defined only in `040_surfaces.md` and covers `claudeCode.enabled === false`, `claudeCode.intercept.enabled === false`, and `runtimeRole === "client"`. `stopped` (eligible only) tells the user to start opencodex; `broken` (eligible only) retains "run ocx ensure or restart opencodex". The `disabled` notice still describes a bound listener with usable settings and ineligible routing.

## File change map

| Path | Change | Purpose |
|---|---|---|
| `src/server/management/agent-settings-routes.ts` | MODIFY | GET state; PUT preflight, persist, reconcile, rollback |
| `src/server/management/context.ts` | MODIFY | narrow injected intercept-state getter for port-mismatch route test |
| `src/cli/ensure-desired-integrations.ts` | MODIFY | refresh CLI intent; Desktop-off cleanup preserves CLI env |
| `src/cli/integrations.ts` | MODIFY | `--first-party on\|off` parser and usage |
| `src/cli/capabilities.ts` | MODIFY | declare `claude config` GET/PUT |
| `src/cli/claude.ts` | MODIFY | native launch bypasses an owned settings intercept |
| `structure/gui-and-management-api.md` | MODIFY | document GET status and field-scoped PUT contract in the same phase as the management route |
| `tests/claude-integration/claude-management-api.test.ts` | MODIFY | API state/refusal/rollback tests in isolated homes |
| `tests/claude-integration/claude-cli.test.ts` | MODIFY | pure native-env tests |
| `tests/cli/ensure-desired-integrations-race.test.ts` | MODIFY | CLI-only ensure and Desktop-off preservation |
| `tests/cli/claude-config-first-party.test.ts` | NEW | parser request/validation test |
| `tests/cli/cli-capabilities.test.ts` | MODIFY | remove two ratchet entries, assert declaration |
| `scripts/test-layout/layout.json` | MODIFY | explicit new parser test domain |
| `tests/fixtures/test-layout-expected.json` | MODIFY | expected new parser test domain |
| `skills/ocx/references/01_management_surface.md` | MODIFY, GENERATED | `bun run skill:surface` output |
| `structure/runtime.md` | MODIFY | ocx claude native NO_PROXY behaviour (wp4 P amendment) |
| `structure/config.md` | MODIFY | cliFirstParty writers (wp4 P amendment) |
| `structure/clients/claude-desktop.md` | MODIFY | CLI intent surfaces and ensure refresh (wp4 P amendment) |
| `structure/ops/docs-and-release.md` | MODIFY if it enumerates capabilities | claude config declared (wp4 P amendment) |

## Source-anchored edits

### Management API

`src/server/management/agent-settings-routes.ts:1450` currently says `return jsonResponse({`; `:1451` says `enabled: config.claudeCode?.enabled !== false,`. Add GET fields from the *current* shared-settings inspection, never infer application from intent:

```diff
@@ GET /api/claude-code, before return jsonResponse
+    const { firstPartyDesired, readFirstPartyProxyStatus } = await import("../../claude/first-party-settings");
+    const { observeClaudeDesktopMode } = await import("../../claude/desktop-first-party");
+    const { claudeInterceptEnabled, getClaudeInterceptState } = await import("../../claude/intercept/runtime");
+    const desired = firstPartyDesired(config, observeClaudeDesktopMode(config));
+    const bound = (deps.getClaudeInterceptState ?? getClaudeInterceptState)();
+    const eligible = claudeInterceptEnabled(config);
+    const sharedProxy = readFirstPartyProxyStatus(config, bound?.proxyPort ?? null);
+    const interceptRunning = bound !== null && eligible;
     return jsonResponse({
       enabled: config.claudeCode?.enabled !== false,
+      cliFirstParty: config.claudeCode?.cliFirstParty === true,
+      cliFirstPartyApplied: config.claudeCode?.cliFirstParty === true && sharedProxy === "live",
+      desktopFirstParty: desired.desktop,
+      interceptEligible: eligible,
+      interceptRunning,
+      sharedProxy,
```

GET observes settings read-only through the ordered classifier above. Unreadable settings are `unknown`; absent settings and a CA-only stale env are `none`. A loopback proxy URL with foreign CA is `foreign` when its userinfo carries `opencodex:`, otherwise `local`, including a legacy tokenless URL. An owned-shaped URL without a bound listener is `stopped`. With a listener, only applied settings at its port are usable: usable plus ineligible is `disabled`; stale or port-mismatched settings are `broken` even when ineligible; usable plus eligible is `live`. `interceptEligible` is the `claudeInterceptEnabled(config)` result used for this same `sharedProxy`/`interceptRunning` snapshot; `interceptRunning` remains `bound !== null && eligible`. A disabled-but-bound listener relays requests unchanged until restart; `interceptRunning:false`. Only `live` with CLI intent reports `cliFirstPartyApplied:true`. The injected listener-state seam makes the bound cases reachable in isolated route tests.

`src/server/management/agent-settings-routes.ts:1508` has the explicit body type; `:1586` clones `next`; `:1747–1755` saves ordinary PUT fields. Immediately after parsing and validating the `cliFirstParty` type, reject every body that combines it with another key, before any mutation. A standalone CLI-on request checks the live intercept and bound port before taking the config lock as a fast path. The authoritative eligibility and port checks run inside the `mutatePersistedConfig` callback against the latest persisted config; a refusal returns `changed:false`, so neither config nor settings are written. On success, observe Desktop mode on that same persisted snapshot, pin an absent `desktopMode`, and set `cliFirstParty:true` in one mutation. Adopt the committed Claude block and reconcile. `commitClaudeCodeBlock` stamps the migration sentinel; a standalone first-party body skips the later whole-config save. A failed reconcile conditionally restores only the two fields this request wrote. Other concurrently edited fields and `fastMode` are never part of this rollback. Map wp2 failure reasons without disclosing settings contents.

```diff
@@ body type and validation
-    const body = parsedBody as { enabled?: unknown; authMode?: unknown; model?: unknown; smallFastModel?: unknown; modelMap?: unknown; classifierModel?: unknown; classifierFallbacks?: unknown; systemEnv?: unknown; fastMode?: unknown; maxContextTokens?: unknown; alwaysEnableEffort?: unknown; tierModels?: unknown; autoContext?: unknown; autoCompactWindow?: unknown; blockedSkills?: unknown; injectAgents?: unknown; webSearchSidecar?: unknown; visionSidecar?: unknown };
+    const body = parsedBody as { enabled?: unknown; cliFirstParty?: unknown; authMode?: unknown; model?: unknown; smallFastModel?: unknown; modelMap?: unknown; classifierModel?: unknown; classifierFallbacks?: unknown; systemEnv?: unknown; fastMode?: unknown; maxContextTokens?: unknown; alwaysEnableEffort?: unknown; tierModels?: unknown; autoContext?: unknown; autoCompactWindow?: unknown; blockedSkills?: unknown; injectAgents?: unknown; webSearchSidecar?: unknown; visionSidecar?: unknown };
+    if (body.cliFirstParty !== undefined && typeof body.cliFirstParty !== "boolean")
+      return jsonResponse({ error: "cliFirstParty must be a boolean" }, 400);
@@ immediately after the cliFirstParty type guard, before sidecar and enabled handling
+    if (body.cliFirstParty !== undefined && Object.keys(body).length !== 1)
+      return jsonResponse({ error: "cliFirstParty must be sent alone", code: "cli_first_party_not_alone" }, 400);
+    if (body.cliFirstParty !== undefined) {
+      const { claudeInterceptEnabled, claudeInterceptProxyPort, getClaudeInterceptState } = await import("../../claude/intercept/runtime");
+      const { captureDesktopFirstPartyRollback, inspectDesktopFirstParty, observeClaudeDesktopMode, resolveClaudeDesktopMode } = await import("../../claude/desktop-first-party");
+      const { firstPartyDesired, readFirstPartyProxyStatus, reconcileClaudeFirstPartySettings } = await import("../../claude/first-party-settings");
+      const { commitClaudeCodeBlock } = await import("../../claude/claude-code-block");
+      const bound = (deps.getClaudeInterceptState ?? getClaudeInterceptState)();
+      if (body.cliFirstParty) {
+        if (!claudeInterceptEnabled(config)) return jsonResponse({ error: "Claude intercept is disabled", code: "intercept_disabled" }, 409);
+        if (bound === null) return jsonResponse({ error: "Claude intercept is unavailable", code: "intercept_unavailable" }, 409);
+        // Fast path only. The locked callback below repeats this on persisted config.
+        const targetPort = claudeInterceptProxyPort(config, config.port ?? 10100);
+        if (targetPort !== bound.proxyPort) return jsonResponse({
+          error: `Claude intercept port mismatch (configured ${targetPort}, bound ${bound.proxyPort}); restart needed`,
+          code: "intercept_unavailable",
+        }, 409);
+        const inspection = inspectDesktopFirstParty(config).settings;
+        if (inspection.kind === "foreign") return jsonResponse({ error: "Claude settings env is foreign", code: "foreign_env" }, 409);
+        if (inspection.kind === "unreadable") return jsonResponse({ error: "Claude settings are unreadable", code: "unreadable" }, 500);
+      }
+      const restoreSettings = body.cliFirstParty ? captureDesktopFirstPartyRollback(config) : undefined;
+      // One mutation writes only cliFirstParty and, for ON, an absent desktopMode.
+      // Capture previous key presence and the pinned mode in the mutation result.
+      const outcome = mutatePersistedConfig(persisted => {
+        if (body.cliFirstParty) {
+          if (!claudeInterceptEnabled(persisted)) return { changed: false, value: {
+            refusal: { error: "Claude intercept is disabled", code: "intercept_disabled" as const } } };
+          const persistedPort = claudeInterceptProxyPort(persisted, persisted.port ?? 10100);
+          if (bound === null || persistedPort !== bound.proxyPort) return { changed: false, value: {
+            refusal: { error: `Claude intercept port mismatch (configured ${persistedPort}, bound ${bound?.proxyPort ?? "none"}); restart needed`,
+              code: "intercept_unavailable" as const } } };
+        }
+        const before = structuredClone(persisted);
+        const previous = { present: Object.hasOwn(persisted.claudeCode ?? {}, "cliFirstParty"),
+          value: persisted.claudeCode?.cliFirstParty === true };
+        const pinnedMode = body.cliFirstParty && persisted.claudeCode?.desktopMode === undefined
+          ? resolveClaudeDesktopMode(before, observeClaudeDesktopMode(before)) : undefined;
+        const nextBlock = { ...(persisted.claudeCode ?? {}) };
+        if (body.cliFirstParty) nextBlock.cliFirstParty = true;
+        else delete nextBlock.cliFirstParty;
+        if (pinnedMode) nextBlock.desktopMode = pinnedMode;
+        commitClaudeCodeBlock(persisted, nextBlock);
+        return { changed: true, value: { claudeCode: structuredClone(persisted.claudeCode), previous, pinnedMode } };
+      });
+      if (outcome.status === "unavailable") return jsonResponse({ error: "Could not save Claude settings", code: "write_failed" }, 500);
+      if ("refusal" in outcome.value) return jsonResponse(outcome.value.refusal, 409);
+      adoptPersistedClaudeCode(config, outcome.value.claudeCode);
+      // Pin these committed leaves on the live snapshot, preserving unrelated leaves.
+      const live = { ...(config.claudeCode ?? {}) };
+      if (body.cliFirstParty) live.cliFirstParty = true; else delete live.cliFirstParty;
+      if (outcome.value.pinnedMode) live.desktopMode = outcome.value.pinnedMode;
+      config.claudeCode = live;
+      let result: ReturnType<typeof reconcileClaudeFirstPartySettings> | undefined;
+      try { result = reconcileClaudeFirstPartySettings(config,
+        firstPartyDesired(config, observeClaudeDesktopMode(config))); }
+      catch { /* map unexpected write failure to write_failed after rollback */ }
+      if (!result?.ok) {
+        let settingsRestored = true;
+        if (body.cliFirstParty) {
+          settingsRestored = restoreSettings?.() ?? false;
+          const rollback = mutatePersistedConfig(persisted => {
+            const block = { ...(persisted.claudeCode ?? {}) };
+            if (block.cliFirstParty === true) {
+              if (outcome.value.previous.present) block.cliFirstParty = outcome.value.previous.value;
+              else delete block.cliFirstParty;
+            }
+            if (outcome.value.pinnedMode && block.desktopMode === outcome.value.pinnedMode)
+              delete block.desktopMode;
+            persisted.claudeCode = block;
+            return { changed: true, value: structuredClone(block) };
+          });
+          if (rollback.status === "unavailable") return jsonResponse({ error: "Claude settings rollback failed", code: "write_failed" }, 500);
+          adoptPersistedClaudeCode(config, rollback.value);
+        }
+        const code = result?.reason ?? "write_failed";
+        return jsonResponse({ error: "Claude first-party reconciliation failed", code,
+          ...(!body.cliFirstParty && code === "unreadable"
+            ? { cliFirstParty: false, warnings: ["settings_residual"] } : {}),
+          ...(body.cliFirstParty && !settingsRestored
+            ? { warnings: ["settings_rollback_incomplete"] } : {}) },
+          code === "intercept_disabled" || code === "foreign_env" ? 409 : 500);
+      }
+      // After a successful nothing-desired reconcile, report any non-none
+      // observed status as residue without rewriting settings.
+      const finalDesired = firstPartyDesired(config, observeClaudeDesktopMode(config));
+      const residual = !finalDesired.desktop && !finalDesired.cli
+        && readFirstPartyProxyStatus(config, bound?.proxyPort ?? null) !== "none";
+      const firstPartyWarnings = residual ? ["settings_residual"] : [];
+      return jsonResponse({ ok: true, enabled: config.claudeCode?.enabled !== false,
+        cliFirstParty: body.cliFirstParty, warnings: firstPartyWarnings });
+    }
@@ existing :1747-1755 save for ordinary fields; standalone cliFirstParty returned above
     commitClaudeCodeBlock(config, next);
     save(config);
     const warnings: string[] = [];
```

Add `getClaudeInterceptState?: typeof import("../../claude/intercept/runtime").getClaudeInterceptState` to `ManagementApiDeps` in `src/server/management/context.ts`. Both GET and PUT use `(deps.getClaudeInterceptState ?? getClaudeInterceptState)()`; the seam makes `live`, `stopped`, and `broken` reachable through `startServer(0, { managementApi: { getClaudeInterceptState } })` without binding an intercept pair. The mismatch test changes the temp config file's `intercept.port` after server start, leaves the seam bound to the old port, and checks 409 plus unchanged config and settings. The CLI-on success test supplies the matching bound port and checks 200 plus written settings. The same seam supports GET `disabled` with a bound port and disabled config, while a malformed settings file yields `unknown` and a token URL with foreign CA yields `foreign`. Production uses the real getter. The pre-lock check is only an early refusal: the persisted callback makes the commit decision, and neither path mints a token before refusal.

The pseudo-diff shows the mutation boundary; map thrown inspection or mutation errors to `unreadable`/`write_failed` without leaking file contents. Reconciliation failure after CLI-on restores only `cliFirstParty` and a mode pinned by this request, and only while each still equals its written value. Re-adopt and pin the restored leaves in live config. If conditional rollback cannot persist, return `write_failed` and report residual state without secrets. CLI-off deletes the field, adopts, then reconciles; an unreadable cleanup leaves off persisted and returns the coded 500. Successful removal with neither client desired returns 200 with `settings_residual` whenever `readFirstPartyProxyStatus(config, bound?.proxyPort ?? null) !== "none"`, including legacy tokenless loopback URLs with foreign CA (`local`), token-owned foreign CA (`foreign`), older-port (`broken`), and bound-but-disabled residue. An unreadable file follows the existing coded 500 path rather than a successful response. `{enabled:false}` alone does not reconcile or remove an env (M4); `{enabled:false,cliFirstParty:true}` returns 400 `cli_first_party_not_alone` before saving anything. `{cliFirstParty:false}` retains the shared env whenever Desktop remains desired, independent of intercept liveness. This route has no `intercept` body field (`:1508`).

### Ensure

`src/cli/ensure-desired-integrations.ts:146` currently gates on Desktop integration; `:158` returns for any non-stale env; `:182` calls `removeDesktopFirstParty()` without config. CLI intent must refresh absent **and** stale settings even when Desktop is off or gateway. Read the persisted config immediately before the mutation, as the file's `:4–9` contract requires.

```diff
@@ imports
+import { cliFirstPartyDesired, firstPartyDesired, reconcileClaudeFirstPartySettings } from "../claude/first-party-settings";
+import { claudeInterceptEnabled } from "../claude/intercept/runtime";
@@ after const { log, error } = io(deps)
+  if (cliFirstPartyDesired(config)) {
+    const seen = (deps.inspectDesktopFirstParty ?? inspectDesktopFirstParty)(config);
+    if (seen.settings.kind === "absent" || seen.stale || !claudeInterceptEnabled(config)) {
+      const result = reconcileClaudeFirstPartySettings(config,
+        firstPartyDesired(config, (deps.observeClaudeDesktopMode ?? observeClaudeDesktopMode)(config)));
+      if (result.ok && result.changed) log(`   + Claude CLI first-party env refreshed (${result.path})`);
+      else if (!result.ok) error(`⚠️  Claude CLI first-party env refresh skipped: ${result.reason}.`);
+    }
+  }
@@ Desktop OFF cleanup at :182
-    const env = (deps.removeDesktopFirstParty ?? removeDesktopFirstParty)();
+    const env = (deps.removeDesktopFirstParty ?? removeDesktopFirstParty)(config);
+    if (env.ok && env.retainedFor === "cli") log("   = Claude CLI first-party env retained.");
```

Do not let the existing Desktop gateway-profile conflict at `:151–156` skip the CLI refresh; it is deliberately before that branch. wp2 changes the remover signature and its other callers.

### Parser and capabilities

`src/cli/integrations.ts:18` shows the set usage; `:76` parses `--enabled`; `:91` writes `body.enabled`. Use the existing `takeBooleanOption` validation and the same PUT.

```diff
-  ocx claude config set [--enabled <on|off>] [--auth-mode <auto|proxy|subscription>]
+  ocx claude config set [--enabled <on|off>] [--first-party <on|off>] [--auth-mode <auto|proxy|subscription>]
@@ parser
     const enabled = takeBooleanOption(args, "--enabled");
+    const firstParty = takeBooleanOption(args, "--first-party");
@@ body
     if (enabled !== undefined) body.enabled = enabled;
+    if (firstParty !== undefined) body.cliFirstParty = firstParty;
```

`src/cli/capabilities.ts:839–840` begins the neighbouring Claude entries. `Capability` shape is at `:46–57`; this entry must describe the full existing `claude config` surface, including both GET and PUT. `json:"payload"` matches the command's `printData` path; `mutates:true` covers `set`.

```diff
@@ before command ["claude", "desktop", "status"]
+  {
+    command: ["claude", "config"],
+    summary: "Read or update Claude Code settings, including independent CLI first-party routing.",
+    routes: [{ method: "GET", path: "/api/claude-code" }, { method: "PUT", path: "/api/claude-code" }],
+    flags: [
+      { name: "--first-party", value: "string", summary: "For `set`, on or off; route standalone Claude CLI subscription requests through the intercept." },
+      { name: "--json", value: "boolean", summary: "Emit the management response as JSON." },
+    ],
+    mutates: true,
+    json: "payload",
+    details: ["`status` reads the route; `set` writes only submitted fields. Enabling first-party requires a running Claude intercept."],
+  },
```

The generator reads `CAPABILITIES` (`scripts/generate-ocx-skill-surface.ts:15–17,50–82`). After applying the entry, run `bun run skill:surface`. The generated file currently ends with `declared capabilities: 63` and `state-changing: 33` (`skills/ocx/references/01_management_surface.md`, Counts); expected generated diff is one state-changing `ocx claude config` section, GET and PUT route rows, the two flags, and:

```diff
- declared capabilities: 63
- of those, state-changing: 33
+ declared capabilities: 64
+ of those, state-changing: 34
```

No hand editing. `tests/cli/cli-capabilities.test.ts:217,311` currently carry the two undeclared-route debt entries:

```diff
-  "GET /api/claude-code",
-  "PUT /api/claude-code",
@@ route declaration test
+  const claudeConfig = capabilitiesForRoute("/api/claude-code").find(cap => capabilityInvocation(cap) === "ocx claude config");
+  expect(claudeConfig?.routes).toEqual([{ method: "GET", path: "/api/claude-code" },
+    { method: "PUT", path: "/api/claude-code" }]);
```

### Structure contract (M1, owned by wp4)

Move the `structure/gui-and-management-api.md` paragraph from `040_surfaces.md` §structure into this phase's change. At current `structure/gui-and-management-api.md:197`, after the Grok and Claude integrations table row, add:

```diff
@@ after the Grok and Claude integrations row
+
+`GET /api/claude-code` reports `cliFirstParty`, `desktopFirstParty`, `cliFirstPartyApplied`, `interceptEligible`, `interceptRunning`, and the eight-value `sharedProxy: FirstPartyProxyStatus` from observed settings and the bound listener. `interceptEligible = claudeInterceptEnabled(config)` uses the same GET snapshot as `sharedProxy` and `interceptRunning`; the latter remains bound listener present AND eligible. The ordered classifier gives unreadable → `unknown`, absent or non-loopback URL → `none`, foreign CA with an opencodex token → `foreign`, foreign CA with a tokenless loopback URL → `local`, no bound listener → `stopped`, ineligible applied settings at the bound port → `disabled`, other ineligible or stale/mismatched settings → `broken`, and eligible applied settings at the bound port → `live`. `cliFirstPartyApplied` requires CLI intent and `live`. `PUT /api/claude-code` accepts standalone `cliFirstParty`; CLI-on repeats eligibility and port checks inside the locked persisted mutation, reconciles, and conditionally rolls back its own fields on failure. CLI-off deletes intent but retains an env Desktop still desires. A successful nothing-desired reconcile returns `settings_residual` for every status except `none`, including `local`; unreadable cleanup returns the coded 500. `enabled:false` alone leaves the env untouched, and a mixed body returns 400 before save. GUI normalization maps only missing `sharedProxy:undefined` to `none`, invalid statuses including `null` to `unknown`; `interceptEligible:undefined` from an older cache maps to `true`, while present values use `=== true`. The source coverage map checks all eight statuses. Notice order is unknown, foreign, local, residual when undesired, disabled, routingOff for stopped/broken with ineligible routing, stopped, broken, notApplied, shared, null. Unknown copy states uncertainty, local copy names the unconfirmed 127.0.0.1 proxy and manual HTTPS_PROXY removal, disabled copy retains the first-party-off remedy, foreign copy directs manual CA/proxy repair, routingOff says to restore Claude routing or turn first-party off, stopped says to start opencodex, and eligible broken advises `ocx ensure` or restart.
```

The GUI's warning is delivered in wp5; this paragraph states the management contract now, in the same phase as its source. Main removes the duplicate paragraph from `040_surfaces.md` §structure when integrating the phase documents. `bun run structure:check` must pass after the wp4 source/doc change.

### Native `ocx claude`

`src/cli/claude.ts:610–615` builds the pure native env; `:825` passes it to the spawn path. `inspectDesktopFirstParty` in `desktop-first-party.ts:175–176` calls the required `inspectClaudeInterceptSettings` with the owned expected values. Inject only its discriminated result into the pure seam; do not read files there.

```diff
@@ imports
+import { inspectDesktopFirstParty } from "../claude/desktop-first-party";
+import { isClaudeInterceptProxyUrl, type ClaudeInterceptSettingsState } from "../claude/intercept/settings";
@@ ClaudeEnvDeps
+  ownedInterceptSettings?: ClaudeInterceptSettingsState;
+  warn?: (line: string) => void;
@@ buildNativeClaudeEnv after const env
+  const owned = deps.ownedInterceptSettings;
+  // Only an opencodex proxy that is actually present needs bypassing; a CA-only stale env must not
+  // override an inherited ALL_PROXY/HTTP_PROXY the user relies on.
+  if ((owned?.kind === "applied" || owned?.kind === "stale") && isClaudeInterceptProxyUrl(owned.env.HTTPS_PROXY)) {
+    const expected = owned.env.HTTPS_PROXY;
+    const foreignInheritedProxy = [env.HTTPS_PROXY, env.https_proxy].some(value =>
+      value !== undefined && value !== "" && value !== expected);
+    if (foreignInheritedProxy) {
+      deps.warn?.("⚠ Claude settings-owned intercept proxy still applies. Turn Desktop/CLI first-party off or unset the foreign HTTPS_PROXY/https_proxy to use native Claude.");
+    } else {
+      env.NO_PROXY = "*";
+      env.no_proxy = "*";
+      if (expected !== undefined && env.HTTPS_PROXY === expected) delete env.HTTPS_PROXY;
+      if (expected !== undefined && env.https_proxy === expected) delete env.https_proxy;
+      if (owned.env.NODE_EXTRA_CA_CERTS !== undefined && env.NODE_EXTRA_CA_CERTS === owned.env.NODE_EXTRA_CA_CERTS)
+        delete env.NODE_EXTRA_CA_CERTS;
+    }
+  }
@@ launchNativeClaude
-  const env = buildNativeClaudeEnv(config, process.env, { allowRootSkipPermissions });
+  const env = buildNativeClaudeEnv(config, process.env, {
+    allowRootSkipPermissions, ownedInterceptSettings: inspectDesktopFirstParty(config).settings,
+    warn: line => console.error(line),
+  });
```

Foreign, absent, and unreadable settings never set `NO_PROXY`; inherited values survive. Even with owned settings, either inherited proxy spelling holding a non-owned value blocks the bypass: leave inherited proxy, CA, and `NO_PROXY` values intact and print exactly one warning line. Owned stale values are compared to the *observed* pair, so only equal inherited values are dropped. The `*` guard is a local launch override, not a network security boundary.

### Test and layout edits

The wp2 classifier and wp5 selector each get a table-driven pure test. The following table is also a standalone verification fixture for the two executable definitions above; the fixture's URL predicate is the current `src/claude/intercept/settings.ts` predicate. Keep the actual tests in their owning phase files.

```ts
const isClaudeInterceptProxyUrl = (value: unknown): value is string =>
  typeof value === "string" && /^http:\/\/(?:opencodex:[^@/]+@)?127\.0\.0\.1:\d{1,5}\/?$/.test(value.trim());
const token = "http://opencodex:t@127.0.0.1:10200";
const applied = { kind: "applied", env: { HTTPS_PROXY: token, NODE_EXTRA_CA_CERTS: "/owned.pem" } } as const;
const stale = { kind: "stale", env: { HTTPS_PROXY: token, NODE_EXTRA_CA_CERTS: "/owned.pem" } } as const;
const foreign = { kind: "foreign", env: { HTTPS_PROXY: token, NODE_EXTRA_CA_CERTS: "/foreign.pem" } } as const;
const classifierCases = [
  ["unreadable wins", { settings: { kind: "unreadable", path: "/settings" }, boundProxyPort: 10200, eligible: true }, "unknown"],
  ["absent wins", { settings: { kind: "absent" }, boundProxyPort: 10200, eligible: true }, "none"],
  ["CA only", { settings: { kind: "stale", env: { NODE_EXTRA_CA_CERTS: "/owned.pem" } }, boundProxyPort: 10200, eligible: true }, "none"],
  ["non-local URL", { settings: { kind: "foreign", env: { HTTPS_PROXY: "https://elsewhere:443", NODE_EXTRA_CA_CERTS: "/foreign.pem" } }, boundProxyPort: 10200, eligible: true }, "none"],
  ["tokenless local with foreign CA", { settings: { kind: "foreign", env: { HTTPS_PROXY: "http://127.0.0.1:10200", NODE_EXTRA_CA_CERTS: "/foreign.pem" } }, boundProxyPort: 10200, eligible: true }, "local"],
  ["token with foreign CA", { settings: foreign, boundProxyPort: 10200, eligible: true }, "foreign"],
  ["stopped precedes disabled", { settings: applied, boundProxyPort: null, eligible: false }, "stopped"],
  ["stopped eligible", { settings: stale, boundProxyPort: null, eligible: true }, "stopped"],
  ["bound disabled", { settings: applied, boundProxyPort: 10200, eligible: false }, "disabled"],
  ["ineligible older port", { settings: { kind: "stale", env: { HTTPS_PROXY: "http://opencodex:t@127.0.0.1:10199", NODE_EXTRA_CA_CERTS: "/owned.pem" } }, boundProxyPort: 10200, eligible: false }, "broken"],
  ["ineligible token drift", { settings: stale, boundProxyPort: 10200, eligible: false }, "broken"],
  ["applied matching", { settings: applied, boundProxyPort: 10200, eligible: true }, "live"],
  ["explicit port 80", { settings: { kind: "applied", env: { HTTPS_PROXY: "http://opencodex:t@127.0.0.1:80", NODE_EXTRA_CA_CERTS: "/owned.pem" } }, boundProxyPort: 80, eligible: true }, "live"],
  ["applied port drift", { settings: applied, boundProxyPort: 10201, eligible: true }, "broken"],
  ["stale even on matching port", { settings: stale, boundProxyPort: 10200, eligible: true }, "broken"],
] as const;
// Columns: neither client, CLI only, Desktop only, both clients.
// An omitted ineligible row uses the eligible row; stopped/broken exercise both.
const selectorExpected = {
  none: { eligible: [null, "notApplied", null, "notApplied"] },
  live: { eligible: ["residual", "shared", "shared", null] },
  stopped: { eligible: ["residual", "stopped", "stopped", "stopped"],
    ineligible: ["residual", "routingOff", "routingOff", "routingOff"] },
  disabled: { eligible: ["residual", "disabled", "disabled", "disabled"] },
  broken: { eligible: ["residual", "broken", "broken", "broken"],
    ineligible: ["residual", "routingOff", "routingOff", "routingOff"] },
  foreign: { eligible: ["foreign", "foreign", "foreign", "foreign"] },
  local: { eligible: ["local", "local", "local", "local"] },
  unknown: { eligible: ["unknown", "unknown", "unknown", "unknown"] },
} as const satisfies Record<ClaudeCodeState["sharedProxy"], { eligible: readonly FirstPartyNotice[]; ineligible?: readonly FirstPartyNotice[] }>;
const intents = [[false, false], [true, false], [false, true], [true, true]] as const;
for (const [name, input, expected] of classifierCases) {
  const actual = firstPartyProxyStatus(input);
  if (actual !== expected) throw new Error(`classifier ${name}: ${actual} !== ${expected}`);
}
for (const sharedProxy of FIRST_PARTY_PROXY_STATUSES) {
  for (const interceptEligible of [true, false] as const) {
    for (const [index, [cliFirstParty, desktopFirstParty]] of intents.entries()) {
      const actual = selectFirstPartyNotice({ sharedProxy, interceptEligible, cliFirstParty, desktopFirstParty });
      const row = selectorExpected[sharedProxy];
      const expected = (!interceptEligible && "ineligible" in row ? row.ineligible : row.eligible)[index];
      if (actual !== expected) throw new Error(`selector ${sharedProxy}/${interceptEligible}/${index}: ${actual} !== ${expected}`);
    }
  }
}
for (const [value, expected] of [[undefined, "none"], [null, "unknown"], ["future", "unknown"], [42, "unknown"]] as const) {
  if (normalizeSharedProxy(value) !== expected) throw new Error(`normalize ${String(value)}`);
}
for (const status of FIRST_PARTY_PROXY_STATUSES) {
  if (normalizeSharedProxy(status) !== status) throw new Error(`normalize ${status}`);
}
for (const [value, expected] of [[undefined, true], [true, true], [false, false], [null, false], ["true", false]] as const) {
  if (normalizeInterceptEligible(value) !== expected) throw new Error(`eligible ${String(value)}`);
}
console.log(`G-contract: ${classifierCases.length} classifier + ${FIRST_PARTY_PROXY_STATUSES.length * 2 * intents.length} selector + 12 status normalization + 5 eligibility normalization cases passed`);
```

The management file is already 1111 lines (`wc -l` today) and has no numeric file-size cap in `tests/fixtures/file-size-baseline.json`; append focused cases there only if it stays readable, otherwise create a sibling and register it in both layout files. Its existing `beforeEach` sets temp `OPENCODEX_HOME` and `CLAUDE_CONFIG_DIR` (`tests/claude-integration/claude-management-api.test.ts:43–69`). Source anchor `:73` is `test("GET /api/claude-code returns defaults + available + aliases", async () => {`:

```diff
@@ imports in tests/claude-integration/claude-management-api.test.ts
-import { mkdtempSync, readdirSync, readFileSync} from "node:fs";
+import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
+import { desktopFirstPartyTarget } from "../../src/claude/desktop-first-party";
@@ defaults test after expect(d.enabled).toBe(true)
+    expect(d).toMatchObject({ cliFirstParty: false, cliFirstPartyApplied: false,
+      desktopFirstParty: false, interceptEligible: true, sharedProxy: "none" });
+    expect(typeof d.interceptRunning).toBe("boolean");
@@ after defaults test
+test("CLI first-party on refuses a simultaneously disabled Claude surface without mutation", async () => {
+  const server = startServer(0);
+  try {
+    const before = loadConfig();
+    const response = await fetch(new URL("/api/claude-code", server.url), {
+      method: "PUT", headers: { "Content-Type": "application/json" },
+      body: JSON.stringify({ enabled: false, cliFirstParty: true }),
+    });
+    expect(response.status).toBe(400);
+    expect(await response.json()).toMatchObject({ code: "cli_first_party_not_alone" });
+    expect(loadConfig().claudeCode).toEqual(before.claudeCode);
+  } finally { await server.stop(true); }
+});
```

Add these executable cases in the same temp-home fixture. `desktopFirstPartyTarget` only mints a token in the fixture; the refusal test below snapshots bytes after setup and requires them unchanged.

```diff
@@ after the defaults test in tests/claude-integration/claude-management-api.test.ts
+test("GET classifies observed settings through the bound-state seam", async () => {
+  const current = loadConfig();
+  current.port = 10100;
+  current.claudeCode = { ...current.claudeCode, cliFirstParty: true };
+  saveConfig(current);
+  const env = desktopFirstPartyTarget(current).env;
+  const settingsPath = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
+  mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
+  let bound: { proxyPort: number; caCertPath: string; pickerProxyPort: null } | null = null;
+  const server = startServer(0, { managementApi: { getClaudeInterceptState: () => bound } });
+  try {
+    const get = async () => (await (await fetch(new URL("/api/claude-code", server.url))).json()) as Record<string, unknown>;
+    expect(await get()).toMatchObject({ sharedProxy: "none", cliFirstPartyApplied: false, interceptEligible: true, interceptRunning: false });
+    writeFileSync(settingsPath, JSON.stringify({ env }));
+    expect(await get()).toMatchObject({ sharedProxy: "stopped", cliFirstPartyApplied: false, interceptRunning: false });
+    bound = { proxyPort: 10200, caCertPath: env.NODE_EXTRA_CA_CERTS, pickerProxyPort: null };
+    expect(await get()).toMatchObject({ sharedProxy: "live", cliFirstPartyApplied: true, interceptRunning: true });
+    bound = { ...bound, proxyPort: 10201 };
+    expect(await get()).toMatchObject({ sharedProxy: "broken", cliFirstPartyApplied: false, interceptRunning: true });
+    writeFileSync(settingsPath, JSON.stringify({ env: { ...env, NODE_EXTRA_CA_CERTS: "/tmp/foreign-ca.pem" } }));
+    expect(await get()).toMatchObject({ sharedProxy: "foreign", cliFirstPartyApplied: false });
+    writeFileSync(settingsPath, JSON.stringify({ env: {
+      HTTPS_PROXY: env.HTTPS_PROXY.replace(/^http:\/\/opencodex:[^@/]+@/, "http://"),
+      NODE_EXTRA_CA_CERTS: "/tmp/foreign-ca.pem",
+    } }));
+    expect(await get()).toMatchObject({ sharedProxy: "local" });
+    writeFileSync(settingsPath, JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS } }));
+    expect(await get()).toMatchObject({ sharedProxy: "none" });
+    writeFileSync(settingsPath, "{");
+    expect(await get()).toMatchObject({ sharedProxy: "unknown", cliFirstPartyApplied: false });
+  } finally { await server.stop(true); }
+});
+
+test("GET distinguishes disabled, stale broken, and stopped with routing ineligible", async () => {
+  const current = loadConfig();
+  current.port = 10100;
+  const env = desktopFirstPartyTarget(current).env;
+  current.claudeCode = { ...current.claudeCode, enabled: false, cliFirstParty: true };
+  saveConfig(current);
+  const settingsPath = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
+  mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
+  writeFileSync(settingsPath, JSON.stringify({ env }));
+  let bound: { proxyPort: number; caCertPath: string; pickerProxyPort: null } | null =
+    { proxyPort: 10200, caCertPath: env.NODE_EXTRA_CA_CERTS, pickerProxyPort: null };
+  const server = startServer(0, { managementApi: { getClaudeInterceptState: () => bound } });
+  try {
+    const get = async () => (await (await fetch(new URL("/api/claude-code", server.url))).json()) as Record<string, unknown>;
+    expect(await get()).toMatchObject({ sharedProxy: "disabled", cliFirstPartyApplied: false, interceptEligible: false, interceptRunning: false });
+    // Configured port and seam-bound listener still match; only the settings URL is stale.
+    writeFileSync(settingsPath, JSON.stringify({ env: {
+      ...env, HTTPS_PROXY: env.HTTPS_PROXY.replace(":10200", ":10199") } }));
+    expect(await get()).toMatchObject({ sharedProxy: "broken", cliFirstPartyApplied: false,
+      interceptEligible: false, interceptRunning: false });
+    bound = null;
+    expect(await get()).toMatchObject({ sharedProxy: "stopped", cliFirstPartyApplied: false,
+      interceptEligible: false, interceptRunning: false });
+  } finally { await server.stop(true); }
+});

+// The two other claudeInterceptEnabled guards must agree with enabled:false above.
+for (const cause of ["intercept disabled", "hub client"] as const) {
+  test(`GET reports stale settings as broken when ${cause}`, async () => {
+    const current = loadConfig();
+    current.port = 10100;
+    const env = desktopFirstPartyTarget(current).env;
+    current.claudeCode = { ...current.claudeCode, cliFirstParty: true,
+      ...(cause === "intercept disabled" ? { intercept: { ...current.claudeCode?.intercept, enabled: false } } : {}) };
+    if (cause === "hub client") current.runtimeRole = "client";
+    saveConfig(current);
+    const settingsPath = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
+    mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
+    writeFileSync(settingsPath, JSON.stringify({ env: {
+      ...env, HTTPS_PROXY: env.HTTPS_PROXY.replace(":10200", ":10199") } }));
+    const bound = { proxyPort: 10200, caCertPath: env.NODE_EXTRA_CA_CERTS, pickerProxyPort: null };
+    const server = startServer(0, { managementApi: { getClaudeInterceptState: () => bound } });
+    try {
+      const response = await fetch(new URL("/api/claude-code", server.url));
+      expect(response.status).toBe(200);
+      expect(await response.json()).toMatchObject({ sharedProxy: "broken", cliFirstPartyApplied: false,
+        interceptEligible: false, interceptRunning: false });
+    } finally { await server.stop(true); }
+  });
+}

+test("CLI-on rechecks a drifted disk port under the config lock", async () => {
+  const current = loadConfig();
+  current.port = 10100;
+  saveConfig(current);
+  const server = startServer(0, { managementApi: { getClaudeInterceptState: () =>
+    ({ proxyPort: 10200, caCertPath: join(testDir, "claude-intercept", "ca.pem"), pickerProxyPort: null }) } });
+  try {
+    const configPath = join(testDir, "config.json");
+    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
+    onDisk.claudeCode = { ...onDisk.claudeCode,
+      intercept: { ...onDisk.claudeCode?.intercept, port: 10201 } };
+    writeFileSync(configPath, JSON.stringify(onDisk));
+    const configBytes = readFileSync(configPath, "utf8");
+    const settingsPath = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
+    const settingsBefore = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
+    const response = await fetch(new URL("/api/claude-code", server.url), {
+      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cliFirstParty: true }),
+    });
+    expect(response.status).toBe(409);
+    expect(await response.json()).toMatchObject({ code: "intercept_unavailable" });
+    expect(readFileSync(configPath, "utf8")).toBe(configBytes);
+    expect(existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null).toBe(settingsBefore);
+  } finally { await server.stop(true); }
+});

+test("CLI-off reports legacy tokenless local proxy with foreign CA as residue", async () => {
+  const current = loadConfig();
+  current.port = 10100;
+  current.claudeCode = { ...current.claudeCode, cliFirstParty: true,
+    desktopMode: "gateway" };
+  saveConfig(current);
+  const owned = desktopFirstPartyTarget(current).env;
+  const settingsPath = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
+  mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
+  const settingsBytes = JSON.stringify({ env: {
+    HTTPS_PROXY: owned.HTTPS_PROXY.replace(/^http:\/\/opencodex:[^@/]+@/, "http://"),
+    NODE_EXTRA_CA_CERTS: "/tmp/foreign-ca.pem" } });
+  writeFileSync(settingsPath, settingsBytes);
+  const server = startServer(0, { managementApi: { getClaudeInterceptState: () => null } });
+  try {
+    const response = await fetch(new URL("/api/claude-code", server.url), {
+      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cliFirstParty: false }),
+    });
+    expect(response.status).toBe(200);
+    expect(await response.json()).toMatchObject({ warnings: ["settings_residual"] });
+    const get = await fetch(new URL("/api/claude-code", server.url));
+    expect(await get.json()).toMatchObject({ sharedProxy: "local" });
+    expect(loadConfig().claudeCode?.cliFirstParty).toBeUndefined();
+    expect(readFileSync(settingsPath, "utf8")).toBe(settingsBytes);
+  } finally { await server.stop(true); }
+});
```

Also test an older-port owned-CA URL against an eligible bound listener as `broken`, a non-opencodex foreign URL as `none`, and `stale` with a token-owned URL and no listener as `stopped`. For rollback failure, inject or mock the wp2 reconciliation seam in an isolated request and prove persisted `cliFirstParty` and `desktopMode` equal their pre-PUT values while a concurrent unrelated Claude field and `fastMode` survive; also test a failed rollback persistence reports `write_failed`. Verify an on-request with another invalid field refuses before that field is saved.

`tests/claude-integration/claude-cli.test.ts:99` starts existing native-env tests. Add pure assertions; no process spawn:

```diff
@@ ocx claude native fallback describe
+  test("owned applied and stale env force native bypass without foreign inherited proxy", () => {
+    const owned = { HTTPS_PROXY: "http://127.0.0.1:10200", NODE_EXTRA_CA_CERTS: "/tmp/owned-ca.pem" };
+    for (const kind of ["applied", "stale"] as const) {
+      const env = buildNativeClaudeEnv(cfg(), { HTTPS_PROXY: owned.HTTPS_PROXY,
+        NODE_EXTRA_CA_CERTS: "/tmp/foreign-ca.pem" },
+        { ownedInterceptSettings: { kind, env: owned } });
+      expect(env.NO_PROXY).toBe("*"); expect(env.no_proxy).toBe("*");
+      expect(env.HTTPS_PROXY).toBeUndefined();
+      expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/foreign-ca.pem");
+    }
+  });
```

Also assert `absent`, `foreign`, `unreadable` and no settings env retain inherited proxy/CA and do not set either bypass variable. For owned settings with foreign inherited `HTTPS_PROXY` or `https_proxy`, assert both bypass variables remain unchanged, all inherited proxy/CA values survive, and exactly one warning names the settings-owned intercept and how to disable or unset it. Test owned CA equality removes the CA only on the bypass path; with no inherited proxy, both bypass variables become `*`.

`tests/cli/ensure-desired-integrations-race.test.ts:1` imports the ensure function; add a fixture with CLI intent true and Desktop false. Current `:46` starts `function harness(initial: OcxConfig) {`. Extend the dependency seam for the shared reconciler before writing the case:

```diff
@@ src/cli/ensure-desired-integrations.ts EnsureDesiredIntegrationsDeps
+  reconcileClaudeFirstPartySettings?: typeof reconcileClaudeFirstPartySettings;
@@ src/cli/ensure-desired-integrations.ts CLI refresh call
-      const result = reconcileClaudeFirstPartySettings(config,
+      const result = (deps.reconcileClaudeFirstPartySettings ?? reconcileClaudeFirstPartySettings)(config,
@@ tests/cli/ensure-desired-integrations-race.test.ts after harness
+test("CLI-only stale env refreshes before Desktop-off cleanup", async () => {
+  const current = config({ desktop: false });
+  current.claudeCode = { ...current.claudeCode, cliFirstParty: true };
+  const h = harness(current);
+  const calls: string[] = [];
+  h.deps.inspectDesktopFirstParty = () => ({
+    interceptEnabled: true, proxyPort: 10200, caCertPath: "/tmp/owned-ca.pem",
+    settings: { kind: "stale", env: { NODE_EXTRA_CA_CERTS: "/tmp/owned-ca.pem" } },
+    applied: false, stale: true,
+  });
+  h.deps.reconcileClaudeFirstPartySettings = () => {
+    calls.push("refresh");
+    return { ok: true, action: "applied", changed: true, path: "/tmp/settings.json" };
+  };
+  h.deps.removeDesktopFirstParty = () => {
+    calls.push("desktop-off");
+    return { ok: true, changed: false, path: "/tmp/settings.json", retainedFor: "cli" };
+  };
+  await runLiveBranch(h, current);
+  expect(calls).toEqual(["refresh", "desktop-off"]);
+});
```

Add table-driven cases for absent/applied/foreign env and disabled intercept. With CLI still desired and intercept disabled, reconciliation returns `unchanged` and leaves an owned env intact; Desktop-off cleanup retains it with `retainedFor:"cli"`. With `cliFirstParty:false` and no Desktop desire, cleanup removes only owned values; with Desktop gateway still applied, assert CLI refresh precedes the Desktop conflict return. Keep all filesystem paths under temp fixtures; dependency-only tests need no settings write.

`tests/cli/claude-config-first-party.test.ts` is NEW; its anchor is `src/cli/integrations.ts:63`, `export async function handleClaudeConfigCommand(...)`. Create with:

```diff
--- /dev/null
+++ tests/cli/claude-config-first-party.test.ts
+import { expect, test } from "bun:test";
+import { handleClaudeConfigCommand } from "../../src/cli/integrations";
+
+test("--first-party sends only cliFirstParty to the Claude management PUT", async () => {
+  let sent: unknown;
+  const code = await handleClaudeConfigCommand(["set", "--first-party", "on"], {
+    baseUrl: "http://127.0.0.1:1",
+    fetchImpl: async (_url, init) => {
+      sent = JSON.parse(String(init?.body));
+      return Response.json({ ok: true });
+    },
+  });
+  expect(code).toBe(0);
+  expect(sent).toEqual({ cliFirstParty: true });
+});
```

Add `off` and invalid token cases: `off` sends false; invalid token exits with usage error and makes zero requests. `scripts/test-layout/layout.json:435` says `"claude-cli.test.ts": "claude-integration",`; `tests/fixtures/test-layout-expected.json:261` says the same. Insert sorted explicit rows:

```diff
@@ scripts/test-layout/layout.json explicit
+    "claude-config-first-party.test.ts": "cli",
@@ tests/fixtures/test-layout-expected.json
+  "claude-config-first-party.test.ts": "cli",
```

For source-oracle tests resolve paths through `tests/helpers/repo-root.ts` (`AGENTS.md`, test-layout rule); this new parser test needs no repository-path lookup. The generated skill file has no hand-authored diff: run the generator described above and commit its exact output.

## PLAN-FIELD-CHAIN-01

| New field/value | Creation | Serialization | Deserialization | Every consumer |
|---|---|---|---|---|
| `cliFirstParty` durable config (wp2) | `src/cli/integrations.ts` `--first-party`; `agent-settings-routes.ts` PUT before other fields; GUI wp5 | field-scoped `mutatePersistedConfig` writes/deletes the CLI field and pins an absent `desktopMode` in the same CLI-on mutation; `commitClaudeCodeBlock` stamps the sentinel; `adoptPersistedClaudeCode` mirrors the saved block | wp2 `src/config/schema/**` + `loadConfig`; absent = false | `firstPartyDesired` in wp2; management GET/PUT and conditional field rollback; `ensure-desired-integrations.ts`; wp3 live callback; GUI wp5 |
| GET `cliFirstParty` | `agent-settings-routes.ts` config boolean | `jsonResponse` | CLI `runtimeRequest` JSON; GUI wp5 | `ocx claude config status`, GUI wp5 |
| GET `cliFirstPartyApplied` | `config.claudeCode?.cliFirstParty === true && sharedProxy === "live"` | `jsonResponse` | CLI `runtimeRequest` JSON; GUI wp5 | status display, GUI wp5 |
| GET `desktopFirstParty` | wp2 `firstPartyDesired(...).desktop` | `jsonResponse` | CLI `runtimeRequest` JSON; GUI wp5 | status display, GUI wp5 |
| GET `interceptEligible` | `claudeInterceptEnabled(config)` in `agent-settings-routes.ts`, evaluated once alongside the bound listener and `sharedProxy` | `jsonResponse` boolean | CLI `runtimeRequest` JSON; GUI wp5 `ClaudeCodeState.interceptEligible`; `normalizeInterceptEligible(value)` uses `value === undefined ? true : value === true` so an older cache/DTO cannot show `routingOff` | GUI wp5 ordered notice selector for stopped/broken; route and selector tests |
| GET `interceptRunning` | `bound !== null && eligible`, using the same `bound` and `eligible` snapshot as `sharedProxy` | `jsonResponse` | CLI `runtimeRequest` JSON; GUI wp5 | status display; `sharedProxy` owns notice selection |
| GET `sharedProxy` | wp2 `firstPartyProxyStatus` consumes inspected settings, bound port from the same seam as `interceptRunning`, and `claudeInterceptEnabled(config)`; GET calls `readFirstPartyProxyStatus` | `jsonResponse` as imported `FirstPartyProxyStatus` (eight values above) | CLI `runtimeRequest` JSON; GUI wp5 `ClaudeCodeState` and cache/GET validation preserve all eight; only `undefined` (older cache/DTO) → `none`; `null` and all other invalid values → `unknown` | `ocx claude config status`; GUI wp5 ordered selector; `unknown` is never collapsed into `none` |
| PUT `cliFirstParty` | parser or GUI wp5 | `JSON.stringify(body)` in CLI; fetch body in GUI | `readManagementJsonBody` + boolean guard | pre-lock fast path, locked persisted eligibility/port check, field-scoped save/adopt, reconcile, conditional rollback on CLI-on failure, GET |
| Response `code` literals and `warnings` | standalone PUT guard/reconcile; post-removal `readFirstPartyProxyStatus` | `jsonResponse` | `runtimeRequest` response/error body; GUI wp5 | CLI error output, GUI wp5; `cli_first_party_not_alone` on mixed body; `settings_residual` after successful nothing-desired reconcile for every status except `none`, including `local` (unreadable → existing 500); no durable storage |
| `ownedInterceptSettings` seam | `inspectDesktopFirstParty(config).settings` in launch | N/A: in-process argument | N/A: in-process discriminated union | `buildNativeClaudeEnv`; owned proxy comparison; one-line warning callback for a foreign inherited proxy |

wp4 imports wp2's eight-value status union; it does not redeclare it. wp5's `FirstPartyNotice` adds `routingOff` and its complete catalog key map adds `claude.firstParty.routingOff` in all ten locales. wp2's reconcile reason/action union and wp3's client classifier are consumed as documented in their own phase files. The capability entry is a registry record, not a serialized config field.

## Activation and observable acceptance

| Test file | Activation | Observable assertion |
|---|---|---|
| wp2 pure `firstPartyProxyStatus` table above | all eight output states and ordered rules, explicit URL port 80, foreign CA with and without opencodex userinfo, ineligible applied/mismatched settings, bound null | 15 cases pass; tokenless foreign-CA loopback is `local`, token-owned foreign CA is `foreign`, only ineligible applied matching port is `disabled`, ineligible stale port/token is `broken`, and null bound is `stopped` |
| wp5 pure `selectFirstPartyNotice`, `normalizeSharedProxy`, and `normalizeInterceptEligible` tables above | source status roster × two eligibility values × four intent pairs; undefined, null, future string, number, every valid status; missing/true/false/null/string eligibility | 64 selector, 12 status normalization, and 5 eligibility normalization cases pass; stopped/broken with intent and ineligible routing select `routingOff`, with eligible routing select `stopped`/`broken`; `local` precedes residual, residual precedes disabled without intent, only undefined status normalizes to `none`, only undefined eligibility defaults true; source roster and Record coverage typecheck with GUI app tsconfig |
| `tests/claude-integration/claude-management-api.test.ts` | GET absent, CA-only stale, tokenless loopback with foreign CA, malformed/unreadable settings; token-owned foreign CA; applied URL with seam stopped, matching, mismatched, or bound-but-disabled; each of `claudeCode.enabled:false`, `claudeCode.intercept.enabled:false`, and `runtimeRole:"client"` with a seam-bound listener and stale settings URL | Respectively `none`, `none`, `local`, `unknown`, `foreign`, then `stopped`/`live`/`broken`/`disabled`; all three ineligible cases with stale URL are `broken` with `interceptEligible:false` and `interceptRunning:false`; usable applied settings with bound ineligible listener are `disabled`; no bound listener wins over ineligible config and returns `stopped`; `cliFirstPartyApplied` iff CLI intent and `live`; `interceptEligible` reflects `claudeInterceptEnabled(config)`; `interceptRunning` iff bound and eligible |
| same | PUT `cliFirstParty` nonboolean; `{enabled:false,cliFirstParty:true}` and every other mixed body; standalone on with intercept disabled/stopped; configured port mismatch; after `startServer`, change disk `intercept.port` while seam remains bound to old port | 400 type error or `cli_first_party_not_alone` for mixed; standalone on 409 `intercept_disabled`/`intercept_unavailable`, with mismatch message naming both ports and restart; disk drift is refused by the locked callback with config and settings bytes unchanged |
| same | foreign managed key, unreadable settings, CA failure, settings write failure | 409 `foreign_env`; 500 `unreadable`/`ca_unavailable`/`write_failed`; flag and mode rolled back |
| same | CLI on with absent Desktop mode, with legacy gateway observation, with legacy first-party observation | one mutation pins pre-write observed mode and CLI flag; standalone request skips ordinary whole-block save; refusal saves none of them |
| same | CLI-on reconcile failure, concurrent unrelated field edit, failed conditional rollback write | only this request's still-matching CLI/mode values revert; concurrent field and `fastMode` survive; failed rollback reports `write_failed` |
| same | CLI off with Desktop desired true/false; `enabled:false` with existing CLI true; legacy tokenless loopback URL plus foreign CA, then CLI off; token-owned foreign CA; bound-but-disabled residue; unreadable cleanup | off persists; shared env kept whenever Desktop desired; enabled-off alone leaves intent and env untouched; legacy file remains byte-for-byte untouched, GET says `local`, and off returns 200 with `warnings:["settings_residual"]`; token-owned foreign CA still reports `foreign`; disabled residue also warns; unreadable cleanup keeps off persisted but returns coded 500 |
| `tests/cli/ensure-desired-integrations-race.test.ts` | CLI desired with absent/stale/applied env, Desktop on/off/gateway; Desktop-off removal | absent/stale refreshed, applied unchanged, CLI env retained, Desktop residue removed; foreign env untouched |
| `tests/cli/claude-config-first-party.test.ts` | on/off/bad option | true/false single-field PUT; bad value makes no request |
| `tests/claude-integration/claude-cli.test.ts` | owned applied/stale without foreign proxy; owned with foreign `HTTPS_PROXY` or `https_proxy`; absent/foreign/unreadable/no-env | bypass only for owned settings without foreign inherited proxy; foreign case preserves env and emits one warning; only equal inherited owned proxy/CA values deleted on bypass path |
| `tests/cli/cli-capabilities.test.ts` | declaration and debt removal | GET/PUT route keys now map to `ocx claude config`; undeclared list excludes them |
| `tests/ci-workflows/skill-ocx.test.ts` | generated surface after registry addition | generated file equals generator output |

## Verifier evidence and commands for C

Commands actually run during P, in this worktree, without starting the proxy or writing user settings:

| Command | Exit | Reads wp4 target? |
|---|---:|---|
| `bun test tests/cli/cli-capabilities.test.ts` | 1 | Yes, direct test imports `src/cli/capabilities.ts`; blocked before tests by missing `zod/v4` dependency from schema. Not a passing gate. |
| `bun test tests/cli/cli-capabilities.test.ts` (reflection rerun, dependencies installed) | 0 | Yes, direct import of `src/cli/capabilities.ts`; 18 pass, 0 fail. This checks current anchors only, before wp4 implementation. |
| `bun run skill:surface:check` | 0 | Yes, `package.json:55` calls `scripts/generate-ocx-skill-surface.ts --check`; script `:15–17` reads capabilities and target generated file. Current pre-change surface passes. |
| `rg -n 'claude-cli.test.ts\|claude-management-api.test.ts' scripts/test-layout/layout.json tests/fixtures/test-layout-expected.json` | 0 | Yes, both explicit maps currently list the existing files; new file needs two entries. |
| `rg -n '"include"' tsconfig.json` | 0 | Yes for changed `src/` via `"include": ["src"]` at `tsconfig.json:15`; does not typecheck tests. |

With dependencies now installed, C runs `bun test` on each test file in the map, `bun run typecheck`, `bun run test:changed`, `bun run skill:surface`, `bun run skill:surface:check`, `bun run privacy:scan`, and `bun run structure:check`. These are future commands, not claimed passing evidence. The management test starts an isolated server; P did not run it because this delegation forbids starting the proxy. The structure check reads owned source/docs bindings; wp4 updates `structure/gui-and-management-api.md` alongside the management route. The full suite remains wp6's gate.

## Risks, bypass, questions for main

- **PLAN-BYPASS-NAMED-01:** The locked PUT callback rechecks persisted eligibility and port, so a disk edit between the fast path and the lock cannot authorize CLI-on. A noncooperating writer can still change config after the lock's final read; GET then reports `broken` when settings and the listener diverge. `ocx ensure` from another process can likewise write a config-derived port while the server is bound elsewhere; restart or ensure after restart restores alignment. wp3 request-time relay remains the behavior guard. `NO_PROXY=*` is an E2 process-env bypass executed by `ocx claude`; callers can launch bare `claude` instead, so it is described only as this launch's native fallback.
- CLI-on reconciliation can fail after its field-scoped save. The rollback must conditionally revert only the still-matching CLI flag and mode pin; it must preserve a concurrent manual edit to another field and must never restore an old `fastMode` snapshot. Test both conditional rollback and a failed rollback write before claiming the refusal leaves no state change.
- `inspectDesktopFirstParty` is read-only but may classify an owned env stale when the proxy token is absent. Native launch must still bypass stale owned settings; an unreadable settings file cannot be safely recognized and is left alone.
- A direct intercept-disable route outside this PUT does not imply env removal while either client remains desired. With an already-bound listener, wp3's callback relays all requests unchanged and GET reports `disabled` with `interceptRunning:false`; after restart with no listener, it reports `stopped`.

Revisions 2–7, RP1–RP6, Replan E1–E4, and Replan F are superseded by Replan G in `000_plan.md`.

## Replan F changelog

- F: Added `local`, narrowed `disabled` to usable bound settings, moved residual ahead of disabled, made only `undefined` normalize to `none`, synchronized ten-locale copy and route/table/structure acceptance with the eight-state contract.

## Replan G changelog

- G: Added GET `interceptEligible` from the classifier's config snapshot, kept `interceptRunning` bound-and-eligible, and added `routingOff` notice precedence for ineligible `stopped`/`broken` while retaining the F classifier. Added older-cache eligibility normalization, ten-locale copy ownership, stopped/broken recovery distinction, selector matrix, and a disabled-config/stale-settings GET case with a matching bound listener.

## Replan H changelog

- H: Referred to the single cause-neutral copy in wp5 and added seam-bound stale-settings GET cases for intercept disabled and hub client alongside Claude disabled; acceptance now covers all three.

- Audit cycle 3 note (non-blocking, folded): the `runtimeRole: "client"` GET case builds its config with a valid `client` connection block, because the config validator requires the pairing (`tests/server/config.test.ts:432-442`).

## wp4 P amendment (architect stale-check)

- Anchors in `src/server/management/agent-settings-routes.ts` moved by two lines after wp2; re-anchor by the quoted
  text, not the line number.
- CLI parser guard (`src/cli/integrations.ts`, `handleClaudeConfigCommand`), placed after every `take*` call and
  `rejectArgs`, before `runtimeRequest`:

  ```ts
  const firstParty = takeBooleanOption(args, "--first-party");
  // ... existing take* calls and rejectArgs(args, CLAUDE_USAGE) ...
  if (firstParty !== undefined) {
    if (Object.keys(body).length > 0) {
      throw new CliUsageError("--first-party must be set on its own (it writes Claude Code's settings file immediately)", CLAUDE_USAGE);
    }
    body.cliFirstParty = firstParty;
  }
  ```
  `CLAUDE_USAGE` gains a separate line `ocx claude config set --first-party <on|off> [--json]`. The parser test covers
  `--first-party on` (body `{cliFirstParty:true}`), `--first-party off`, and `--first-party on --system-env on` (usage error,
  no request).
- Structure docs owned by the areas wp4 changes (`structure/INDEX.md`: `src/cli/` → runtime, config, clients/claude-desktop,
  ops/docs-and-release; `src/server/` → runtime), added to the file map:
  - `structure/runtime.md`: next to the Claude intercept pair paragraph, "`ocx claude` with Claude routing off launches
    natively; when the shared settings env carries opencodex's proxy it adds `NO_PROXY=*` (and `no_proxy`) so the launch
    bypasses it, unless an inherited foreign `HTTPS_PROXY` is present, in which case it warns instead."
  - `structure/config.md`: after the wp2 `cliFirstParty` paragraph, "It is written only by a standalone
    `PUT /api/claude-code { cliFirstParty }` and `ocx claude config set --first-party`; the enable path pins an absent
    `desktopMode` in the same persisted mutation."
  - `structure/clients/claude-desktop.md`: in the Surfaces lines, "`ocx claude config set --first-party on|off` and the
    Claude Code page switch control the CLI intent; `ocx ensure` refreshes a stale or absent env while it is on."
  - `structure/ops/docs-and-release.md`: where it describes the capability registry / `skills/ocx` surface (rg
    `CAPABILITIES|skill:surface`), note that `claude config` is a declared capability; if the doc does not enumerate
    commands, no edit.

- wp4 A fold (contract audit): the native bypass requires a present opencodex-shaped `HTTPS_PROXY`
  (`isClaudeInterceptProxyUrl`) in addition to an owned settings kind. Added test in
  `tests/claude-integration/claude-cli.test.ts`: `ownedInterceptSettings = { kind: "stale", env: { NODE_EXTRA_CA_CERTS: "<ours>" } }`
  with inherited `ALL_PROXY=http://corp:3128` → `NO_PROXY`/`no_proxy` stay unset, `ALL_PROXY` kept, no warning.

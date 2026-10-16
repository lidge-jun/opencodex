# 010 — wp2 Foundations: CLI and Desktop first-party ownership

## Goal and boundary

Make `claudeCode.cliFirstParty` a durable, default-off intent and make the shared Claude Code settings env the union of Desktop and CLI intent. The Desktop inference must ignore CLI-owned env. This phase is independently testable with real temporary settings files. IN: config type/schema/load normalization, desired-state/reconcile module, Desktop removal callers, owning structure docs, focused tests and test layout. OUT: request classification, live listener callback, management GET/PUT toggle, CLI parser, GUI, translated docs, live `~/.claude`/`~/.opencodex`, proxy start, merge. These belong to wp3–wp6 in `000_plan.md`. The wp4 enable route must pin absent Desktop mode from the *pre-toggle* observation before writing CLI intent; this phase supplies the observation behavior and does not persist that future transaction.

## File change map

| Path | Change | Purpose |
|---|---|---|
| `src/types/config.ts` | MODIFY | Persisted intent type |
| `src/config/load-degrade.ts` | MODIFY | Drop malformed hand edit without losing config |
| `src/claude/first-party-settings.ts` | NEW | Pure two-client desire, owned settings reconciliation, and eight-state shared-proxy inspection |
| `src/claude/desktop-first-party.ts` | MODIFY | Ignore CLI env for Desktop inference; retain env for CLI |
| `src/cli/claude-desktop.ts` | MODIFY | Pass current config at gateway cleanup; report retention |
| `src/cli/ensure-desired-integrations.ts` | MODIFY | Pass fresh config; report CLI retention |
| `src/server/management/agent-settings-routes.ts` | MODIFY | Pass latest config at gateway cleanup; report retention |
| `src/server/management/native-integration-routes.ts` | MODIFY | Pass current config at both removals; report retention |
| `structure/config.md` | MODIFY | Document optional CLI intent and pre-write Desktop-mode pinning in the owned config contract |
| `structure/clients/claude-desktop.md` | MODIFY | Exclude CLI-only owned env from legacy Desktop mode inference |
| `tests/claude-integration/claude-desktop-first-party.test.ts` | MODIFY | Update required signature |
| `tests/claude-integration/claude-first-party-union.test.ts` | NEW | Desire matrix, eight proxy states and rule precedence, read-only inspection, transitions, guards, legacy inference |
| `scripts/test-layout/layout.json` | MODIFY | Explicit test domain |
| `tests/fixtures/test-layout-expected.json` | MODIFY | Expected test domain |
| `structure/runtime.md` | MODIFY | shared settings env ownership and proxy status (wp2 P amendment) |

`src/config/schema/config-schema.ts:292` uses `.passthrough()`: there is no `claudeCode` strict allowlist. `src/server/management/config-routes.ts:619` calls `saveConfigPreservingClaudeCode`; `src/config/live-reconcile.ts:425` rebases the subtree. Neither has a per-field allowlist, so no edit there. `src/config/salvage.ts:32` only names `desktopProfile`; the schema accepts any `cliFirstParty` value (passthrough); `loadConfig` parses first and `normalizePersistedClaudeCode` in `load-degrade.ts` then drops a non-boolean value. The field-scoped GET/PUT allowlist in `agent-settings-routes.ts:1508` is intentionally wp4, not a wp2 creation path.

## Exact source anchors and executable diffs

All anchors below are from base `9c28acf6a1` in this worktree. For NEW files, `N/A` means the path does not exist; insertion neighbors are quoted. Hunk context is current code; additions are intended TypeScript, with existing imports verified in source.

### Config type — `src/types/config.ts:39` `export interface OcxClaudeCodeConfig {`

```diff
@@
 export interface OcxClaudeCodeConfig {
+  /** Route the standalone Claude Code CLI through the first-party intercept (settings.json env).
+   *  Independent of Desktop's first-party mode. Absent/false = off. */
+  cliFirstParty?: boolean;
   /**
    * Opt-in relocation of supported trailing Claude harness notices from system instructions
```

### Schema — no change (audit wp2-A)

`claudeCode` is `.passthrough()` (`src/config/schema/config-schema.ts:292`) and `loadConfig` / diagnostics parse the schema
**before** `normalizePersistedClaudeCode` runs (`src/config.ts:230-252`, `src/config/diagnostics.ts:649-682`). A schema issue
for a malformed `cliFirstParty` would therefore push a hand-edited config onto the fallback path. wp2 adds no schema
rule: the load normalizer below drops a non-boolean value, and every consumer reads `=== true`, so any malformed
value means off. Writes stay typed: `PUT /api/claude-code` (wp4) accepts only a boolean.

### Load degradation — `src/config/load-degrade.ts:546` `const normalized = { ...claudeCode } as Record<string, unknown>;`

```diff
@@
   const normalized = { ...claudeCode } as Record<string, unknown>;
+  // A malformed hand edit must not arm CLI interception or discard the whole config.
+  if (Object.hasOwn(normalized, "cliFirstParty") && typeof normalized.cliFirstParty !== "boolean") {
+    delete normalized.cliFirstParty;
+  }
   if (Object.hasOwn(normalized, "subagentEffort") && !isClaudeSubagentEffort(normalized.subagentEffort)) {
```

### Desired union — NEW `src/claude/first-party-settings.ts`; anchor `src/claude/desktop-first-party.ts:219` `export function applyDesktopFirstParty(` (reuse, no duplicate CA/token preparation)

```diff
--- /dev/null
+++ b/src/claude/first-party-settings.ts
@@
+import { getConfigDir } from "../config/paths";
+import { claudeDesktopIntegrationEnabled } from "../codex/desired-state";
+import { join } from "node:path";
+import type { OcxConfig } from "../types";
+import { claudeConfigDir } from "./auth-detect";
+import {
+  applyDesktopFirstParty,
+  inspectDesktopFirstParty,
+  resolveClaudeDesktopMode,
+  type ClaudeDesktopModeObservation,
+  type DesktopFirstPartyOptions,
+} from "./desktop-first-party";
+import { claudeInterceptCaCertPath } from "./intercept/local-ca";
+import { claudeInterceptEnabled } from "./intercept/runtime";
+import { isClaudeInterceptProxyUrl, removeClaudeInterceptSettings, type ClaudeInterceptSettingsState } from "./intercept/settings";
+
+export type ClaudeFirstPartyClient = "desktop" | "cli";
+export interface ClaudeFirstPartyDesired { desktop: boolean; cli: boolean }
+
+export function cliFirstPartyDesired(config: Pick<OcxConfig, "claudeCode">): boolean {
+  return config.claudeCode?.cliFirstParty === true;
+}
+
+export function desktopFirstPartyDesired(
+  config: Pick<OcxConfig, "claudeCode" | "clientIntegrations">,
+  observed?: ClaudeDesktopModeObservation,
+): boolean {
+  return claudeDesktopIntegrationEnabled(config)
+    && resolveClaudeDesktopMode(config, observed) === "first-party";
+}
+
+export function firstPartyDesired(
+  config: Pick<OcxConfig, "claudeCode" | "clientIntegrations">,
+  observed?: ClaudeDesktopModeObservation,
+): ClaudeFirstPartyDesired {
+  return { desktop: desktopFirstPartyDesired(config, observed), cli: cliFirstPartyDesired(config) };
+}
+
+export type ClaudeFirstPartyReconcileResult =
+  | { ok: true; action: "applied" | "removed" | "unchanged"; changed: boolean; path: string }
+  | { ok: false; reason: "intercept_disabled" | "ca_unavailable" | "unreadable" | "foreign_env"; path: string };
+
+export function reconcileClaudeFirstPartySettings(
+  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole" | "clientIntegrations">,
+  desired: ClaudeFirstPartyDesired,
+  options: DesktopFirstPartyOptions = {},
+): ClaudeFirstPartyReconcileResult {
+  if (!desired.desktop && !desired.cli) {
+    const ownedCa = claudeInterceptCaCertPath(options.opencodexConfigDir ?? getConfigDir());
+    const removed = removeClaudeInterceptSettings(ownedCa, options.claudeConfigDir);
+    if (!removed.ok) return removed;
+    return { ok: true, action: removed.changed ? "removed" : "unchanged", changed: removed.changed, path: removed.path };
+  }
+  if (!claudeInterceptEnabled(config)) {
+    return { ok: true, action: "unchanged", changed: false,
+      path: join(options.claudeConfigDir ?? claudeConfigDir(), "settings.json") };
+  }
+  const written = applyDesktopFirstParty(config, options);
+  if (!written.ok) return written;
+  return { ok: true, action: written.changed ? "applied" : "unchanged", changed: written.changed, path: written.path };
+}
+
+export type FirstPartyProxyStatus = "none" | "live" | "stopped" | "disabled" | "broken" | "foreign" | "local" | "unknown";
+export interface FirstPartyProxyStatusInput {
+  settings: ClaudeInterceptSettingsState;
+  boundProxyPort: number | null;
+  eligible: boolean;
+}
+
+/** Classify the settings URL against the listener actually bound in this process. */
+export function firstPartyProxyStatus({ settings, boundProxyPort, eligible }: FirstPartyProxyStatusInput): FirstPartyProxyStatus {
+  if (settings.kind === "unreadable") return "unknown";
+  if (settings.kind === "absent") return "none";
+  const proxy = settings.env.HTTPS_PROXY;
+  if (!isClaudeInterceptProxyUrl(proxy)) return "none";
+  // A foreign CA cannot establish ownership; preserve tokenless loopback as an uncertain local proxy.
+  if (settings.kind === "foreign") {
+    return /^http:\/\/opencodex:[^@/]+@/.test(proxy) ? "foreign" : "local";
+  }
+  if (boundProxyPort === null) return "stopped";
+  // The URL shape is owned; a malformed/out-of-range port cannot match the bound listener.
+  let port: number;
+  try { port = Number(new URL(proxy).port || 80); } catch { return "broken"; }
+  const usable = settings.kind === "applied" && port === boundProxyPort;
+  if (!eligible) return usable ? "disabled" : "broken";
+  return usable ? "live" : "broken";
+}
+
+/** Read-only: inspectDesktopFirstParty reads an existing token; it never creates one. */
+export function readFirstPartyProxyStatus(
+  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole">,
+  boundProxyPort: number | null,
+  options: DesktopFirstPartyOptions = {},
+): FirstPartyProxyStatus {
+  const settings = inspectDesktopFirstParty(config, options).settings;
+  return firstPartyProxyStatus({ settings, boundProxyPort, eligible: claudeInterceptEnabled(config) });
+}
```

The reconciler takes an explicit `desired` snapshot. Only an empty desired pair removes the owned env. A desired client with a disabled intercept returns unchanged without reading or writing settings; wp4 owns transactional validation, persistence, and the runtime-available refusal before an on-toggle persists. Existing `applyDesktopFirstParty` already catches CA/token preparation failures and delegates foreign/unreadable checks to `intercept/settings.ts:152`.

### Desktop ownership — `src/claude/desktop-first-party.ts:202` `try {`; `:238` `export function removeDesktopFirstParty(options: DesktopFirstPartyOptions = {}): ClaudeInterceptSettingsWrite {`

```diff
@@
 import { getConfigDir } from "../config/paths";
+import { join } from "node:path";
 import type { OcxConfig } from "../types";
+import { claudeConfigDir } from "./auth-detect";
@@
-  try {
-    const kind = inspectDesktopFirstParty(config, options).settings.kind;
-    observed.ownedFirstPartySettings = kind === "applied" || kind === "stale";
+  try {
+    const kind = inspectDesktopFirstParty(config, options).settings.kind;
+    observed.ownedFirstPartySettings = config.claudeCode?.cliFirstParty === true
+      ? false : kind === "applied" || kind === "stale";
@@
-/** Remove the first-party env. Only values anchored on our CA path are touched. */
-export function removeDesktopFirstParty(options: DesktopFirstPartyOptions = {}): ClaudeInterceptSettingsWrite {
+/** Remove Desktop's share of the env, retaining the shared pair for a desired CLI. */
+export function removeDesktopFirstParty(
+  config: Pick<OcxConfig, "claudeCode" | "runtimeRole">,
+  options: DesktopFirstPartyOptions = {},
+): ClaudeInterceptSettingsWrite & { retainedFor?: "cli" } {
+  if (config.claudeCode?.cliFirstParty === true) {
+    return { ok: true, changed: false, path: join(options.claudeConfigDir ?? claudeConfigDir(), "settings.json"), retainedFor: "cli" };
+  }
   const caCertPath = claudeInterceptCaCertPath(options.opencodexConfigDir ?? getConfigDir());
   return removeClaudeInterceptSettings(caCertPath, options.claudeConfigDir);
 }
```

`retainedFor` is a success annotation, not proof that a file exists or matches current proxy credentials. The direct `cliFirstParty === true` check has the same meaning as `cliFirstPartyDesired(config)` without a circular import from `desktop-first-party.ts` into `first-party-settings.ts`. Retention does not depend on intercept liveness. wp4 reads `readFirstPartyProxyStatus(config, boundProxyPort)` for GET and post-removal residual warnings; `"live"` requires an applied settings pair and the actual bound port. Unreadable settings are `"unknown"`; a token-bearing proxy with a foreign CA is `"foreign"`; a tokenless loopback proxy with a foreign CA is `"local"`. `"disabled"` requires a usable applied pair and an ineligible bound listener; stale ports or tokens are `"broken"` even when routing is ineligible.

### CLI gateway apply — `src/cli/claude-desktop.ts:425` `const modeSaved = saveDesktopMode("gateway", deps);`

```diff
@@
-  const removed = removeDesktopFirstParty();
+  const removed = removeDesktopFirstParty(loadConfig());
   if (!removed.ok) return { ok: false, path: removed.path, reason: "first_party_settings_unreadable",
     warning: ["gateway applied; first-party cleanup remains incomplete", warning].filter(Boolean).join(" ") };
+  if (removed.retainedFor === "cli") {
+    return { ...result, warning: [warning, "Shared first-party settings remain for Claude Code CLI."].filter(Boolean).join(" ") };
+  }
   if (warning) return { ...result, warning };
```

### Ensure cleanup — `src/cli/ensure-desired-integrations.ts:182` `const env = (deps.removeDesktopFirstParty ?? removeDesktopFirstParty)();`

```diff
@@
-    const env = (deps.removeDesktopFirstParty ?? removeDesktopFirstParty)();
+    const env = (deps.removeDesktopFirstParty ?? removeDesktopFirstParty)(deps.loadConfig());
     if (env.ok && env.changed) log("   ↩️  Claude Desktop first-party env removed.");
+    else if (env.ok && env.retainedFor === "cli") log("   = Shared first-party env retained for Claude Code CLI.");
     else if (!env.ok) error(`⚠️  Claude Desktop first-party env cleanup skipped: ${env.reason} (${env.path}).`);
```

### Desktop apply API — `src/server/management/agent-settings-routes.ts:1226` `const committed = persistCommittedDesktopGateway(config, state.profile, result.fingerprint);`

```diff
@@
-        const firstPartyRemoved = removeDesktopFirstParty();
+        const firstPartyRemoved = removeDesktopFirstParty(loadConfig());
@@
@@
-        return { result, committed, modeWarning, pickerOff };
+        return { result, committed, modeWarning, pickerOff, firstPartyRemoved };
@@
-      const { result, committed, modeWarning, pickerOff } = outcome as Exclude<typeof outcome, { response: Response }>;
+      const { result, committed, modeWarning, pickerOff, firstPartyRemoved } = outcome as Exclude<typeof outcome, { response: Response }>;
@@
-      const warning = [modeWarning, policyWarning, pickerWarning].filter(Boolean).join(" ");
+      const warning = [modeWarning, policyWarning, pickerWarning,
+        firstPartyRemoved.retainedFor === "cli"
+          ? "Shared first-party settings remain for Claude Code CLI." : undefined].filter(Boolean).join(" ");
```

### Native Desktop toggle — `src/server/management/native-integration-routes.ts:714` `const firstPartyRemoved = removeDesktopFirstParty();`; `:819` `const removed = removeDesktopFirstParty();`

```diff
@@
-        const firstPartyRemoved = removeDesktopFirstParty();
+        const firstPartyRemoved = removeDesktopFirstParty(loadConfig());
@@
             changed ? "Claude Desktop integration disabled." : "Claude Desktop integration is already off.",
+            firstPartyRemoved.retainedFor === "cli" ? "Shared first-party settings remain for Claude Code CLI." : "",
             pickerCleanupNote(pickerOff),
@@
-        const removed = removeDesktopFirstParty();
+        const removed = removeDesktopFirstParty(loadConfig());
         if (!removed.ok) return postCommitRefusal(500, "claude-desktop", "write_failed", "Gateway applied, but first-party settings cleanup did not complete." + stateWarning, { desiredEnabled: latestDesiredEnabled });
@@
             stateWarning,
+            removed.retainedFor === "cli" ? "Shared first-party settings remain for Claude Code CLI." : "",
             pickerCleanupNote(pickerOff),
```

### Config structure contract — `structure/config.md:126` `` `claudeCode.desktopProfile` follows the same preserve-the-rest rule.``

```diff
@@ -126,1 +126,3 @@
 `claudeCode.desktopProfile` follows the same preserve-the-rest rule. JSON `null` (or any non-string) `appliedFingerprint` / `appliedAt` is treated as unset. A profile that is still invalid after that is dropped as a whole — `src/config/salvage.ts` already does this for independent `routingProfiles` / `combos` entries — so one bad Desktop marker cannot replace the operator's providers with `getDefaultConfig()`. A `claudeCode` value that is not an object still fails the document, because there is no safe subtree to keep.
+
+`claudeCode.cliFirstParty` is an optional boolean in `src/types/config.ts`. The schema passes it through; the load normalizer (`src/config/load-degrade.ts`) drops a non-boolean hand edit, every reader treats only `true` as on, and `PUT /api/claude-code` accepts only a boolean. Absence means off. It is independent of `claudeCode.desktopMode`; enabling CLI first-party pins an absent Desktop mode from a pre-write observation, before writing the shared settings env, so later Desktop inference cannot mistake a CLI-only env for Desktop intent. The shared settings proxy status follows the ordered classifier in `src/claude/first-party-settings.ts`: unreadable settings are `unknown`; absent or unrecognized proxy URLs are `none`; a token-bearing opencodex URL beside a foreign CA is `foreign`, while a tokenless loopback URL beside that CA is `local` with unconfirmed ownership. An attributed proxy with no bound listener is `stopped`; a usable applied pair on a bound listener is `disabled` when Claude routing is ineligible and `live` when eligible; remaining mismatches are `broken` regardless of eligibility. Inspection never mints a token. A separate `ocx ensure` may write a config-derived port while this server remains bound elsewhere; status is then `broken` until the server restarts or ensure runs after restart.
```

### Desktop inference structure contract — `structure/clients/claude-desktop.md:48-52` `` `resolveClaudeDesktopMode` uses observations from `observeClaudeDesktopMode` in this order:``

```diff
@@ -48,5 +48,8 @@
-`resolveClaudeDesktopMode` uses observations from `observeClaudeDesktopMode` in this order:
-explicit `claudeCode.desktopMode` → selected owned gateway row → persisted
-`desktopProfile.appliedFingerprint` → owned first-party env in `~/.claude/settings.json` →
-gateway. The owned env observation preserves first-party installs applied before mode persistence;
-foreign proxy settings do not count. `resolveClaudeDesktopApplyMode` preserves the resolved mode.
+`resolveClaudeDesktopMode` uses observations from `observeClaudeDesktopMode` in this order:
+explicit `claudeCode.desktopMode` → selected owned gateway row → persisted
+`desktopProfile.appliedFingerprint` → legacy Desktop-owned first-party env →
+gateway. This env observation preserves Desktop installs that predate mode persistence
+only while CLI first-party intent is off. An owned env observed with
+`claudeCode.cliFirstParty === true` is not Desktop-mode evidence, even when the
+intercept is disabled; foreign proxy settings do not count.
+`resolveClaudeDesktopApplyMode` preserves the resolved mode.
```

The inference and Desktop-disable clauses belong in wp2 with their owning source changes; the relay paragraph belongs to wp3.

### Desktop disable structure contract — `structure/clients/claude-desktop.md:73-75`

```diff
@@ -73,3 +73,3 @@
-Disabling the integration (native toggle, `ocx ensure` with the durable switch OFF) removes both the
-gateway profile and the first-party env. With the switch ON in first-party mode, `ocx ensure`
-re-applies a stale env (the proxy port follows the public port).
+Disabling Desktop integration removes its gateway profile. It removes the owned first-party env
+only when `claudeCode.cliFirstParty` is not set; otherwise the env stays for the CLI. With Desktop
+first-party ON, `ocx ensure` re-applies a stale env; the proxy port follows the public port.
```

This paragraph ships with the wp2 removal behavior. A later ensure may write a config-derived port while a server is still bound on the old one; status then reads `broken` until the server restarts or ensure runs after restart.

### Existing test signature — `tests/claude-integration/claude-desktop-first-party.test.ts:142` `const removed = removeDesktopFirstParty();`; `:152` `expect(removeDesktopFirstParty()).toMatchObject({ ok: true, changed: false });`

```diff
@@
-  const removed = removeDesktopFirstParty();
+  const removed = removeDesktopFirstParty(config());
@@
-  expect(removeDesktopFirstParty()).toMatchObject({ ok: true, changed: false });
+  expect(removeDesktopFirstParty(config())).toMatchObject({ ok: true, changed: false });
```

The injected `removeDesktopFirstParty: () => ...` at `:481` remains valid because TypeScript permits a zero-argument function to implement a one-argument callback. Its assertion still exercises the branch.

### New focused test — NEW `tests/claude-integration/claude-first-party-union.test.ts`; anchor sibling `tests/claude-integration/claude-desktop-first-party.test.ts:54` `beforeEach(() => {`

```diff
--- /dev/null
+++ b/tests/claude-integration/claude-first-party-union.test.ts
@@
+import { afterEach, beforeEach, expect, test } from "bun:test";
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { applyDesktopFirstParty, observeClaudeDesktopMode, removeDesktopFirstParty, resolveClaudeDesktopMode } from "../../src/claude/desktop-first-party";
+import { firstPartyDesired, firstPartyProxyStatus, readFirstPartyProxyStatus, reconcileClaudeFirstPartySettings, type FirstPartyProxyStatus } from "../../src/claude/first-party-settings";
+import { claudeInterceptCaCertPath } from "../../src/claude/intercept/local-ca";
+import { claudeInterceptProxyTokenPath } from "../../src/claude/intercept/proxy-auth";
+import type { ClaudeInterceptSettingsState } from "../../src/claude/intercept/settings";
+import { configSchema } from "../../src/config/schema/config-schema";
+import { normalizePersistedClaudeCode } from "../../src/config/load-degrade";
+import { loadConfig } from "../../src/config";
+import { cliFirstPartyDesired } from "../../src/claude/first-party-settings";
+import type { OcxConfig } from "../../src/types";
+import { removeTreeWithRetry } from "../helpers/remove-tree";
+
+let root = "";
+let claudeHome = "";
+let oldLibrary: string | undefined;
+function cfg(desktop: boolean, cli: boolean, extra: Partial<OcxConfig> = {}): OcxConfig {
+  return { port: 10100, defaultProvider: "openai", providers: {},
+    clientIntegrations: { "claude-desktop": desktop },
+    claudeCode: { desktopMode: "first-party", cliFirstParty: cli }, ...extra } as OcxConfig;
+}
+const options = () => ({ opencodexConfigDir: root, claudeConfigDir: claudeHome });
+function env(): Record<string, string> | undefined {
+  if (!existsSync(join(claudeHome, "settings.json"))) return undefined;
+  return (JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8")) as { env?: Record<string, string> }).env;
+}
+beforeEach(() => {
+  root = mkdtempSync(join(tmpdir(), "ocx-claude-union-"));
+  claudeHome = join(root, "claude");
+  oldLibrary = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
+  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "library");
+});
+afterEach(() => {
+  if (oldLibrary === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
+  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = oldLibrary;
+  removeTreeWithRetry(root);
+});
+
+const shapedProxy = "http://opencodex:token@127.0.0.1:10200";
+const olderProxy = "http://opencodex:token@127.0.0.1:10000";
+test.each([
+  { name: "absent", settings: { kind: "absent" }, boundProxyPort: null, eligible: true, expected: "none" },
+  { name: "unreadable wins over all other inputs", settings: { kind: "unreadable", path: "settings.json" }, boundProxyPort: null, eligible: false, expected: "unknown" },
+  { name: "absent wins over disabled", settings: { kind: "absent" }, boundProxyPort: 10200, eligible: false, expected: "none" },
+  { name: "applied on bound port", settings: { kind: "applied", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "live" },
+  { name: "default HTTP port 80", settings: { kind: "applied", env: { HTTPS_PROXY: "http://opencodex:t@127.0.0.1:80", NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 80, eligible: true, expected: "live" },
+  { name: "applied with no listener", settings: { kind: "applied", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: null, eligible: true, expected: "stopped" },
+  { name: "no listener before ineligible", settings: { kind: "applied", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: null, eligible: false, expected: "stopped" },
+  { name: "applied on bound port but ineligible", settings: { kind: "applied", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: false, expected: "disabled" },
+  { name: "stale older port and ineligible", settings: { kind: "stale", env: { HTTPS_PROXY: olderProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: false, expected: "broken" },
+  { name: "token drift on bound port and ineligible", settings: { kind: "stale", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: false, expected: "broken" },
+  { name: "stale older port", settings: { kind: "stale", env: { HTTPS_PROXY: olderProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "broken" },
+  { name: "stale matching port is still broken", settings: { kind: "stale", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "broken" },
+  { name: "malformed port cannot match", settings: { kind: "stale", env: { HTTPS_PROXY: "http://opencodex:t@127.0.0.1:99999", NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "broken" },
+  { name: "foreign CA with opencodex token", settings: { kind: "foreign", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/foreign/ca.pem" } }, boundProxyPort: null, eligible: false, expected: "foreign" },
+  { name: "foreign CA with tokenless loopback", settings: { kind: "foreign", env: { HTTPS_PROXY: "http://127.0.0.1:10200", NODE_EXTRA_CA_CERTS: "/foreign/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "local" },
+  { name: "CA-only stale", settings: { kind: "stale", env: { NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "none" },
+  { name: "foreign proxy URL", settings: { kind: "foreign", env: { HTTPS_PROXY: "http://proxy.corp:8080", NODE_EXTRA_CA_CERTS: "/foreign/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "none" },
+] as { name: string; settings: ClaudeInterceptSettingsState; boundProxyPort: number | null; eligible: boolean; expected: FirstPartyProxyStatus }[])(
+  "$name -> $expected", ({ settings, boundProxyPort, eligible, expected }) => {
+    expect(firstPartyProxyStatus({ settings, boundProxyPort, eligible })).toBe(expected);
+  },
+);
+
+test("readFirstPartyProxyStatus reads temp settings without creating a proxy token", () => {
+  const config = cfg(false, true);
+  const tokenPath = claudeInterceptProxyTokenPath(root);
+  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("none");
+  expect(existsSync(tokenPath)).toBe(false);
+  mkdirSync(claudeHome, { recursive: true });
+  const path = join(claudeHome, "settings.json");
+  writeFileSync(path, "{broken");
+  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("unknown");
+  expect(existsSync(tokenPath)).toBe(false);
+  writeFileSync(path, JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: claudeInterceptCaCertPath(root) } }));
+  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("none");
+  expect(existsSync(tokenPath)).toBe(false);
+  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: olderProxy, NODE_EXTRA_CA_CERTS: claudeInterceptCaCertPath(root) } }));
+  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("broken");
+  expect(readFirstPartyProxyStatus(config, null, options())).toBe("stopped");
+  expect(existsSync(tokenPath)).toBe(false);
+  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/foreign/ca.pem" } }));
+  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("foreign");
+  expect(existsSync(tokenPath)).toBe(false);
+  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:10200", NODE_EXTRA_CA_CERTS: "/foreign/ca.pem" } }));
+  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("local");
+  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: "http://proxy.corp:8080" } }));
+  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("none");
+  expect(existsSync(tokenPath)).toBe(false);
+  writeFileSync(path, JSON.stringify({ env: {} }));
+  expect(applyDesktopFirstParty(config, options()).ok).toBe(true);
+  expect(existsSync(tokenPath)).toBe(true); // created by apply, before the read
+  const tokenBefore = readFileSync(tokenPath, "utf8");
+  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("live");
+  expect(readFileSync(tokenPath, "utf8")).toBe(tokenBefore);
+});
+
+test.each([[false, false], [false, true], [true, false], [true, true]] as const)(
+  "desired desktop=%p cli=%p uses the same owned pair iff either wants it",
+  (desktop, cli) => {
+    const config = cfg(desktop, cli);
+    const desired = firstPartyDesired(config);
+    expect(desired).toEqual({ desktop, cli });
+    const result = reconcileClaudeFirstPartySettings(config, desired, options());
+    expect(result.ok).toBe(true);
+    expect(Boolean(env()?.NODE_EXTRA_CA_CERTS)).toBe(desktop || cli);
+    if (desktop || cli) {
+      expect(env()?.NODE_EXTRA_CA_CERTS).toBe(claudeInterceptCaCertPath(root));
+      expect(env()?.HTTPS_PROXY).toContain("127.0.0.1:10200");
+      expect(reconcileClaudeFirstPartySettings(config, desired, options())).toMatchObject({ ok: true, action: "unchanged", changed: false });
+    } else {
+      expect(result).toMatchObject({ ok: true, action: "unchanged", changed: false });
+    }
+  },
+);
+
+test("Desktop on, CLI on, Desktop off retains env; CLI off removes it", () => {
+  const desktop = cfg(true, false);
+  expect(reconcileClaudeFirstPartySettings(desktop, firstPartyDesired(desktop), options())).toMatchObject({ action: "applied" });
+  const both = cfg(true, true);
+  expect(reconcileClaudeFirstPartySettings(both, firstPartyDesired(both), options())).toMatchObject({ action: "unchanged" });
+  const cli = cfg(false, true);
+  expect(removeDesktopFirstParty(cli, options())).toMatchObject({ ok: true, changed: false, retainedFor: "cli" });
+  expect(env()?.NODE_EXTRA_CA_CERTS).toBe(claudeInterceptCaCertPath(root));
+  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options())).toMatchObject({ action: "unchanged" });
+  const none = cfg(false, false);
+  expect(reconcileClaudeFirstPartySettings(none, firstPartyDesired(none), options())).toMatchObject({ action: "removed", changed: true });
+  expect(env()).toBeUndefined();
+});
+
+test("CLI on, Desktop on, CLI off retains env; Desktop off removes it", () => {
+  const cli = cfg(false, true);
+  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options())).toMatchObject({ action: "applied" });
+  const both = cfg(true, true);
+  expect(reconcileClaudeFirstPartySettings(both, firstPartyDesired(both), options())).toMatchObject({ action: "unchanged" });
+  const desktop = cfg(true, false);
+  expect(reconcileClaudeFirstPartySettings(desktop, firstPartyDesired(desktop), options())).toMatchObject({ action: "unchanged" });
+  expect(env()?.NODE_EXTRA_CA_CERTS).toBe(claudeInterceptCaCertPath(root));
+  const none = cfg(false, false);
+  expect(removeDesktopFirstParty(none, options())).toMatchObject({ ok: true, changed: true });
+  expect(env()).toBeUndefined();
+});
+
+test("foreign env is refused and preserved; unreadable settings is refused", () => {
+  mkdirSync(claudeHome, { recursive: true });
+  const path = join(claudeHome, "settings.json");
+  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: "http://corp-proxy:3128" } }));
+  const cli = cfg(false, true);
+  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options())).toMatchObject({ ok: false, reason: "foreign_env" });
+  expect(env()?.HTTPS_PROXY).toBe("http://corp-proxy:3128");
+  writeFileSync(path, "{broken");
+  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options())).toMatchObject({ ok: false, reason: "unreadable" });
+  expect(readFileSync(path, "utf8")).toBe("{broken");
+});
+
+test("stale owned proxy is refreshed, while a foreign CA is never replaced", () => {
+  const cli = cfg(false, true);
+  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options())).toMatchObject({ action: "applied" });
+  const path = join(claudeHome, "settings.json");
+  const oldProxy = env()?.HTTPS_PROXY;
+  const moved = cfg(false, true, { port: 10300 });
+  expect(reconcileClaudeFirstPartySettings(moved, firstPartyDesired(moved), options()))
+    .toMatchObject({ ok: true, action: "applied", changed: true });
+  expect(env()?.HTTPS_PROXY).not.toBe(oldProxy);
+  expect(env()?.HTTPS_PROXY).toContain("127.0.0.1:10400");
+  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:8080", NODE_EXTRA_CA_CERTS: "/etc/foreign-ca.pem" } }));
+  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options()))
+    .toMatchObject({ ok: false, reason: "foreign_env" });
+  expect(env()).toEqual({ HTTPS_PROXY: "http://127.0.0.1:8080", NODE_EXTRA_CA_CERTS: "/etc/foreign-ca.pem" });
+});
+
+test("legacy owned env infers Desktop only without CLI intent", () => {
+  const legacy = cfg(true, false, { claudeCode: {} });
+  expect(applyDesktopFirstParty(legacy, options()).ok).toBe(true);
+  expect(observeClaudeDesktopMode(legacy, options()).ownedFirstPartySettings).toBe(true);
+  expect(resolveClaudeDesktopMode(legacy, observeClaudeDesktopMode(legacy, options()))).toBe("first-party");
+  const cli = cfg(true, true, { claudeCode: { cliFirstParty: true } });
+  expect(observeClaudeDesktopMode(cli, options()).ownedFirstPartySettings).toBe(false);
+  expect(resolveClaudeDesktopMode(cli, observeClaudeDesktopMode(cli, options()))).toBe("gateway");
+  const disabledCli = cfg(true, true, { claudeCode: { cliFirstParty: true, intercept: { enabled: false } } });
+  expect(observeClaudeDesktopMode(disabledCli, options()).ownedFirstPartySettings).toBe(false);
+});
+
+test("disabled intercept retains desired env; malformed persisted intent degrades off", () => {
+  const cli = cfg(false, true);
+  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options()).ok).toBe(true);
+  const disabled = cfg(false, true, { claudeCode: { cliFirstParty: true, intercept: { enabled: false } } });
+  const before = readFileSync(join(claudeHome, "settings.json"), "utf8");
+  expect(reconcileClaudeFirstPartySettings(disabled, firstPartyDesired(disabled), options()))
+    .toMatchObject({ ok: true, action: "unchanged", changed: false });
+  expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toBe(before);
+  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ env: { ...env(), USER_ENV: "kept" } }));
+  const none = cfg(false, false, { claudeCode: { intercept: { enabled: false } } });
+  expect(reconcileClaudeFirstPartySettings(none, firstPartyDesired(none), options()))
+    .toMatchObject({ ok: true, action: "removed", changed: true });
+  expect(env()).toEqual({ USER_ENV: "kept" });
+  expect(normalizePersistedClaudeCode({ cliFirstParty: "yes" })).toEqual({});
+  expect(normalizePersistedClaudeCode({ cliFirstParty: true })).toEqual({ cliFirstParty: true });
+  const base = { port: 0, defaultProvider: "openai", providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" } } };
+  // passthrough schema: a malformed value parses, so a hand-edited config never takes the fallback path
+  expect(configSchema.safeParse({ ...base, claudeCode: { cliFirstParty: true } }).success).toBe(true);
+  expect(configSchema.safeParse({ ...base, claudeCode: { cliFirstParty: "yes" } }).success).toBe(true);
+});
+
+test("a malformed cliFirstParty in config.json loads as off and keeps the providers", () => {
+  // Real load path, same temp-home pattern as tests/server/config.test.ts:56-83.
+  const previousHome = process.env.OPENCODEX_HOME;
+  process.env.OPENCODEX_HOME = root;
+  const base = { port: 0, defaultProvider: "openai", providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" } } };
+  writeFileSync(join(root, "config.json"), JSON.stringify({ ...base, claudeCode: { cliFirstParty: "yes" } }));
+  let loaded: OcxConfig;
+  try { loaded = loadConfig(); } finally {
+    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
+  }
+  expect(Object.keys(loaded.providers)).toContain("openai");
+  expect(loaded.claudeCode?.cliFirstParty).toBeUndefined();
+  expect(cliFirstPartyDesired(loaded)).toBe(false);
+});
+
+test.each([
+  { name: "client role", patch: { runtimeRole: "client" as const } },
+  { name: "Claude disabled", patch: { claudeCode: { cliFirstParty: true, enabled: false } } },
+  { name: "intercept disabled", patch: { claudeCode: { cliFirstParty: true, intercept: { enabled: false } } } },
+])("$name retains an owned env while CLI intent remains", ({ patch }) => {
+  const cli = cfg(false, true);
+  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options()).ok).toBe(true);
+  const disabled = cfg(false, true, patch);
+  const before = readFileSync(join(claudeHome, "settings.json"), "utf8");
+  expect(reconcileClaudeFirstPartySettings(disabled, firstPartyDesired(disabled), options()))
+    .toMatchObject({ ok: true, action: "unchanged", changed: false });
+  expect(removeDesktopFirstParty(disabled, options()))
+    .toMatchObject({ ok: true, changed: false, retainedFor: "cli" });
+  expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toBe(before);
+});
+
+test("disabled Desktop intent leaves even unreadable settings untouched", () => {
+  mkdirSync(claudeHome, { recursive: true });
+  const path = join(claudeHome, "settings.json");
+  writeFileSync(path, "{broken");
+  const disabled = cfg(true, false, { claudeCode: { desktopMode: "first-party", intercept: { enabled: false } } });
+  expect(firstPartyDesired(disabled)).toEqual({ desktop: true, cli: false });
+  expect(reconcileClaudeFirstPartySettings(disabled, firstPartyDesired(disabled), options()))
+    .toMatchObject({ ok: true, action: "unchanged", changed: false, path });
+  expect(readFileSync(path, "utf8")).toBe("{broken");
+});
+
+test("remove on absent settings is unchanged; corrupt removal preserves bytes", () => {
+  const none = cfg(false, false);
+  expect(reconcileClaudeFirstPartySettings(none, firstPartyDesired(none), options()))
+    .toMatchObject({ ok: true, action: "unchanged", changed: false });
+  mkdirSync(claudeHome, { recursive: true });
+  const path = join(claudeHome, "settings.json");
+  writeFileSync(path, "{broken");
+  expect(reconcileClaudeFirstPartySettings(none, firstPartyDesired(none), options()))
+    .toMatchObject({ ok: false, reason: "unreadable" });
+  expect(readFileSync(path, "utf8")).toBe("{broken");
+});
+
+test("CA preparation failure does not create settings", () => {
+  const blocked = join(root, "not-a-directory");
+  writeFileSync(blocked, "file");
+  const cli = cfg(false, true);
+  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli),
+    { opencodexConfigDir: blocked, claudeConfigDir: claudeHome }))
+    .toMatchObject({ ok: false, reason: "ca_unavailable" });
+  expect(existsSync(join(claudeHome, "settings.json"))).toBe(false);
+});
```

The test above intentionally uses the real writer and temp settings file. These are deterministic temp-path tests, never live paths.

### Test layout — `scripts/test-layout/layout.json:458` `"claude-dotenv-provenance-transport.test.ts": "claude-integration",`; `tests/fixtures/test-layout-expected.json:284` `"claude-dotenv-provenance-transport.test.ts": "claude-integration",`

```diff
@@ scripts/test-layout/layout.json
     "claude-dotenv-provenance-transport.test.ts": "claude-integration",
+    "claude-first-party-union.test.ts": "claude-integration",
@@ tests/fixtures/test-layout-expected.json
   "claude-dotenv-provenance-transport.test.ts": "claude-integration",
+  "claude-first-party-union.test.ts": "claude-integration",
```

Keep both JSON maps in their existing alphabetical order at B. The test imports by relative module path and uses `tests/helpers/remove-tree.ts`; source-oracle tests, if added, must use `repoPath()` from `tests/helpers/repo-root.ts` rather than `import.meta.dir + "/.."`.

## PLAN-FIELD-CHAIN-01

| New value | Creation | Serialization | Deserialization and unknown handling | Every consumer |
|---|---|---|---|---|
| `claudeCode.cliFirstParty?: boolean` | wp2 hand-edited `config.json` and typed `OcxClaudeCodeConfig`; wp4 `PUT /api/claude-code` and `ocx claude config set --first-party` | `src/config/live-reconcile.ts:425` and `src/config/persisted-mutation.ts:37` persist the `claudeCode` subtree; wp4 CLI-on writes the bit with an absent Desktop-mode pin in one field-scoped mutation and CLI-off deletes the bit | schema passthrough (`src/config/schema/config-schema.ts:292`, no rule); `src/config/load-degrade.ts:542` removes malformed values after parse; absent/false are off | `src/claude/first-party-settings.ts` desires/reconcile, retaining a desired env while disabled; `src/claude/desktop-first-party.ts` observe/remove regardless of liveness; `structure/config.md` and `structure/clients/claude-desktop.md` document intent/inference; wp3 intercept lifecycle callback/classifier; wp4 GET/PUT and CLI; wp5 GUI/docs |
| `ClaudeFirstPartyClient = "desktop" \| "cli"` | Pure type in `first-party-settings.ts` | N/A: never serialized | N/A: never parsed from wire | N/A in wp2: exported vocabulary for wp3 classifier; do not add dead runtime state |
| `ClaudeFirstPartyDesired.desktop/cli` | `firstPartyDesired()` and explicit wp2 test snapshots | N/A: in-process callback value only | N/A: no stored form | `reconcileClaudeFirstPartySettings` (empty pair removes; desired pair with disabled intercept is unchanged); wp3 `desiredClients` and `interceptRouteFor` |
| `FirstPartyProxyStatus` (eight literals in source diff above) | `firstPartyProxyStatus` computes from `ClaudeInterceptSettingsState`, actual `boundProxyPort`, and `claudeInterceptEnabled(config)` in the ordered source diff above; `readFirstPartyProxyStatus` obtains the read-only inspection | wp4 GET serializes as `sharedProxy`; PUT emits `settings_residual` after empty-desired reconciliation when status is not `none` (the existing unreadable 500 refusal precedes an `unknown` warning) | wp5 `ClaudeCodeState.sharedProxy` accepts all eight values; only `undefined` normalizes to `none`; `null` and other unrecognized values normalize to `unknown` | wp4 GET derives `cliFirstPartyApplied` from CLI intent and `sharedProxy === "live"`, `interceptRunning` from bound port plus eligibility; wp4 PUT residual warning includes `local`; wp5 selector consumes all statuses and both intents in the precedence table below. `broken` also covers ineligible stale ports/tokens. |
| Reconcile `action` values `applied/removed/unchanged` | `reconcileClaudeFirstPartySettings` | N/A: wp2 local return only | N/A: closed local union | wp2 tests distinguish disabled desired `unchanged` from empty desired `removed`; wp4 route may map to response state |
| Removal `retainedFor:"cli"` | `removeDesktopFirstParty` whenever CLI bit is true, independent of intercept liveness | N/A: transient return only | N/A: no persisted form | CLI apply warning, ensure log, Desktop apply response warning, native toggle messages, wp2 tests |

The wp4 GET derives `cliFirstPartyApplied = cliFirstParty && sharedProxy === "live"` and `interceptRunning = boundProxyPort !== null && eligible`. After a successful reconcile with neither client desired, PUT reports `warnings:["settings_residual"]` for every `sharedProxy !== "none"`; unreadable settings already return 500 before this branch. These are consumers of the classifier, not alternate status definitions.

The wp5 notice selector, its normalization, the exhaustiveness constant and all GUI copy are defined once in `040_surfaces.md` (G-contract, including `interceptEligible` and `routingOff`); wp2 owns only the classifier above.

## Activation and observable assertions

| Conditional path | Activation | Assertion |
|---|---|---|
| Four desired pairs | Explicit Desktop mode, integration bit and CLI bit matrix | `firstPartyDesired` exact pair; env exists iff either bit |
| Both enable orders and both disable orders | Apply first client, add second, remove first, remove last | One pair, unchanged while one remains, removed when both off |
| Desktop removal with CLI on, including stopped intercept | `removeDesktopFirstParty(cliConfig, tempOptions)` with each liveness gate disabled | `retainedFor:"cli"`, `changed:false`, same env bytes |
| Reconcile with desired client but intercept off/client role/Claude disabled | Existing owned CLI env, disable each gate; also Desktop-only intent with corrupt settings and disabled intercept | `action:"unchanged"`, `changed:false`, same env bytes; corrupt settings cannot cause a refusal because the branch does not read the file |
| Reconcile with no desired clients and disabled intercept | Existing owned env, both desired bits false, disable intercept | owned keys removed, unrelated keys preserved |
| Existing correct/stale/foreign env | Apply twice; change port; inject corporate proxy/foreign CA | unchanged; refreshed; `foreign_env` with byte-for-byte preservation |
| Eight-state shared proxy classification | The executable table above supplies unreadable and absent priority, unrecognized URL, foreign CA with token and without token, no listener plus ineligible, eligible and ineligible bound listeners, applied matching port including explicit `:80`, stale port/token, CA-only stale, and foreign URL | Exact `unknown/none/foreign/local/stopped/disabled/live/broken` result for each row; `:80` matches bound port 80; a tokenless loopback next to a foreign CA is `local`; ineligible stale values are `broken` |
| Read-only status inspection | Real temp `settings.json` iterates absent, corrupt, CA-only, old-port (bound and null), foreign CA with token, foreign CA without token, foreign URL, and applied; call `readFirstPartyProxyStatus` with the listed ports | Status matches `none/unknown/none/broken/stopped/foreign/local/none/live` respectively; `claude-intercept/proxy-token` stays absent until explicit `applyDesktopFirstParty`, and its bytes do not change on subsequent status read |
| CLI-off residual warning for legacy local proxy | wp4 route test writes tokenless `http://127.0.0.1:10200` plus foreign CA, then turns CLI intent off | 200 with `warnings:["settings_residual"]`; foreign-owned settings bytes remain untouched because every status other than `none`, including `local`, triggers the warning |
| Missing/corrupt settings | Fresh temp dir; invalid JSON on apply/remove | fresh apply creates; corrupt returns `unreadable`, bytes preserved |
| CA/token unavailable | Config directory is a regular file | `ca_unavailable`, no settings write |
| Legacy inference | Owned env with absent `desktopMode`, CLI off/on; explicit Desktop mode and gateway marker cases | CLI off infers first-party, CLI on does not; explicit/marker precedence unchanged |
| Malformed intent | Hand-edited `config.json` with `cliFirstParty: "yes"` loaded by `loadConfig()` | schema parses (no fallback); normalizer drops the key; providers kept; `cliFirstPartyDesired` false |
| Caller output | CLI gateway apply, ensure, API apply, native off/gateway with CLI bit on | success reports env retained for CLI; no false cleanup warning |

`tests/claude-integration/claude-desktop-first-party.test.ts` and `claude-desktop-first-party-guards.test.ts` already exercise real CLI/API transitions; add retained-message assertions there during B as needed, keeping new matrix tests in the new file so the large test does not grow. The new test layout entries are mandatory before invoking the layout gate.

## Verifiers actually run in this planning pass

| Command | Exit | Reads wp2 target? |
|---|---:|---|
| `rg -n 'removeDesktopFirstParty' src tests` | 0 | Yes: direct source/test symbol scan; found every call above. |
| `rg -n 'include\|src/\|tests/' tsconfig.json` | 0 | `tsconfig.json:15` is `"include": ["src"]`; typecheck will read new source, not tests or this prose. |
| `bun test tests/claude-integration/claude-intercept-settings.test.ts tests/claude-integration/claude-desktop-first-party.test.ts` | 1 | Direct target-file arguments; 0 tests ran because this worktree cannot resolve `zod/v4`. Not passing evidence. |
| `bun test tests/claude-integration/claude-intercept-settings.test.ts tests/claude-integration/claude-desktop-first-party.test.ts` (revision 2, after `bun install`) | 0 | Direct target-file arguments; 46 passed, 0 failed. These validate the cited existing anchors, not the planned new behavior or this Markdown. |
| `bun test tests/claude-integration/claude-intercept-settings.test.ts` (Replan F) | 0 | 11 passed; confirms current inspector/URL behavior used by the new classifier diff, not the future implementation. |
| `bun -e` inline Markdown evaluator (Replan F) | 0 | Extracted and executed the classifier diff against all 17 documented cases, the selector against all 32 table cells, and the normalizer against 12 values; all passed. No repo file was written by the evaluator. |

At B, after dependencies are available, run `bun test tests/claude-integration/claude-first-party-union.test.ts tests/claude-integration/claude-desktop-first-party.test.ts tests/claude-integration/claude-desktop-first-party-guards.test.ts tests/claude-integration/claude-intercept-settings.test.ts`, `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts`, `bun run typecheck`, `bun run structure:check`, and `bun run privacy:scan`. These are future commands, not represented as executed here. `tsconfig.json:15` covers source; the focused Bun arguments cover tests; the layout guards read the two JSON maps. `structure:check` reads the owning structure docs. This Markdown PRD itself is human-review evidence, not an observed target of those gates.

## Risks, bypass, and questions for main

The shared env is not a client identity marker. With Desktop-only intent, terminal Claude still traverses local TLS, and vice versa; wp3 relays requests whose client intent is off. `retainedFor` says why cleanup skipped, not whether the env is healthy. Stale config reads across asynchronous Desktop transitions can remove an env just enabled by another writer; each caller must read persisted config at removal time, and wp4 must serialize its toggle with the existing Desktop/picker transition lock. The `firstPartyDesired` helper is pure and must be called with the pre-toggle observed Desktop mode when pinning legacy mode; observing after CLI on would erase that evidence.

PLAN-BYPASS-NAMED-01: tier E5, executing surface `config-schema.ts` plus wp4 management validation; bypass path is a hand edit of `config.json` or a direct local call to the low-level writer; residual risk is a local operator/process can still set settings env or forge later User-Agent; wording is downgraded to validation/early warning, final layer none. Ownership refusal is tier E5 in `intercept/settings.ts`; a process that edits `settings.json` directly bypasses it, so it protects only OpenCodex writes.

Main dispositions M1 and M5 resolve the prior open decisions: wp2 amends `structure/config.md` and the Desktop inference and disable clauses in `structure/clients/claude-desktop.md` with their owning source; wp4 takes the Desktop-mode observation before its field-scoped CLI-on mutation, then pins an absent mode with the CLI bit. The RP2 port precondition is rechecked against persisted config inside that same locked mutation.

Earlier RP and E notes are superseded by Replan F below.

## Replan F changelog

- F1: Added `local` attribution for tokenless loopback with foreign CA; classified unusable ineligible pairs as `broken` and reserved `disabled` for usable pairs.
- F2: Reordered selector precedence, added all eight statuses × four intent pairs, and specified source-level exhaustiveness and normalization including `null`.
- F3: Updated read-only and route regression expectations, structure/field-chain text, and GUI `unknown`/`local` copy for all ten locales.


## wp2 P amendment (architect stale-check): structure/runtime.md belongs to wp2 too

`structure/INDEX.md:115` maps `src/claude/` and `src/config/` to `structure/runtime.md` as well, so wp2 adds this paragraph
after the "Claude intercept pair" paragraph ending "...first-party model bindings (`claudeCode.intercept.modelMap`); see
[Claude Desktop](clients/claude-desktop.md#first-party-model-bindings)." (`structure/runtime.md:237-256`). File map row:
`structure/runtime.md | MODIFY | shared settings env ownership and proxy status`.

> Two independent intents can want that settings env: Desktop first-party mode and `claudeCode.cliFirstParty` for the
> standalone CLI. `src/claude/first-party-settings.ts` owns the union: `reconcileClaudeFirstPartySettings` writes the
> owned pair while either intent is on, keeps the file untouched while an intent is on but the intercept cannot run, and
> removes the owned pair only when neither intent remains. `firstPartyProxyStatus` classifies what the settings file
> currently points at against the bound listener (`none`, `live`, `stopped`, `disabled`, `broken`, `foreign`, `local`,
> `unknown`); it reads the proxy token and never mints it.

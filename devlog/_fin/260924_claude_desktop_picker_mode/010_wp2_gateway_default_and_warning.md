# 010 — wp2: gateway by default, first-party account-risk warning

Consumes: D1, D2 in [000](000_plan.md). Produces the mode contract wp4 builds on.

## Files

| Path | Change |
| --- | --- |
| `src/claude/desktop-first-party.ts` | MODIFY: default constant, observation-aware resolver, observation helper, header comment |
| `src/claude/desktop-risk.ts` | NEW: the single owner of the first-party account-risk text |
| `src/cli/claude-desktop.ts` | MODIFY: help text, `defaultDesktopApplyMode` observes settings, apply prints the risk |
| `src/cli/ensure-desired-integrations.ts` | MODIFY: resolve with observation |
| `src/server/management/agent-settings-routes.ts` | MODIFY: apply default + status `riskWarning` |
| `src/server/management/native-integration-routes.ts` | MODIFY: status/enable observe; enable message carries the risk |
| `src/server/management/config-routes.ts` | MODIFY: `/api/sync` skips the gateway writer when the resolved mode is first-party |
| `src/server/management/agent-settings-routes.ts` (also) | MODIFY: `autoApplyDesktopBestEffort` (:212, the roster-update gateway writer) returns early when the resolved mode is first-party, both before and after its model discovery await |
| `src/types/config.ts` | MODIFY: the `desktopMode` doc comment (:183) names gateway as the default and first-party's risk |
| `tests/claude-integration/claude-desktop-mode-explanation.test.ts` | MODIFY: explanation cases for the new default |
| `structure/gui-and-management-api.md` | MODIFY: the Desktop apply default (:182) is gateway; `riskWarning` in the status payload |
| `gui/src/styles/claude-desktop-mode-picker.css` | MODIFY: header comment (:1) — gateway is the default, first-party is the opt-in with the risk callout (plus the callout style if it fits here) |
| `gui/src/pages/ClaudeDesktop.tsx` (also) | MODIFY: stale comments at :240 and :351 that call first-party the default |
| `gui/src/pages/ClaudeDesktop.tsx` | MODIFY: default badge + fallback mode = gateway; first-party risk callout |
| `gui/src/pages/ClaudeDesktop.tsx` (Desktop status type lives here) | MODIFY: `riskWarning` in the status type |
| `gui/src/i18n/{en,de,fr,ko,zh,zh-TW,ru,ja,tr,vi}.ts` | MODIFY: `claudeDesktop.mode.firstPartyRisk`; hints no longer call first-party the default |
| `docs-site/src/content/docs/{,fr/,ja/,ko/,ru/,tr/,zh-cn/,zh-tw/}guides/claude-code.md` | MODIFY: gateway is the default; caution block in the first-party section |
| `structure/clients/claude-desktop.md` | MODIFY: mode contract (default, legacy observation, risk warning, sync guard) |
| `tests/claude-integration/claude-desktop-first-party.test.ts` | MODIFY: the five default assertions + new cases |

## Diff

`src/claude/desktop-first-party.ts`

```diff
- *   - `first-party` (default): the app keeps its ordinary claude.ai login, …
+ *   - `gateway` (default): the third-party deployment profile (src/claude/desktop-3p.ts) …
+ *   - `first-party`: the app keeps its claude.ai login … Carries an account-risk warning
+ *     (src/claude/desktop-risk.ts).
-export const DEFAULT_CLAUDE_DESKTOP_MODE: ClaudeDesktopMode = "first-party";
+export const DEFAULT_CLAUDE_DESKTOP_MODE: ClaudeDesktopMode = "gateway";
+
+/** What the resolver may learn from disk. Only owned rows and owned settings count. */
+export interface ClaudeDesktopModeObservation {
+  /** Desktop's selected config-library row is our gateway (current or drifted). */
+  ownedGatewaySelected?: boolean;
+  ownedFirstPartySettings?: boolean;
+}
+
+/** Observe owned first-party settings (applied or stale). Never throws; unreadable = none. */
+export function observeClaudeDesktopMode(
+  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole">,
+  options: DesktopFirstPartyOptions = {},
+): ClaudeDesktopModeObservation {
+  const observed: ClaudeDesktopModeObservation = {};
+  try {
+    const library = inspectDesktop3pConfigLibrary({ appliedFingerprint: config.claudeCode?.desktopProfile?.appliedFingerprint ?? null });
+    observed.ownedGatewaySelected = library.kind === "gateway_ours" || library.kind === "gateway_drifted";
+  } catch { /* unreadable library: no gateway evidence */ }
+  try {
+    const kind = inspectDesktopFirstParty(config, options).settings.kind;
+    observed.ownedFirstPartySettings = kind === "applied" || kind === "stale";
+  } catch { /* unreadable settings: no first-party evidence */ }
+  return observed;
+}
-export function resolveClaudeDesktopMode(config: DesktopModeConfig): ClaudeDesktopMode {
+export function resolveClaudeDesktopMode(
+  config: DesktopModeConfig,
+  observed: ClaudeDesktopModeObservation = {},
+): ClaudeDesktopMode {
   const explicit = config.claudeCode?.desktopMode;
   if (isClaudeDesktopMode(explicit)) return explicit;
+  if (observed.ownedGatewaySelected) return "gateway";
   if (config.claudeCode?.desktopProfile?.appliedFingerprint) return "gateway";
+  // An install that applied first-party before the mode was persisted keeps first-party.
+  if (observed.ownedFirstPartySettings) return "first-party";
   return DEFAULT_CLAUDE_DESKTOP_MODE;
 }
 export function resolveClaudeDesktopApplyMode(
   config: Pick<OcxConfig, "claudeCode" | "runtimeRole">,
+  observed: ClaudeDesktopModeObservation = {},
): ClaudeDesktopMode {
-  const resolved = resolveClaudeDesktopMode(config);
+  const resolved = resolveClaudeDesktopMode(config, observed);
-  if (resolved === "gateway" || isClaudeDesktopMode(config.claudeCode?.desktopMode)) return resolved;
-  return claudeInterceptEnabled(config) ? "first-party" : "gateway";
+  return resolved;
```

With gateway as the default, an implied first-party can only come from observed legacy settings,
so the intercept-disabled fallback branch is removed: an observed first-party install keeps its
mode, and an apply with the intercept disabled is refused with `intercept_disabled` exactly like an
explicit first-party (reflection r2 gap 1). `resolveClaudeDesktopApplyMode` stays as the named
entry point callers use; `claudeInterceptEnabled` is no longer imported by it.
`observeClaudeDesktopMode` is placed after `inspectDesktopFirstParty` (it calls it) and reaches
`inspectDesktop3pConfigLibrary` without a new static import cycle (confirm the import graph at P).
Resolver stays pure; callers that decide an apply or a write pass `observeClaudeDesktopMode(config)`.

`src/claude/desktop-risk.ts` (NEW)

```ts
/** Account-risk notice every first-party surface shows. One owner so the wording cannot drift. */
export const FIRST_PARTY_ACCOUNT_RISK = {
  code: "first_party_account_suspension_risk",
  message: "First-party mode sends Claude subscription traffic through a local interception proxy. "
    + "Anthropic may treat this as a violation of its terms and suspend the account. Use it at your own risk; "
    + "gateway mode is the default.",
} as const;
export type FirstPartyAccountRisk = typeof FIRST_PARTY_ACCOUNT_RISK;
```

`src/cli/claude-desktop.ts`

```diff
-      --first-party  (default) keep Desktop on claude.ai; route only the Code tab's Claude Code
-                     through the local intercept proxy via ~/.claude/settings.json env
-      --gateway      install the third-party gateway profile for the whole app
+      --gateway      (default) install the third-party gateway profile for the whole app
+      --first-party  keep Desktop on claude.ai; route only the Code tab's Claude Code through the
+                     local intercept proxy. Risk: Anthropic may suspend the account.
-export function defaultDesktopApplyMode(
-  config: Pick<OcxConfig, "claudeCode" | "runtimeRole">,
+export function defaultDesktopApplyMode(
+  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole">,
-  const resolved = resolveClaudeDesktopApplyMode(config);
+  const resolved = resolveClaudeDesktopApplyMode(config, observeClaudeDesktopMode(config));
       if (target.kind === "first-party") {
         console.log(`Claude Desktop first-party 설정을 적용했습니다: ${result.path}`);
         console.log("Desktop 앱 설정은 그대로이며, Code 탭의 Claude Code만 로컬 프록시를 거칩니다.");
+        console.warn(`⚠️  ${FIRST_PARTY_ACCOUNT_RISK.message}`);
```

`gatewayModeExplanation` (src/cli/claude-desktop.ts:212–247) is rewritten for the new default: when gateway
was applied without an explicit flag and first-party can run here (not a connected client, intercept
enabled), it prints "Gateway is the default.", the first-party alternative
(`ocx claude desktop apply --first-party`) and `FIRST_PARTY_ACCOUNT_RISK.message`; explicit gateway
requests and machines that cannot run first-party get nothing. Its doc comment drops the "help calls
first-party the default" premise.

The bindings gateway warning (`resolveClaudeDesktopMode(config) === "gateway"`) also passes the
observation. `status` prints the payload, which now carries `riskWarning`. `parseDesktopApplyArgs`
(the only caller of `defaultDesktopApplyMode`) widens its config type the same way; its callers
already pass a loaded `OcxConfig`. The gateway-mode explanation that suggests
`ocx claude desktop apply --first-party` (`gatewayModeExplanation`, src/cli/claude-desktop.ts:243)
appends `FIRST_PARTY_ACCOUNT_RISK.message` under the suggestion.

`src/cli/ensure-desired-integrations.ts`

```diff
-    if (resolveClaudeDesktopMode(config) !== "first-party") return;
+    if (resolveClaudeDesktopMode(config, (deps.observeClaudeDesktopMode ?? observeClaudeDesktopMode)(config)) !== "first-party") return;
```

`src/server/management/agent-settings-routes.ts`

```diff
-      let desktopMode: "first-party" | "gateway" = resolveClaudeDesktopApplyMode(config);
+      let desktopMode: "first-party" | "gateway" = resolveClaudeDesktopApplyMode(config, observeClaudeDesktopMode(config));
 …status…
-      const mode = gatewayApplied ? "gateway" : resolveClaudeDesktopApplyMode(persisted);
+      const mode = gatewayApplied ? "gateway" : resolveClaudeDesktopApplyMode(persisted, observeClaudeDesktopMode(persisted));
+      const { FIRST_PARTY_ACCOUNT_RISK } = await import("../../claude/desktop-risk");
+      const riskWarning = mode === "first-party" || firstPartySeen.applied || firstPartySeen.stale
+        ? { ...FIRST_PARTY_ACCOUNT_RISK } : null;
       return jsonResponse({
         desiredEnabled,
         mode,
+        riskWarning,
         firstParty,
```

The first-party apply response adds `riskWarning: { ...FIRST_PARTY_ACCOUNT_RISK }`.

`src/server/management/native-integration-routes.ts`: `desktopStatus` and the enable branch call
`resolveClaudeDesktopApplyMode(config, observeClaudeDesktopMode(config))`; the first-party enable
message appends `FIRST_PARTY_ACCOUNT_RISK.message`.

`src/server/management/config-routes.ts` (`/api/sync` client integrations)

```diff
-  if (claudeDesktopIntegrationEnabled(config)) {
+  if (claudeDesktopIntegrationEnabled(config)
+    && resolveClaudeDesktopMode(config, observeClaudeDesktopMode(config)) !== "first-party") {
 …
       const latest = loadConfig();
-      if (claudeDesktopIntegrationEnabled(latest)) {
+      // Discovery awaited: the mode may have changed meanwhile. Re-resolve on the fresh read,
+      // immediately before the writer, so a first-party switch during fetchAllModels still wins.
+      if (claudeDesktopIntegrationEnabled(latest)
+        && resolveClaudeDesktopMode(latest, observeClaudeDesktopMode(latest)) !== "first-party") {
```

wp4 moves this post-discovery block (the re-read, the re-resolve and `writeDesktop3pConfig`)
inside the picker controller's `transition` when a controller exists (030, D11), so a sync that
resumes while a first-party apply is between gateway cleanup and its mode commit waits for the
lock and then sees first-party. wp2 lands the re-resolve; wp4 adds the lock.

A first-party Desktop no longer gets a gateway profile written and selected by a catalog sync.

`autoApplyDesktopBestEffort` (agent-settings-routes.ts:212) gets the same guard twice: after
`loadConfig()` into `admitted` and again after the `fetchAllModels` await on `current`:

```diff
       if (!claudeDesktopIntegrationEnabled(admitted)) return;
+      if (resolveClaudeDesktopMode(admitted, observeClaudeDesktopMode(admitted)) === "first-party") return;
 …
       if (!claudeDesktopIntegrationEnabled(current)) return;
+      if (resolveClaudeDesktopMode(current, observeClaudeDesktopMode(current)) === "first-party") return;
```

`gui/src/pages/ClaudeDesktop.tsx`

```diff
-  const effectiveMode: DesktopMode = status?.mode ?? "first-party";
+  const effectiveMode: DesktopMode = status?.mode ?? "gateway";
-              {mode === "first-party" && <span className="claude-mode-default">{t("claudeDesktop.mode.defaultBadge")}</span>}
+              {mode === "gateway" && <span className="claude-mode-default">{t("claudeDesktop.mode.defaultBadge")}</span>}
 …after the mode options…
+        {selectedMode === "first-party" && (
+          <p className="claude-mode-risk" role="note">{t("claudeDesktop.mode.firstPartyRisk")}</p>
+        )}
```

The callout also renders under the status bar when `status.riskWarning` is set and the picker
fieldset is not showing first-party (so an applied first-party install sees it after reload).
Styling goes in the existing Claude Desktop stylesheet only if it has room under the ratchet;
otherwise in a new `gui/src/styles/claude-desktop-risk.css` imported from `gui/src/main.tsx`.

i18n: English source

```ts
"claudeDesktop.mode.firstPartyRisk": "Account risk: first-party sends your Claude subscription traffic through a local interception proxy. Anthropic may treat this as a terms violation and suspend the account. Gateway is the default.",
```

plus the nine translations with the same three facts (proxy, possible suspension, gateway default).

Docs (all eight guides): the mode section states gateway is the default; the first-party
subsection opens with

```md
:::caution[Account risk]
First-party mode sends your Claude subscription traffic through a local interception proxy.
Anthropic may treat this as a violation of its terms and suspend the account. Gateway is the
default; choose first-party only if you accept that risk.
:::
```

and the dashboard recap line (`claude-code.md:760` in English) names gateway as the default.

## Tests

`tests/claude-integration/claude-desktop-first-party.test.ts`

1. "mode resolution: explicit wins, applied gateway fingerprint keeps gateway, owned first-party
   settings keep first-party, otherwise gateway" (replaces :64).
2. "implied apply mode is gateway; a legacy first-party install keeps first-party unless the
   intercept is disabled" (replaces :78) → renamed "implied apply mode is gateway; a legacy
   first-party install keeps first-party, and with the intercept disabled the apply is refused
   with intercept_disabled instead of switching to gateway".
3. "CLI apply flags: default gateway, --first-party explicit, legacy shape flags imply gateway,
   conflicts rejected" (replaces :86).
4. "POST /api/claude-desktop/apply defaults to gateway, first-party on request, and returns the
   risk warning" (replaces :138).
5. "native toggle: enable applies gateway by default; a legacy first-party install keeps
   first-party and its message carries the risk" (replaces :182).
6. NEW "status carries riskWarning for first-party and null for gateway".
7. NEW "/api/sync does not write a gateway profile while first-party is resolved" (fake
   `writeDesktop3pConfig` dep asserts it is not called). Activation: config with explicit
   `desktopMode: "first-party"` and `claudeDesktop` integration enabled.
7b. NEW "/api/sync re-resolves after discovery": a fake `fetchAllModels` resolves only after the
   test persists `desktopMode: "first-party"`; the writer must not be called.
8. NEW "a foreign HTTPS_PROXY in settings.json is not first-party evidence" (settings kind
   `foreign` → gateway).
9. NEW "a selected owned gateway row outranks legacy first-party settings" (both observed →
   gateway).
10. NEW "a roster update does not write a gateway profile on an explicit first-party install" and
   "… nor when the mode switches to first-party while its discovery is pending" (fake
   `fetchAllModels` resolves after the switch; fake `writeDesktop3pConfig` must not be called).

`tests/claude-integration/claude-desktop-mode-explanation.test.ts`: implicit gateway where
first-party can run → the default line, the first-party command and the risk text; explicit
`--gateway` → nothing; connected client or disabled intercept → nothing.

Verifier (run at P of wp2, before writing it into the plan as proof):
`bun test tests/claude-integration/claude-desktop-first-party.test.ts tests/claude-integration/claude-desktop-cli.test.ts tests/claude-integration/claude-desktop-mode-explanation.test.ts`,
`bun run typecheck` (locale records are `Record<TKey,string>`, so a missing key fails),
`cd gui && bun test tests/locale-parity.test.ts`, `bun run structure:check`.

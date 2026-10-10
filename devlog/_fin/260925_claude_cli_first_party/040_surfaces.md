# 040 — wp5 surfaces: Claude Code CLI first-party

## Goal and scope
Implement only wp5 from [000_plan.md](000_plan.md) after wp2–wp4 land: expose an immediate independent CLI first-party switch, explain the shared settings env honestly, repair Desktop copy, and synchronize ten GUI catalogs and eight guides. IN: UI, copy, CLI help/status prose, tests, documentation. OUT: config/schema, intercept routing, management transactions, structure contracts (owned by wp2–wp4), user settings, live proxy, picker CA, Desktop gateway semantics, A1 Desktop-only egress, releases and merge. Apply M1–M6 and reflection dispositions R1–R6. This is a future-build PRD; re-anchor against the actual wp4 head before editing.

## File change map
| Path | Action | Purpose |
|---|---|---|
| `gui/src/pages/claude-code-types.ts` | MODIFY | consume wp4 GET DTO |
| `gui/src/pages/claude-code-first-party.ts` | NEW | source-checked eight-status roster, normalization, and pure ordered notice selector |
| `gui/src/pages/ClaudeCode.tsx` | MODIFY | immediate CLI switch, refusal, risk, and selected proxy notice |
| `src/cli/claude-desktop.ts` | MODIFY | correct help and status copy |
| `gui/src/i18n/{en,de,fr,ko,zh,zh-TW,ru,ja,tr,vi}.ts` | MODIFY ×10 | new keys and two corrected Desktop keys |
| `docs-site/src/content/docs/guides/claude-code.md` | MODIFY | canonical guide |
| `docs-site/src/content/docs/{ko,fr,ja,ru,tr,zh-cn,zh-tw}/guides/claude-code.md` | MODIFY ×7 | translated guide paragraphs |
| `gui/tests/{claude-toggle-race,claude-desktop-mode-picker}.test.tsx` | MODIFY ×2 | mounted observable regressions |
| `gui/tests/claude-code-first-party.test.ts` | NEW | executable selector truth table, including legacy and unknown status |

`gui/src/pages/ClaudeDesktop.tsx:556` already renders `claudeDesktop.mode.firstPartyHint`; `:600` already renders `claudeDesktop.status.appliedFirstParty`. Change their catalog values, not the JSX. The structure paragraphs formerly in this phase belong to wp2 (`010_foundations.md`), wp3 (`020_intercept_classification.md`), and wp4 (`030_management_cli.md`) under M1.

## Executable source diffs

#### `gui/src/pages/claude-code-types.ts` — current anchor `gui/src/pages/claude-code-types.ts:31`: `enabled: boolean;`
```diff
@@ -31,1 +31,7 @@
   enabled: boolean;
+  cliFirstParty: boolean;
+  cliFirstPartyApplied: boolean;
+  desktopFirstParty: boolean;
+  interceptRunning: boolean;
+  interceptEligible: boolean;
+  sharedProxy: "none" | "live" | "stopped" | "disabled" | "broken" | "foreign" | "local" | "unknown";
```

wp4 GET provides five booleans and the eight-state `sharedProxy` enum. Normalize cached/malformed booleans with `=== true`, except `interceptEligible`: `value === undefined ? true : value === true`, so an older cached DTO never shows `routingOff`. Only an absent status (`undefined`) becomes `"none"`, while `null` or any unrecognized value becomes `"unknown"`. Normalize the initial session-cache state and every GET before rendering. The valid `"unknown"` member means ownership cannot be determined; `"local"` means a loopback URL beside a foreign CA with ownership unconfirmed. `cliFirstPartyApplied` is derived on the server from CLI intent and `sharedProxy === "live"`; `interceptEligible` is `claudeInterceptEnabled(config)` from the same config snapshot used for `sharedProxy`, and `interceptRunning` is bound listener present AND eligible. Neither `cliFirstPartyApplied` nor `interceptRunning` changes the desired switch or drives the notice selector; `interceptEligible` selects the correct stopped/broken recovery advice. An owned proxy with no bound listener is `stopped`; with a bound but ineligible listener it is `disabled` only if the applied settings match that listener, otherwise `broken`.

#### `gui/src/pages/ClaudeCode.tsx` — current anchor `gui/src/pages/ClaudeCode.tsx:50`: `const connectionInFlight = useRef(false);`
```diff
@@ -50,1 +50,3 @@
   const connectionInFlight = useRef(false);
+  const [firstPartyPending, setFirstPartyPending] = useState(false);
+  const firstPartyInFlight = useRef(false);
```

#### `gui/src/pages/claude-code-first-party.ts` — new pure selector
```ts
import type { ClaudeCodeState } from "./claude-code-types";

export const FIRST_PARTY_PROXY_STATUSES = [
  "none", "live", "stopped", "disabled", "broken", "foreign", "local", "unknown",
] as const satisfies readonly ClaudeCodeState["sharedProxy"][];
export const firstPartyProxyStatusCoverage: Record<ClaudeCodeState["sharedProxy"], true> = {
  none: true, live: true, stopped: true, disabled: true,
  broken: true, foreign: true, local: true, unknown: true,
};
export type FirstPartyNotice = "unknown" | "foreign" | "local" | "residual" | "disabled" | "routingOff" | "stopped" | "broken" | "notApplied" | "shared" | null;
export function normalizeSharedProxy(value: unknown): ClaudeCodeState["sharedProxy"] {
  // Only an absent field in an older DTO defaults to none; malformed or future values warn.
  if (value === undefined) return "none";
  return FIRST_PARTY_PROXY_STATUSES.find(status => status === value) ?? "unknown";
}
export function selectFirstPartyNotice(
  state: Pick<ClaudeCodeState, "sharedProxy" | "desktopFirstParty" | "cliFirstParty" | "interceptEligible">,
): FirstPartyNotice {
  if (state.sharedProxy === "unknown") return "unknown";
  if (state.sharedProxy === "foreign") return "foreign";
  if (state.sharedProxy === "local") return "local";
  if (!state.desktopFirstParty && !state.cliFirstParty && state.sharedProxy !== "none") return "residual";
  if (state.sharedProxy === "disabled") return "disabled";
  if ((state.sharedProxy === "stopped" || state.sharedProxy === "broken") && !state.interceptEligible) return "routingOff";
  if (state.sharedProxy === "stopped") return "stopped";
  if (state.sharedProxy === "broken") return "broken";
  if (state.sharedProxy === "none" && state.cliFirstParty) return "notApplied";
  if (state.sharedProxy === "live" && state.desktopFirstParty !== state.cliFirstParty) return "shared";
  return null;
}
```
`fetchCode` and the session-cache initializer normalize the untrusted values before calling this selector. The ordered branches implement G precedence. The exported source roster and `Record` coverage map both live under `gui/tsconfig.app.json` `include: ["src"]`; the test iterates the roster instead of maintaining a second enum list. Desktop-only intent with `none` has no new reapply notice in wp5. Import both functions into `ClaudeCode.tsx`, and import `type FirstPartyNotice` for the catalog-key map.

#### `gui/src/pages/ClaudeCode.tsx` — current anchor `gui/src/pages/ClaudeCode.tsx:34`: `const cached = cachedEntry?.data ?? null;`
```diff
-  const cached = cachedEntry?.data ?? null;
+  const cached = cachedEntry?.data ? {
+    ...cachedEntry.data,
+    state: {
+      ...cachedEntry.data.state,
+      sharedProxy: normalizeSharedProxy(cachedEntry.data.state.sharedProxy),
+      cliFirstParty: cachedEntry.data.state.cliFirstParty === true,
+      desktopFirstParty: cachedEntry.data.state.desktopFirstParty === true,
+      cliFirstPartyApplied: cachedEntry.data.state.cliFirstPartyApplied === true,
+      interceptRunning: cachedEntry.data.state.interceptRunning === true,
+      interceptEligible: cachedEntry.data.state.interceptEligible === undefined ? true : cachedEntry.data.state.interceptEligible === true,
+    },
+  } : null;
```

#### `gui/src/pages/ClaudeCode.tsx` — current anchor `gui/src/pages/ClaudeCode.tsx:70`: `effectiveModelEnv: r.effectiveModelEnv ?? {},`
```diff
@@ -70,1 +70,7 @@
       effectiveModelEnv: r.effectiveModelEnv ?? {},
+      cliFirstParty: r.cliFirstParty === true,
+      cliFirstPartyApplied: r.cliFirstPartyApplied === true,
+      desktopFirstParty: r.desktopFirstParty === true,
+      interceptRunning: r.interceptRunning === true,
+      interceptEligible: r.interceptEligible === undefined ? true : r.interceptEligible === true,
+      sharedProxy: normalizeSharedProxy(r.sharedProxy),
```

#### `gui/src/pages/ClaudeCode.tsx` — current anchor `gui/src/pages/ClaudeCode.tsx:155`: `const save = async () => {`
```diff
@@ -155,1 +155,39 @@
-  const save = async () => {
+  const toggleFirstParty = async () => {
+    if (!state || firstPartyInFlight.current) return;
+    firstPartyInFlight.current = true;
+    setFirstPartyPending(true);
+    setStatus("");
+    try {
+      const response = await fetch(`${apiBase}/api/claude-code`, {
+        method: "PUT",
+        headers: { "Content-Type": "application/json" },
+        body: JSON.stringify({ cliFirstParty: !state.cliFirstParty }),
+      });
+      if (!response.ok) {
+        const payload = await response.json().catch(() => null) as { code?: string } | null;
+        const refusalKeys = {
+          intercept_disabled: "claude.firstParty.refusal.interceptDisabled",
+          intercept_unavailable: "claude.firstParty.refusal.interceptUnavailable",
+          foreign_env: "claude.firstParty.refusal.foreignEnv",
+          ca_unavailable: "claude.firstParty.refusal.caUnavailable",
+          unreadable: "claude.firstParty.refusal.unreadable",
+          write_failed: "claude.firstParty.refusal.writeFailed",
+        } as const;
+        const key = payload?.code && payload.code in refusalKeys
+          ? refusalKeys[payload.code as keyof typeof refusalKeys]
+          : "claude.saveFailed";
+        throw new Error(t(key));
+      }
+      await readJsonOrThrow(response, t("claude.saveFailed"));
+      await fetchCode(new AbortController().signal);
+      codeResource.refresh();
+    } catch (error) {
+      setOk(false);
+      setStatus(error instanceof Error && error.message ? error.message : t("claude.networkError"));
+    } finally {
+      firstPartyInFlight.current = false;
+      setFirstPartyPending(false);
+    }
+  };
+
+  const save = async () => {
```

#### `gui/src/pages/ClaudeCode.tsx` — current anchor `gui/src/pages/ClaudeCode.tsx:274`: `<div className="claudecode-workspace-root">`
```diff
@@ -274,1 +274,24 @@
-      <div className="claudecode-workspace-root">
+      <div className="claudecode-connection-head">
+        <span id="claudecode-first-party-label">{t("claude.firstParty.label")}</span>
+        <Switch
+          on={state.cliFirstParty}
+          onClick={() => void toggleFirstParty()}
+          disabled={firstPartyPending}
+          label={t("claude.firstParty.aria")}
+        />
+      </div>
+      {state.cliFirstParty && (
+        <Notice tone="warn">{t("claude.firstParty.risk")}</Notice>
+      )}
+      {(() => {
+        const notice = selectFirstPartyNotice(state);
+        const key = notice && firstPartyNoticeKeys[notice];
+        return key ? <Notice tone="warn">{t(key)}</Notice> : null;
+      })()}
+      <div className="claudecode-workspace-root">
```

Add `import { normalizeSharedProxy, selectFirstPartyNotice, type FirstPartyNotice } from "./claude-code-first-party";` and a module-level complete mapping `const firstPartyNoticeKeys: Record<Exclude<FirstPartyNotice, null>, TKey> = { unknown: "claude.firstParty.unknown", foreign: "claude.firstParty.foreign", local: "claude.firstParty.local", residual: "claude.firstParty.residual", disabled: "claude.firstParty.disabled", routingOff: "claude.firstParty.routingOff", stopped: "claude.firstParty.deadProxy", broken: "claude.firstParty.brokenProxy", notApplied: "claude.firstParty.notApplied", shared: "claude.firstParty.shared" };` (`TKey` from `../i18n/shared`). The awaited GET reads committed intent even if wp4 PUT returns only `{ok:true}`; never infer the displayed switch from HTTP 2xx alone. The risk notice remains separate and appears whenever CLI intent is on. The selector alone chooses at most one proxy notice. `unknown` means opencodex could not determine whether settings still point at its proxy; `foreign` means a token-bearing opencodex URL next to a non-owned CA and needs manual env repair; `local` means a tokenless loopback URL next to a foreign CA, with ownership unconfirmed, so users may remove `HTTPS_PROXY` if unused. `disabled` means matching applied settings with a bound ineligible listener: requests relay unchanged until restart, after which plain `claude` cannot connect while settings remain. `routingOff` means stopped/broken settings while interception is ineligible because Claude routing or the intercept is off, or this machine is another hub's client; restore interception on this machine or turn first-party off. `stopped` means eligible routing with an owned-shaped URL but no bound listener; start opencodex. `broken` means eligible routing with a bound listener whose settings do not match it; run `ocx ensure` or restart opencodex. `residual` means no intent with non-`none` settings, except higher-priority unknown/foreign/local. `none` includes absent URL and CA-only stale env. Do not add an absent-env reapply path for Desktop. The Save payload above omits `cliFirstParty`. `Notice` supports `warn` (`gui/src/ui.tsx:44-49`).

#### `src/cli/claude-desktop.ts` — current anchor `src/cli/claude-desktop.ts:56`: `--first-party  keep Desktop on claude.ai; route only the Code tab's Claude Code through the`
```diff
@@ -56,4 +56,6 @@
-      --first-party  keep Desktop on claude.ai; route only the Code tab's Claude Code through the
-                     local intercept proxy via ~/.claude/settings.json env. Account risk: this sends
-                     Claude subscription traffic through a local interception proxy, and Anthropic
-                     may suspend the account.
+      --first-party  keep Desktop on claude.ai; route its Code tab through the local
+                     intercept proxy via shared ~/.claude/settings.json env. A standalone
+                     claude CLI also reads that env and transits the proxy unchanged when
+                     CLI first-party is off. For fully native shell use, set NO_PROXY='*'.
+                     Account risk: Claude subscription traffic crosses local TLS interception;
+                     Anthropic may suspend the account.
```

#### `src/cli/claude-desktop.ts` — current anchor `src/cli/claude-desktop.ts:356`: `"First-party keeps Desktop on your claude.ai account and routes only the Code tab through the local proxy:",`
```diff
@@ -356,1 +356,1 @@
-    "First-party keeps Desktop on your claude.ai account and routes only the Code tab through the local proxy:",
+    "First-party keeps Desktop on your claude.ai account and routes its Code tab through the local proxy. The standalone claude CLI reads the same settings env and may transit the proxy unchanged; use NO_PROXY='*' in the shell for fully native traffic:",
```

The `rg -n "Code tab" src/cli src/claude src/server` inventory also finds picker-specific help in `src/cli/registry.ts:477`, `src/cli/capabilities.ts:852-876`, picker runtime strings and comments. Those statements describe the Desktop picker and remain accurate. Only the exclusivity claim at `src/cli/claude-desktop.ts:56,356` changes.

## GUI catalogs — exact ten-locale payload
Insert the nineteen keys beside the existing Desktop hint; replace the two existing Desktop keys in place. Values are complete, ready to paste as TypeScript object entries. `en.ts` defines `TKey` (`en.ts:3505`); `catalogs.ts:25-36` requires all ten `Record<TKey,string>` catalogs. `gui/src/i18n/shared.ts:6-17` confirms the locale roster.

### `gui/src/i18n/en.ts`
Current anchors: `gui/src/i18n/en.ts:3077` `"claudeDesktop.mode.firstPartyHint": "Desktop stays signed in to claude.ai (chat, connectors, remote control). Only the Code tab, its subagents and the Claude Code CLI go through OpenCodex.",`; `gui/src/i18n/en.ts:3071` `"claudeDesktop.status.appliedFirstParty": "First-party: Code tab routed through the local proxy",`.
```diff
@@ -3071,1 +3071,1 @@
-  "claudeDesktop.status.appliedFirstParty": "First-party: Code tab routed through the local proxy",
+  "claudeDesktop.status.appliedFirstParty": "First-party: Desktop Code tab routed through the local proxy",
@@ -3077,1 +3077,20 @@
-  "claudeDesktop.mode.firstPartyHint": "Desktop stays signed in to claude.ai (chat, connectors, remote control). Only the Code tab, its subagents and the Claude Code CLI go through OpenCodex.",
+  "claudeDesktop.mode.firstPartyHint": "Desktop stays signed in to claude.ai. Its Code tab uses OpenCodex when Desktop first-party is on; the standalone CLI has its own switch. Both read the same settings env.",
+  "claude.firstParty.label": "Claude Code CLI first-party",
+  "claude.firstParty.aria": "Toggle Claude Code CLI first-party",
+  "claude.firstParty.risk": "Account risk: first-party routes Claude subscription traffic through a local interception proxy. Anthropic may treat this as a terms violation and suspend the account.",
+  "claude.firstParty.shared": "When the shared proxy env is applied, the other Claude client also transits the local proxy as an unchanged relay; TLS terminates locally. Set NO_PROXY='*' in the shell for fully native terminal use.",
+  "claude.firstParty.deadProxy": "The Claude settings env points at a proxy that is not running. Start opencodex, or turn Desktop/CLI first-party off to remove the settings before using plain claude.",
+  "claude.firstParty.notApplied": "CLI first-party is on, but its proxy settings are not applied. Check the Claude settings env before using plain claude.",
+  "claude.firstParty.brokenProxy": "Claude settings point to an OpenCodex proxy that does not match the running listener. Run `ocx ensure` or restart OpenCodex.",
+  "claude.firstParty.residual": "Claude settings still point to an OpenCodex proxy although neither Desktop nor CLI first-party is on. Remove the remaining proxy setting or run `ocx ensure`.",
+  "claude.firstParty.routingOff": "opencodex is not serving the Claude intercept in its current configuration (Claude routing or the intercept is turned off, or this machine is a client of another opencodex hub), so these settings point at a proxy that will not serve them. Turn it back on on this machine, or turn first-party off to remove the settings.",
+  "claude.firstParty.disabled": "Claude routing in opencodex is off. The local proxy still passes these requests through unchanged until opencodex restarts; after that, plain claude cannot connect while the settings remain. Turn first-party off to remove them.",
+  "claude.firstParty.foreign": "~/.claude/settings.json points at the opencodex proxy but trusts a certificate opencodex does not manage, so requests fail. Fix HTTPS_PROXY / NODE_EXTRA_CA_CERTS there by hand.",
+  "claude.firstParty.local": "~/.claude/settings.json sends Claude Code through a local proxy at 127.0.0.1 that opencodex cannot confirm as its own. If you no longer use it, remove HTTPS_PROXY there.",
+  "claude.firstParty.unknown": "opencodex could not determine whether ~/.claude/settings.json still points at its proxy.",
+  "claude.firstParty.refusal.interceptDisabled": "The interception proxy is disabled.",
+  "claude.firstParty.refusal.interceptUnavailable": "The interception proxy is not running in this process.",
+  "claude.firstParty.refusal.foreignEnv": "Another program owns the Claude proxy settings.",
+  "claude.firstParty.refusal.caUnavailable": "The local certificate authority is unavailable.",
+  "claude.firstParty.refusal.unreadable": "Claude settings could not be read.",
+  "claude.firstParty.refusal.writeFailed": "Claude settings could not be written.",
```
### `gui/src/i18n/de.ts`
Current anchors: `gui/src/i18n/de.ts:2977` `"claudeDesktop.mode.firstPartyHint": "Desktop bleibt bei claude.ai angemeldet (Chat, Connectors, Remote Control). Nur der Code-Tab, seine Subagenten und die Claude Code CLI laufen über OpenCodex.",`; `gui/src/i18n/de.ts:2971` `"claudeDesktop.status.appliedFirstParty": "First-Party: Code-Tab läuft über den lokalen Proxy",`.
```diff
@@ -2971,1 +2971,1 @@
-  "claudeDesktop.status.appliedFirstParty": "First-Party: Code-Tab läuft über den lokalen Proxy",
+  "claudeDesktop.status.appliedFirstParty": "First-Party: Desktop-Code-Tab läuft über den lokalen Proxy",
@@ -2977,1 +2977,20 @@
-  "claudeDesktop.mode.firstPartyHint": "Desktop bleibt bei claude.ai angemeldet (Chat, Connectors, Remote Control). Nur der Code-Tab, seine Subagenten und die Claude Code CLI laufen über OpenCodex.",
+  "claudeDesktop.mode.firstPartyHint": "Desktop bleibt bei claude.ai angemeldet. Sein Code-Tab nutzt OpenCodex, wenn Desktop First-Party aktiv ist; die eigenständige CLI hat einen eigenen Schalter. Beide lesen dieselbe Einstellungsumgebung.",
+  "claude.firstParty.label": "Claude Code CLI First-Party",
+  "claude.firstParty.aria": "Claude Code CLI First-Party umschalten",
+  "claude.firstParty.risk": "Kontorisiko: First-Party leitet Claude-Abonnementverkehr über einen lokalen Abfangproxy. Anthropic kann dies als Verstoß gegen die Nutzungsbedingungen werten und das Konto sperren.",
+  "claude.firstParty.shared": "Wenn die gemeinsame Proxy-Umgebung angewendet ist, läuft auch der andere Claude-Client unverändert über den lokalen Proxy; TLS endet lokal. Für nativen Terminalverkehr NO_PROXY='*' in der Shell setzen.",
+  "claude.firstParty.deadProxy": "Die Claude-Einstellungen zeigen auf einen Proxy, der nicht läuft. Einfaches claude kann erst verbinden, wenn OpenCodex läuft oder Desktop/CLI First-Party ausgeschaltet wird.",
+  "claude.firstParty.notApplied": "CLI-First-Party ist aktiv, aber die Proxy-Einstellungen sind nicht angewendet. Prüfen Sie die Claude-Einstellungen vor dem Aufruf von claude.",
+  "claude.firstParty.brokenProxy": "Die Claude-Einstellungen zeigen auf einen OpenCodex-Proxy, der nicht zum laufenden Listener passt. Führen Sie `ocx ensure` aus oder starten Sie OpenCodex neu.",
+  "claude.firstParty.residual": "Die Claude-Einstellungen zeigen weiterhin auf einen OpenCodex-Proxy, obwohl weder Desktop noch CLI First-Party aktiv ist. Entfernen Sie den verbliebenen Proxy-Eintrag oder führen Sie `ocx ensure` aus.",
+  "claude.firstParty.routingOff": "opencodex stellt den Claude-Intercept in der aktuellen Konfiguration nicht bereit (Claude-Routing oder Intercept ist ausgeschaltet, oder dieser Rechner ist Client eines anderen opencodex-Hubs). Diese Einstellungen zeigen daher auf einen Proxy, der die Anfragen nicht bedienen wird. Aktivieren Sie ihn auf diesem Rechner wieder oder deaktivieren Sie First-Party, um die Einstellungen zu entfernen.",
+  "claude.firstParty.disabled": "Claude-Routing in opencodex ist aus. Der lokale Proxy leitet diese Anfragen bis zum Neustart von opencodex unverändert weiter; danach kann sich claude mit den verbliebenen Einstellungen nicht verbinden. Schalten Sie First-Party aus, um sie zu entfernen.",
+  "claude.firstParty.foreign": "~/.claude/settings.json verweist auf den opencodex-Proxy, vertraut aber einer nicht von opencodex verwalteten CA. Anfragen schlagen fehl. Korrigieren Sie HTTPS_PROXY / NODE_EXTRA_CA_CERTS dort von Hand.",
+  "claude.firstParty.local": "~/.claude/settings.json leitet Claude Code über einen lokalen Proxy auf 127.0.0.1, den opencodex nicht als eigenen bestätigen kann. Wenn Sie ihn nicht mehr verwenden, entfernen Sie dort HTTPS_PROXY.",
+  "claude.firstParty.unknown": "opencodex konnte nicht feststellen, ob ~/.claude/settings.json noch auf seinen Proxy verweist.",
+  "claude.firstParty.refusal.interceptDisabled": "Der Abfangproxy ist deaktiviert.",
+  "claude.firstParty.refusal.interceptUnavailable": "Der Abfangproxy läuft in diesem Prozess nicht.",
+  "claude.firstParty.refusal.foreignEnv": "Ein anderes Programm verwaltet die Claude-Proxy-Einstellungen.",
+  "claude.firstParty.refusal.caUnavailable": "Die lokale Zertifizierungsstelle ist nicht verfügbar.",
+  "claude.firstParty.refusal.unreadable": "Die Claude-Einstellungen konnten nicht gelesen werden.",
+  "claude.firstParty.refusal.writeFailed": "Die Claude-Einstellungen konnten nicht geschrieben werden.",
```
### `gui/src/i18n/fr.ts`
Current anchors: `gui/src/i18n/fr.ts:2995` `"claudeDesktop.mode.firstPartyHint": "Desktop reste connecté à claude.ai (chat, connecteurs, contrôle à distance). Seuls l'onglet Code, ses sous-agents et la CLI Claude Code passent par OpenCodex.",`; `gui/src/i18n/fr.ts:2989` `"claudeDesktop.status.appliedFirstParty": "Première partie : l'onglet Code passe par le proxy local",`.
```diff
@@ -2989,1 +2989,1 @@
-  "claudeDesktop.status.appliedFirstParty": "Première partie : l'onglet Code passe par le proxy local",
+  "claudeDesktop.status.appliedFirstParty": "First-party : l'onglet Code de Desktop passe par le proxy local",
@@ -2995,1 +2995,20 @@
-  "claudeDesktop.mode.firstPartyHint": "Desktop reste connecté à claude.ai (chat, connecteurs, contrôle à distance). Seuls l'onglet Code, ses sous-agents et la CLI Claude Code passent par OpenCodex.",
+  "claudeDesktop.mode.firstPartyHint": "Desktop reste connecté à claude.ai. Son onglet Code utilise OpenCodex lorsque le mode first-party Desktop est actif ; la CLI autonome dispose de son propre interrupteur. Les deux lisent le même environnement de réglages.",
+  "claude.firstParty.label": "First-party de la CLI Claude Code",
+  "claude.firstParty.aria": "Activer ou désactiver le first-party de la CLI Claude Code",
+  "claude.firstParty.risk": "Risque pour le compte : le mode first-party fait passer le trafic de l'abonnement Claude par un proxy local d'interception. Anthropic peut y voir une violation de ses conditions et suspendre le compte.",
+  "claude.firstParty.shared": "Si les réglages du proxy partagé sont appliqués, l’autre client Claude traverse aussi le proxy local sans modification ; TLS se termine localement. Définissez NO_PROXY='*' dans le shell pour un terminal entièrement natif.",
+  "claude.firstParty.deadProxy": "Les réglages Claude pointent vers un proxy arrêté. La commande claude ne peut pas se connecter tant qu’OpenCodex ne fonctionne pas ou que le first-party Desktop/CLI n’est pas désactivé.",
+  "claude.firstParty.notApplied": "Le mode first-party de la CLI est actif, mais ses réglages de proxy ne sont pas appliqués. Vérifiez les réglages Claude avant de lancer claude.",
+  "claude.firstParty.brokenProxy": "Les réglages Claude pointent vers un proxy OpenCodex différent du listener actif. Exécutez `ocx ensure` ou redémarrez OpenCodex.",
+  "claude.firstParty.residual": "Les réglages Claude pointent encore vers un proxy OpenCodex alors que ni Desktop ni la CLI ne sont en mode first-party. Supprimez ce réglage ou exécutez `ocx ensure`.",
+  "claude.firstParty.routingOff": "opencodex ne sert pas l’interception Claude dans sa configuration actuelle (le routage Claude ou l’interception est désactivé, ou cette machine est cliente d’un autre hub opencodex). Ces réglages pointent donc vers un proxy qui ne traitera pas les requêtes. Réactivez-la sur cette machine ou désactivez le mode first-party pour supprimer ces réglages.",
+  "claude.firstParty.disabled": "Le routage Claude dans opencodex est désactivé. Le proxy local relaie ces requêtes sans modification jusqu’au redémarrage d’opencodex ; ensuite, claude ne pourra plus se connecter tant que ces réglages restent en place. Désactivez le mode first-party pour les retirer.",
+  "claude.firstParty.foreign": "~/.claude/settings.json pointe vers le proxy opencodex, mais fait confiance à une AC qu’opencodex ne gère pas : les requêtes échouent. Corrigez HTTPS_PROXY / NODE_EXTRA_CA_CERTS manuellement dans ce fichier.",
+  "claude.firstParty.local": "~/.claude/settings.json fait passer Claude Code par un proxy local sur 127.0.0.1 dont opencodex ne peut pas confirmer la propriété. Si vous ne l’utilisez plus, supprimez HTTPS_PROXY dans ce fichier.",
+  "claude.firstParty.unknown": "opencodex ne peut pas déterminer si ~/.claude/settings.json pointe encore vers son proxy.",
+  "claude.firstParty.refusal.interceptDisabled": "Le proxy d'interception est désactivé.",
+  "claude.firstParty.refusal.interceptUnavailable": "Le proxy d'interception ne fonctionne pas dans ce processus.",
+  "claude.firstParty.refusal.foreignEnv": "Un autre programme contrôle les réglages de proxy Claude.",
+  "claude.firstParty.refusal.caUnavailable": "L'autorité de certification locale est indisponible.",
+  "claude.firstParty.refusal.unreadable": "Impossible de lire les réglages Claude.",
+  "claude.firstParty.refusal.writeFailed": "Impossible d'écrire les réglages Claude.",
```
### `gui/src/i18n/ko.ts`
Current anchors: `gui/src/i18n/ko.ts:3016` `"claudeDesktop.mode.firstPartyHint": "Desktop은 claude.ai에 로그인된 상태를 유지합니다(채팅·커넥터·원격 제어). Code 탭과 서브에이전트, Claude Code CLI만 OpenCodex를 거칩니다.",`; `gui/src/i18n/ko.ts:3010` `"claudeDesktop.status.appliedFirstParty": "1P: Code 탭이 로컬 프록시를 통해 연결됨",`.
```diff
@@ -3010,1 +3010,1 @@
-  "claudeDesktop.status.appliedFirstParty": "1P: Code 탭이 로컬 프록시를 통해 연결됨",
+  "claudeDesktop.status.appliedFirstParty": "1P: Desktop Code 탭이 로컬 프록시를 통해 연결됨",
@@ -3016,1 +3016,20 @@
-  "claudeDesktop.mode.firstPartyHint": "Desktop은 claude.ai에 로그인된 상태를 유지합니다(채팅·커넥터·원격 제어). Code 탭과 서브에이전트, Claude Code CLI만 OpenCodex를 거칩니다.",
+  "claudeDesktop.mode.firstPartyHint": "Desktop은 claude.ai에 로그인된 상태를 유지합니다. Desktop 1P를 켜면 Code 탭이 OpenCodex를 사용하고, 독립 실행 CLI는 별도 스위치로 제어합니다. 둘 다 같은 설정 환경 변수를 읽습니다.",
+  "claude.firstParty.label": "Claude Code CLI 1P",
+  "claude.firstParty.aria": "Claude Code CLI 1P 켜기/끄기",
+  "claude.firstParty.risk": "계정 위험: 1P를 켜면 Claude 구독 트래픽이 로컬 가로채기 프록시를 거칩니다. Anthropic이 약관 위반으로 판단해 계정을 정지할 수 있습니다.",
+  "claude.firstParty.shared": "공유 프록시 설정이 적용되어 있으면 다른 Claude 클라이언트도 로컬 프록시를 거치지만 요청은 그대로 전달됩니다. TLS는 로컬에서 종료됩니다. 터미널에서 직접 연결하려면 셸에 NO_PROXY='*'를 설정하세요.",
+  "claude.firstParty.deadProxy": "Claude 설정이 실행 중이지 않은 프록시를 가리킵니다. OpenCodex를 실행하거나 Desktop/CLI 1P를 끄기 전에는 일반 claude가 연결할 수 없습니다.",
+  "claude.firstParty.notApplied": "CLI 1P가 켜져 있지만 프록시 설정이 적용되지 않았어요. 일반 claude를 사용하기 전에 Claude 설정을 확인하세요.",
+  "claude.firstParty.brokenProxy": "Claude 설정의 OpenCodex 프록시가 실행 중인 리스너와 일치하지 않습니다. `ocx ensure`를 실행하거나 OpenCodex를 다시 시작하세요.",
+  "claude.firstParty.residual": "Desktop과 CLI의 1P가 모두 꺼져 있는데도 Claude 설정에 OpenCodex 프록시가 남아 있습니다. 남은 프록시 설정을 지우거나 `ocx ensure`를 실행하세요.",
+  "claude.firstParty.routingOff": "현재 설정에서는 opencodex가 Claude 인터셉트를 제공하지 않아요. Claude 라우팅이나 인터셉트가 꺼져 있거나, 이 기기가 다른 opencodex 허브의 클라이언트일 수 있어요. 따라서 이 설정은 요청을 처리하지 않는 프록시를 가리켜요. 이 기기에서 다시 켜거나 1P를 꺼서 설정을 제거하세요.",
+  "claude.firstParty.disabled": "opencodex에서 Claude 라우팅이 꺼져 있어요. 로컬 프록시는 opencodex를 다시 시작하기 전까지 요청을 바꾸지 않고 전달해요. 재시작 후에도 설정이 남아 있으면 일반 claude는 연결할 수 없어요. 설정을 지우려면 1P를 끄세요.",
+  "claude.firstParty.foreign": "~/.claude/settings.json이 opencodex 프록시를 가리키지만 opencodex가 관리하지 않는 인증서를 신뢰하고 있어 요청이 실패해요. 파일에서 HTTPS_PROXY / NODE_EXTRA_CA_CERTS를 직접 수정하세요.",
+  "claude.firstParty.local": "~/.claude/settings.json을 통해 Claude Code가 127.0.0.1의 로컬 프록시를 사용하고 있어요. opencodex가 소유한 프록시인지는 확인할 수 없어요. 더 이상 사용하지 않는다면 해당 파일에서 HTTPS_PROXY를 지우세요.",
+  "claude.firstParty.unknown": "opencodex가 ~/.claude/settings.json이 아직 자체 프록시를 가리키는지 확인하지 못했어요.",
+  "claude.firstParty.refusal.interceptDisabled": "가로채기 프록시가 꺼져 있습니다.",
+  "claude.firstParty.refusal.interceptUnavailable": "이 프로세스에서 가로채기 프록시가 실행 중이지 않습니다.",
+  "claude.firstParty.refusal.foreignEnv": "다른 프로그램이 Claude 프록시 설정을 관리하고 있습니다.",
+  "claude.firstParty.refusal.caUnavailable": "로컬 인증 기관을 사용할 수 없습니다.",
+  "claude.firstParty.refusal.unreadable": "Claude 설정을 읽을 수 없습니다.",
+  "claude.firstParty.refusal.writeFailed": "Claude 설정을 쓸 수 없습니다.",
```
### `gui/src/i18n/zh.ts`
Current anchors: `gui/src/i18n/zh.ts:2997` `"claudeDesktop.mode.firstPartyHint": "Desktop 保持登录 claude.ai（聊天、连接器、远程控制）。仅 Code 标签页、其子代理和 Claude Code CLI 经由 OpenCodex。",`; `gui/src/i18n/zh.ts:2991` `"claudeDesktop.status.appliedFirstParty": "第一方：Code 标签页经由本地代理",`.
```diff
@@ -2991,1 +2991,1 @@
-  "claudeDesktop.status.appliedFirstParty": "第一方：Code 标签页经由本地代理",
+  "claudeDesktop.status.appliedFirstParty": "第一方：Desktop Code 标签页经由本地代理",
@@ -2997,1 +2997,20 @@
-  "claudeDesktop.mode.firstPartyHint": "Desktop 保持登录 claude.ai（聊天、连接器、远程控制）。仅 Code 标签页、其子代理和 Claude Code CLI 经由 OpenCodex。",
+  "claudeDesktop.mode.firstPartyHint": "Desktop 保持登录 claude.ai。开启 Desktop 第一方模式时，Code 标签页使用 OpenCodex；独立 CLI 有自己的开关。两者读取同一份设置环境变量。",
+  "claude.firstParty.label": "Claude Code CLI 第一方",
+  "claude.firstParty.aria": "切换 Claude Code CLI 第一方模式",
+  "claude.firstParty.risk": "账户风险：第一方模式让 Claude 订阅流量经过本地拦截代理。Anthropic 可能将其视为违反条款并暂停账户。",
+  "claude.firstParty.shared": "如果共享代理设置已应用，另一个 Claude 客户端也会经由本地代理原样转发；TLS 在本地终止。若要在终端直连，请在 shell 中设置 NO_PROXY='*'。",
+  "claude.firstParty.deadProxy": "Claude 设置指向未运行的代理。运行 OpenCodex 或关闭 Desktop/CLI 第一方模式之前，直接运行 claude 无法连接。",
+  "claude.firstParty.notApplied": "CLI 第一方模式已开启，但代理设置尚未生效。运行普通 claude 前请检查 Claude 设置。",
+  "claude.firstParty.brokenProxy": "Claude 设置指向的 OpenCodex 代理与正在运行的监听器不匹配。请运行 `ocx ensure` 或重启 OpenCodex。",
+  "claude.firstParty.residual": "Desktop 和 CLI 第一方模式均已关闭，但 Claude 设置仍指向 OpenCodex 代理。请删除残留代理设置或运行 `ocx ensure`。",
+  "claude.firstParty.routingOff": "opencodex 当前未提供 Claude 拦截服务（Claude 路由或拦截功能已关闭，或此设备是另一台 opencodex 中枢的客户端），因此这些设置指向的代理无法处理请求。请在此设备上重新启用该服务，或关闭第一方模式以移除这些设置。",
+  "claude.firstParty.disabled": "opencodex 中的 Claude 路由已关闭。重启 opencodex 前，本地代理仍会原样转发这些请求；重启后，只要设置仍在，普通 claude 就无法连接。关闭第一方模式以移除设置。",
+  "claude.firstParty.foreign": "~/.claude/settings.json 指向 opencodex 代理，却信任 opencodex 未管理的证书，因此请求会失败。请手动修正其中的 HTTPS_PROXY / NODE_EXTRA_CA_CERTS。",
+  "claude.firstParty.local": "~/.claude/settings.json 让 Claude Code 使用 127.0.0.1 上的本地代理，但 opencodex 无法确认该代理是否由自己管理。如果不再使用，请删除其中的 HTTPS_PROXY。",
+  "claude.firstParty.unknown": "opencodex 无法确认 ~/.claude/settings.json 是否仍指向它的代理。",
+  "claude.firstParty.refusal.interceptDisabled": "拦截代理已关闭。",
+  "claude.firstParty.refusal.interceptUnavailable": "此进程未运行拦截代理。",
+  "claude.firstParty.refusal.foreignEnv": "其他程序拥有 Claude 代理设置。",
+  "claude.firstParty.refusal.caUnavailable": "本地证书颁发机构不可用。",
+  "claude.firstParty.refusal.unreadable": "无法读取 Claude 设置。",
+  "claude.firstParty.refusal.writeFailed": "无法写入 Claude 设置。",
```
### `gui/src/i18n/zh-TW.ts`
Current anchors: `gui/src/i18n/zh-TW.ts:2986` `"claudeDesktop.mode.firstPartyHint": "Desktop 維持登入 claude.ai（聊天、連接器、遠端控制）。僅 Code 分頁、其子代理與 Claude Code CLI 經由 OpenCodex。",`; `gui/src/i18n/zh-TW.ts:2980` `"claudeDesktop.status.appliedFirstParty": "第一方：Code 分頁經由本機代理",`.
```diff
@@ -2980,1 +2980,1 @@
-  "claudeDesktop.status.appliedFirstParty": "第一方：Code 分頁經由本機代理",
+  "claudeDesktop.status.appliedFirstParty": "第一方：Desktop Code 分頁經由本機代理",
@@ -2986,1 +2986,20 @@
-  "claudeDesktop.mode.firstPartyHint": "Desktop 維持登入 claude.ai（聊天、連接器、遠端控制）。僅 Code 分頁、其子代理與 Claude Code CLI 經由 OpenCodex。",
+  "claudeDesktop.mode.firstPartyHint": "Desktop 維持登入 claude.ai。啟用 Desktop 第一方模式時，Code 分頁使用 OpenCodex；獨立 CLI 有自己的開關。兩者讀取同一份設定環境變數。",
+  "claude.firstParty.label": "Claude Code CLI 第一方",
+  "claude.firstParty.aria": "切換 Claude Code CLI 第一方模式",
+  "claude.firstParty.risk": "帳號風險：第一方模式讓 Claude 訂閱流量經過本機攔截代理。Anthropic 可能視為違反條款並暫停帳號。",
+  "claude.firstParty.shared": "如果共用代理設定已套用，另一個 Claude 用戶端也會經由本機代理原樣轉送；TLS 在本機終止。若要在終端機直連，請在 shell 設定 NO_PROXY='*'。",
+  "claude.firstParty.deadProxy": "Claude 設定指向未執行的代理。執行 OpenCodex 或關閉 Desktop/CLI 第一方模式前，直接執行 claude 無法連線。",
+  "claude.firstParty.notApplied": "CLI 第一方模式已開啟，但代理設定尚未生效。執行一般 claude 前請檢查 Claude 設定。",
+  "claude.firstParty.brokenProxy": "Claude 設定指向的 OpenCodex 代理與執行中的監聽器不符。請執行 `ocx ensure` 或重新啟動 OpenCodex。",
+  "claude.firstParty.residual": "Desktop 與 CLI 第一方模式都已關閉，但 Claude 設定仍指向 OpenCodex 代理。請移除殘留代理設定或執行 `ocx ensure`。",
+  "claude.firstParty.routingOff": "opencodex 目前未提供 Claude 攔截服務（Claude 路由或攔截功能已關閉，或這台裝置是另一個 opencodex 中樞的用戶端），因此這些設定指向的代理無法處理要求。請在這台裝置上重新啟用該服務，或關閉第一方模式以移除設定。",
+  "claude.firstParty.disabled": "opencodex 的 Claude 路由已關閉。在 opencodex 重新啟動前，本機代理仍會原樣轉送這些要求；重新啟動後，只要設定仍在，一般 claude 就無法連線。關閉第一方模式以移除設定。",
+  "claude.firstParty.foreign": "~/.claude/settings.json 指向 opencodex 代理，卻信任 opencodex 未管理的憑證，因此要求會失敗。請手動修正其中的 HTTPS_PROXY / NODE_EXTRA_CA_CERTS。",
+  "claude.firstParty.local": "~/.claude/settings.json 讓 Claude Code 使用 127.0.0.1 上的本機代理，但 opencodex 無法確認該代理是否由自己管理。若不再使用，請刪除其中的 HTTPS_PROXY。",
+  "claude.firstParty.unknown": "opencodex 無法確認 ~/.claude/settings.json 是否仍指向自己的代理。",
+  "claude.firstParty.refusal.interceptDisabled": "攔截代理已關閉。",
+  "claude.firstParty.refusal.interceptUnavailable": "此程序未執行攔截代理。",
+  "claude.firstParty.refusal.foreignEnv": "其他程式擁有 Claude 代理設定。",
+  "claude.firstParty.refusal.caUnavailable": "本機憑證授權單位無法使用。",
+  "claude.firstParty.refusal.unreadable": "無法讀取 Claude 設定。",
+  "claude.firstParty.refusal.writeFailed": "無法寫入 Claude 設定。",
```
### `gui/src/i18n/ru.ts`
Current anchors: `gui/src/i18n/ru.ts:2825` `"claudeDesktop.mode.firstPartyHint": "Desktop остаётся в claude.ai (чат, коннекторы, удалённое управление). Через OpenCodex идут только вкладка Code, её субагенты и CLI Claude Code.",`; `gui/src/i18n/ru.ts:2819` `"claudeDesktop.status.appliedFirstParty": "First-party: вкладка Code идёт через локальный прокси",`.
```diff
@@ -2819,1 +2819,1 @@
-  "claudeDesktop.status.appliedFirstParty": "First-party: вкладка Code идёт через локальный прокси",
+  "claudeDesktop.status.appliedFirstParty": "First-party: вкладка Code в Desktop идёт через локальный прокси",
@@ -2825,1 +2825,20 @@
-  "claudeDesktop.mode.firstPartyHint": "Desktop остаётся в claude.ai (чат, коннекторы, удалённое управление). Через OpenCodex идут только вкладка Code, её субагенты и CLI Claude Code.",
+  "claudeDesktop.mode.firstPartyHint": "Desktop остаётся подключённым к claude.ai. Его вкладка Code использует OpenCodex при включённом first-party Desktop; у отдельного CLI свой переключатель. Оба читают одну среду настроек.",
+  "claude.firstParty.label": "First-party для Claude Code CLI",
+  "claude.firstParty.aria": "Переключить first-party для Claude Code CLI",
+  "claude.firstParty.risk": "Риск для аккаунта: режим first-party направляет трафик подписки Claude через локальный перехватывающий прокси. Anthropic может счесть это нарушением условий и заблокировать аккаунт.",
+  "claude.firstParty.shared": "Если общие настройки прокси применены, другой клиент Claude также проходит через локальный прокси без изменения запросов; TLS завершается локально. Для нативной работы терминала задайте NO_PROXY='*' в оболочке.",
+  "claude.firstParty.deadProxy": "Настройки Claude указывают на неработающий прокси. Обычный claude не сможет подключиться, пока не запущен OpenCodex или не выключен first-party Desktop/CLI.",
+  "claude.firstParty.notApplied": "First-party CLI включён, но настройки прокси не применены. Проверьте настройки Claude перед запуском claude.",
+  "claude.firstParty.brokenProxy": "Настройки Claude указывают на прокси OpenCodex, не совпадающий с запущенным listener. Выполните `ocx ensure` или перезапустите OpenCodex.",
+  "claude.firstParty.residual": "В настройках Claude остался прокси OpenCodex, хотя first-party Desktop и CLI выключен. Удалите этот параметр или выполните `ocx ensure`.",
+  "claude.firstParty.routingOff": "В текущей конфигурации opencodex не обслуживает перехват Claude (маршрутизация Claude или перехват отключены либо этот компьютер является клиентом другого хаба opencodex), поэтому настройки указывают на прокси, который не обработает запросы. Включите его на этом компьютере или выключите first-party, чтобы удалить настройки.",
+  "claude.firstParty.disabled": "Маршрутизация Claude в opencodex выключена. До перезапуска opencodex локальный прокси передаёт эти запросы без изменений; после перезапуска обычный claude не подключится, пока настройки остаются. Выключите first-party, чтобы удалить их.",
+  "claude.firstParty.foreign": "~/.claude/settings.json указывает на прокси opencodex, но доверяет сертификату, которым opencodex не управляет, поэтому запросы не проходят. Исправьте HTTPS_PROXY / NODE_EXTRA_CA_CERTS вручную.",
+  "claude.firstParty.local": "~/.claude/settings.json направляет Claude Code через локальный прокси на 127.0.0.1, но opencodex не может подтвердить, что это его прокси. Если он больше не нужен, удалите HTTPS_PROXY из этого файла.",
+  "claude.firstParty.unknown": "opencodex не может определить, указывает ли ~/.claude/settings.json по-прежнему на его прокси.",
+  "claude.firstParty.refusal.interceptDisabled": "Прокси перехвата отключён.",
+  "claude.firstParty.refusal.interceptUnavailable": "Прокси перехвата не запущен в этом процессе.",
+  "claude.firstParty.refusal.foreignEnv": "Настройки прокси Claude принадлежат другой программе.",
+  "claude.firstParty.refusal.caUnavailable": "Локальный центр сертификации недоступен.",
+  "claude.firstParty.refusal.unreadable": "Не удалось прочитать настройки Claude.",
+  "claude.firstParty.refusal.writeFailed": "Не удалось записать настройки Claude.",
```
### `gui/src/i18n/ja.ts`
Current anchors: `gui/src/i18n/ja.ts:2754` `"claudeDesktop.mode.firstPartyHint": "Desktop は claude.ai にログインしたまま（チャット・コネクタ・リモート操作）。Code タブとそのサブエージェント、Claude Code CLI だけが OpenCodex を通ります。",`; `gui/src/i18n/ja.ts:2748` `"claudeDesktop.status.appliedFirstParty": "1P: Code タブはローカルプロキシ経由",`.
```diff
@@ -2748,1 +2748,1 @@
-  "claudeDesktop.status.appliedFirstParty": "1P: Code タブはローカルプロキシ経由",
+  "claudeDesktop.status.appliedFirstParty": "1P: Desktop の Code タブはローカルプロキシ経由",
@@ -2754,1 +2754,20 @@
-  "claudeDesktop.mode.firstPartyHint": "Desktop は claude.ai にログインしたまま（チャット・コネクタ・リモート操作）。Code タブとそのサブエージェント、Claude Code CLI だけが OpenCodex を通ります。",
+  "claudeDesktop.mode.firstPartyHint": "Desktop は claude.ai にログインしたままです。Desktop の 1P がオンなら Code タブは OpenCodex を使い、単独の CLI は別のスイッチで制御します。どちらも同じ設定環境変数を読みます。",
+  "claude.firstParty.label": "Claude Code CLI の 1P",
+  "claude.firstParty.aria": "Claude Code CLI の 1P を切り替え",
+  "claude.firstParty.risk": "アカウントのリスク：1P では Claude のサブスクリプション通信がローカルの傍受プロキシを通ります。Anthropic が規約違反と判断し、アカウントを停止する可能性があります。",
+  "claude.firstParty.shared": "共有プロキシ設定が適用されている場合、もう一方の Claude クライアントもローカルプロキシを通りますが、要求は変更されずに中継されます。TLS はローカルで終端します。ターミナルから直接接続するにはシェルで NO_PROXY='*' を設定してください。",
+  "claude.firstParty.deadProxy": "Claude の設定は停止中のプロキシを指しています。OpenCodex を起動するか Desktop/CLI の 1P をオフにするまで、通常の claude は接続できません。",
+  "claude.firstParty.notApplied": "CLI の 1P はオンですが、プロキシ設定は適用されていません。通常の claude を使う前に Claude の設定を確認してください。",
+  "claude.firstParty.brokenProxy": "Claude の設定が指す OpenCodex プロキシは実行中のリスナーと一致しません。`ocx ensure` を実行するか OpenCodex を再起動してください。",
+  "claude.firstParty.residual": "Desktop と CLI の 1P は両方オフですが、Claude の設定には OpenCodex プロキシが残っています。設定を削除するか `ocx ensure` を実行してください。",
+  "claude.firstParty.routingOff": "現在の設定では opencodex が Claude インターセプトを提供していません（Claude ルーティングまたはインターセプトがオフか、この端末が別の opencodex ハブのクライアントです）。そのため、この設定は要求を処理しないプロキシを指しています。この端末で再度有効にするか、1P をオフにして設定を削除してください。",
+  "claude.firstParty.disabled": "opencodex の Claude ルーティングはオフです。opencodex を再起動するまではローカルプロキシが要求を変更せず中継します。再起動後も設定が残ると通常の claude は接続できません。設定を消すには 1P をオフにしてください。",
+  "claude.firstParty.foreign": "~/.claude/settings.json は opencodex プロキシを指していますが、opencodex が管理しない証明書を信頼しているため要求は失敗します。HTTPS_PROXY / NODE_EXTRA_CA_CERTS を手動で修正してください。",
+  "claude.firstParty.local": "~/.claude/settings.json により Claude Code は 127.0.0.1 のローカルプロキシを通りますが、opencodex はそれが自身のプロキシか確認できません。使っていない場合は、そのファイルから HTTPS_PROXY を削除してください。",
+  "claude.firstParty.unknown": "opencodex は ~/.claude/settings.json がまだ自身のプロキシを指しているか確認できません。",
+  "claude.firstParty.refusal.interceptDisabled": "傍受プロキシは無効です。",
+  "claude.firstParty.refusal.interceptUnavailable": "このプロセスでは傍受プロキシが稼働していません。",
+  "claude.firstParty.refusal.foreignEnv": "別のプログラムが Claude のプロキシ設定を管理しています。",
+  "claude.firstParty.refusal.caUnavailable": "ローカル認証局を利用できません。",
+  "claude.firstParty.refusal.unreadable": "Claude の設定を読み取れません。",
+  "claude.firstParty.refusal.writeFailed": "Claude の設定を書き込めません。",
```
### `gui/src/i18n/tr.ts`
Current anchors: `gui/src/i18n/tr.ts:3019` `"claudeDesktop.mode.firstPartyHint": "Desktop claude.ai'de oturum açık kalır (sohbet, bağlayıcılar, uzaktan kontrol). Yalnızca Code sekmesi, alt ajanları ve Claude Code CLI OpenCodex üzerinden geçer.",`; `gui/src/i18n/tr.ts:3013` `"claudeDesktop.status.appliedFirstParty": "First-party: Code sekmesi yerel proxy üzerinden",`.
```diff
@@ -3013,1 +3013,1 @@
-  "claudeDesktop.status.appliedFirstParty": "First-party: Code sekmesi yerel proxy üzerinden",
+  "claudeDesktop.status.appliedFirstParty": "First-party: Desktop Code sekmesi yerel vekil üzerinden",
@@ -3019,1 +3019,20 @@
-  "claudeDesktop.mode.firstPartyHint": "Desktop claude.ai'de oturum açık kalır (sohbet, bağlayıcılar, uzaktan kontrol). Yalnızca Code sekmesi, alt ajanları ve Claude Code CLI OpenCodex üzerinden geçer.",
+  "claudeDesktop.mode.firstPartyHint": "Desktop claude.ai oturumunu korur. Desktop first-party açıksa Code sekmesi OpenCodex'i kullanır; bağımsız CLI'nin ayrı bir anahtarı vardır. İkisi de aynı ayar ortamını okur.",
+  "claude.firstParty.label": "Claude Code CLI first-party",
+  "claude.firstParty.aria": "Claude Code CLI first-party modunu değiştir",
+  "claude.firstParty.risk": "Hesap riski: first-party, Claude abonelik trafiğini yerel bir yakalama vekilinden geçirir. Anthropic bunu koşul ihlali sayıp hesabı askıya alabilir.",
+  "claude.firstParty.shared": "Paylaşılan vekil ayarları uygulandıysa diğer Claude istemcisi de yerel vekilden geçer ancak istekleri değiştirilmeden iletilir; TLS yerelde sonlanır. Terminalde doğrudan bağlantı için kabukta NO_PROXY='*' ayarlayın.",
+  "claude.firstParty.deadProxy": "Claude ayarları çalışmayan bir vekile işaret ediyor. OpenCodex çalışana veya Desktop/CLI first-party kapatılana kadar doğrudan claude bağlanamaz.",
+  "claude.firstParty.notApplied": "CLI first-party açık ancak vekil ayarları uygulanmamış. Doğrudan claude kullanmadan önce Claude ayarlarını kontrol edin.",
+  "claude.firstParty.brokenProxy": "Claude ayarları çalışan dinleyiciyle eşleşmeyen bir OpenCodex vekiline işaret ediyor. `ocx ensure` çalıştırın veya OpenCodex’i yeniden başlatın.",
+  "claude.firstParty.residual": "Desktop ve CLI first-party kapalı olsa da Claude ayarları hâlâ OpenCodex vekiline işaret ediyor. Kalan vekil ayarını kaldırın veya `ocx ensure` çalıştırın.",
+  "claude.firstParty.routingOff": "opencodex, geçerli yapılandırmada Claude kesmesini sunmuyor (Claude yönlendirmesi veya kesme kapalı ya da bu makine başka bir opencodex merkezinin istemcisi). Bu nedenle ayarlar, istekleri karşılamayacak bir vekile işaret ediyor. Bu makinede yeniden etkinleştirin veya ayarları kaldırmak için first-party modunu kapatın.",
+  "claude.firstParty.disabled": "opencodex içinde Claude yönlendirmesi kapalı. Yerel vekil, opencodex yeniden başlatılana dek bu istekleri değiştirmeden iletir; sonrasında ayarlar kaldığı sürece doğrudan claude bağlanamaz. Ayarları kaldırmak için first-party modunu kapatın.",
+  "claude.firstParty.foreign": "~/.claude/settings.json opencodex vekiline işaret ediyor ancak opencodex tarafından yönetilmeyen bir sertifikaya güveniyor; istekler başarısız olur. HTTPS_PROXY / NODE_EXTRA_CA_CERTS değerlerini elle düzeltin.",
+  "claude.firstParty.local": "~/.claude/settings.json, Claude Code trafiğini 127.0.0.1 üzerindeki yerel bir vekile gönderiyor; opencodex bu vekilin kendisine ait olduğunu doğrulayamıyor. Artık kullanmıyorsanız HTTPS_PROXY değerini bu dosyadan kaldırın.",
+  "claude.firstParty.unknown": "opencodex, ~/.claude/settings.json dosyasının hâlâ kendi vekiline işaret edip etmediğini belirleyemedi.",
+  "claude.firstParty.refusal.interceptDisabled": "Yakalama vekili kapalı.",
+  "claude.firstParty.refusal.interceptUnavailable": "Yakalama vekili bu süreçte çalışmıyor.",
+  "claude.firstParty.refusal.foreignEnv": "Claude vekil ayarları başka bir programa ait.",
+  "claude.firstParty.refusal.caUnavailable": "Yerel sertifika yetkilisi kullanılamıyor.",
+  "claude.firstParty.refusal.unreadable": "Claude ayarları okunamadı.",
+  "claude.firstParty.refusal.writeFailed": "Claude ayarları yazılamadı.",
```
### `gui/src/i18n/vi.ts`
Current anchors: `gui/src/i18n/vi.ts:3008` `"claudeDesktop.mode.firstPartyHint": "Desktop vẫn đăng nhập claude.ai (chat, connector, điều khiển từ xa). Chỉ tab Code, các subagent và Claude Code CLI đi qua OpenCodex.",`; `gui/src/i18n/vi.ts:3002` `"claudeDesktop.status.appliedFirstParty": "First-party: tab Code đi qua proxy cục bộ",`.
```diff
@@ -3002,1 +3002,1 @@
-  "claudeDesktop.status.appliedFirstParty": "First-party: tab Code đi qua proxy cục bộ",
+  "claudeDesktop.status.appliedFirstParty": "First-party: tab Code của Desktop đi qua proxy cục bộ",
@@ -3008,1 +3008,20 @@
-  "claudeDesktop.mode.firstPartyHint": "Desktop vẫn đăng nhập claude.ai (chat, connector, điều khiển từ xa). Chỉ tab Code, các subagent và Claude Code CLI đi qua OpenCodex.",
+  "claudeDesktop.mode.firstPartyHint": "Desktop vẫn đăng nhập claude.ai. Tab Code dùng OpenCodex khi bật first-party của Desktop; CLI độc lập có công tắc riêng. Cả hai đọc cùng môi trường thiết lập.",
+  "claude.firstParty.label": "First-party cho Claude Code CLI",
+  "claude.firstParty.aria": "Bật/tắt first-party cho Claude Code CLI",
+  "claude.firstParty.risk": "Rủi ro tài khoản: first-party đưa lưu lượng thuê bao Claude qua proxy chặn bắt cục bộ. Anthropic có thể coi đây là vi phạm điều khoản và đình chỉ tài khoản.",
+  "claude.firstParty.shared": "Khi thiết lập proxy dùng chung đã được áp dụng, ứng dụng Claude còn lại cũng đi qua proxy cục bộ và được chuyển tiếp nguyên trạng; TLS kết thúc tại máy. Để terminal kết nối trực tiếp, đặt NO_PROXY='*' trong shell.",
+  "claude.firstParty.deadProxy": "Thiết lập Claude trỏ đến proxy không chạy. Lệnh claude thông thường không thể kết nối cho đến khi OpenCodex chạy hoặc first-party Desktop/CLI được tắt.",
+  "claude.firstParty.notApplied": "First-party CLI đang bật nhưng thiết lập proxy chưa được áp dụng. Hãy kiểm tra thiết lập Claude trước khi chạy claude thông thường.",
+  "claude.firstParty.brokenProxy": "Thiết lập Claude trỏ tới proxy OpenCodex không khớp với bộ lắng nghe đang chạy. Chạy `ocx ensure` hoặc khởi động lại OpenCodex.",
+  "claude.firstParty.residual": "Cả first-party Desktop và CLI đều đã tắt nhưng thiết lập Claude vẫn trỏ tới proxy OpenCodex. Xóa thiết lập proxy còn lại hoặc chạy `ocx ensure`.",
+  "claude.firstParty.routingOff": "Với cấu hình hiện tại, opencodex không phục vụ chức năng chặn Claude (định tuyến Claude hoặc chức năng chặn đã tắt, hoặc máy này là máy khách của một hub opencodex khác), nên các thiết lập này trỏ đến proxy không xử lý yêu cầu. Hãy bật lại trên máy này hoặc tắt first-party để xóa các thiết lập.",
+  "claude.firstParty.disabled": "Định tuyến Claude trong opencodex đã tắt. Proxy cục bộ vẫn chuyển tiếp nguyên trạng các yêu cầu này cho đến khi opencodex khởi động lại; sau đó, claude thông thường không thể kết nối nếu thiết lập vẫn còn. Tắt first-party để gỡ chúng.",
+  "claude.firstParty.foreign": "~/.claude/settings.json trỏ đến proxy opencodex nhưng tin một chứng chỉ không do opencodex quản lý nên yêu cầu sẽ thất bại. Hãy sửa HTTPS_PROXY / NODE_EXTRA_CA_CERTS thủ công trong tệp đó.",
+  "claude.firstParty.local": "~/.claude/settings.json đưa Claude Code qua proxy cục bộ tại 127.0.0.1 nhưng opencodex không thể xác nhận proxy đó là của mình. Nếu không còn dùng, hãy xóa HTTPS_PROXY trong tệp này.",
+  "claude.firstParty.unknown": "opencodex không xác định được ~/.claude/settings.json còn trỏ đến proxy của mình hay không.",
+  "claude.firstParty.refusal.interceptDisabled": "Proxy chặn bắt đã tắt.",
+  "claude.firstParty.refusal.interceptUnavailable": "Proxy chặn bắt không chạy trong tiến trình này.",
+  "claude.firstParty.refusal.foreignEnv": "Một chương trình khác quản lý thiết lập proxy Claude.",
+  "claude.firstParty.refusal.caUnavailable": "Không dùng được cơ quan chứng thực cục bộ.",
+  "claude.firstParty.refusal.unreadable": "Không đọc được thiết lập Claude.",
+  "claude.firstParty.refusal.writeFailed": "Không ghi được thiết lập Claude.",
```
## Public guide changes
Keep the existing caution block and technical JSON sample. Replace the entire current traffic paragraph in each guide, then place the localized CLI subsection at a section boundary. English retains the model-discovery and model-env bullets below the new heading. The paragraphs explain the intentional relay and local TLS termination only while the proxy is running; no guide promises that a bare terminal `claude` is fully native while the shared proxy env remains.

### `docs-site/src/content/docs/guides/claude-code.md` — current anchor `docs-site/src/content/docs/guides/claude-code.md:185`: `Claude Code — the process Desktop spawns for its Code tab, every subagent it launches, and the`
```diff
@@ -185,11 +185,1 @@
-Claude Code — the process Desktop spawns for its Code tab, every subagent it launches, and the
-standalone `claude` CLI — reads that env and sends its `api.anthropic.com` traffic through the
-local intercept proxy. The proxy listens on the public port + 100 (`claudeCode.intercept.port`
-overrides it), terminates TLS with a per-install CA stored under `~/.opencodex/claude-intercept/`
-(never installed into the OS trust store; only Node processes that read `NODE_EXTRA_CA_CERTS`
-trust it), authenticates every CONNECT against a per-install token kept owner-only at
-`~/.opencodex/claude-intercept/proxy-token`, and hands `POST /v1/messages` and `POST /v1/messages/count_tokens` to the same
-Messages handler `ocx claude` uses. Every other path on `api.anthropic.com` (OAuth, profile,
-usage) is relayed byte-for-byte to Anthropic, and unrelated hosts are tunnelled untouched, so your
-subscription login keeps working. Existing OpenCodex features — `modelMap`, aliases, native
-passthrough, sidecars, auto-context — apply the same way they do for `ocx claude`.
+Claude Desktop first-party routes its Code tab and subagents through OpenCodex. The standalone Claude Code CLI has a separate first-party switch. Both clients read the same `~/.claude/settings.json` proxy and CA settings: if only one switch is on, the other client still transits the local proxy, where TLS terminates, but its Messages requests relay to Anthropic unchanged. Other Anthropic paths relay unchanged and unrelated hosts remain blind tunnels.
```

Current CLI section anchor `docs-site/src/content/docs/guides/claude-code.md:261`: `### Claude Code CLI compatibility`.
```diff
@@ -261,5 +261,5 @@
-### Claude Code CLI compatibility
-
-The same `settings.json` env drives the standalone `claude` CLI, so a first-party apply also
-covers terminal sessions, `claude -p`, and subagents without `ocx claude`'s
-`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` shell env. Differences from `ocx claude`:
+### Claude Code CLI first-party
+
+Turn on the CLI switch in Claude → Code, or run `ocx claude config set --first-party on`; use `off` to disable it. The switch is immediate and refuses `{enabled:false, cliFirstParty:true}` before any field is saved; it may also refuse to turn on if the local intercept is unavailable, the CA cannot be prepared, settings cannot be read, or a foreign proxy setting owns the keys. Off persists even when the intercept is unavailable; disabling Claude routing alone leaves an owned settings env untouched. For fully native terminal traffic with only Desktop first-party on, set `NO_PROXY='*'` in the shell. This still carries the first-party account risk stated above.
+Disabling Claude routing leaves the owned settings env untouched. While the bound listener still runs, every Messages request relays unchanged; after it stops, plain `claude` cannot connect until OpenCodex runs or Desktop/CLI first-party is turned off. Native `ocx claude` sets `NO_PROXY=*` only for an owned env without a foreign inherited `HTTPS_PROXY`/`https_proxy`. With a foreign proxy it preserves that value and warns that the settings-owned intercept still applies; turn Desktop/CLI first-party off or unset the setting.
+The UI distinguishes uncertainty about whether settings still point at its proxy (unknown), a token-bearing opencodex proxy with a foreign CA (foreign: fix HTTPS_PROXY / NODE_EXTRA_CA_CERTS manually), and a tokenless loopback proxy beside a foreign CA (local: ownership is unconfirmed; remove HTTPS_PROXY if unused). With matching applied settings and a bound listener but Claude routing off, disabled means requests relay unchanged until restart; turn first-party off to remove settings. An owned URL with no listener is stopped; a bound listener with an owned CA but mismatched port or token is broken even when routing is off. With an intent on, stopped or broken plus ineligible interception displays routingOff: Claude routing or the intercept is off, or this machine is a client of another opencodex hub; enable interception on this machine or turn first-party off to remove the settings. Only when interception is eligible does stopped advise starting opencodex and broken advise `ocx ensure` or restart. CLI intent with no proxy is not applied; one intent with a live proxy gets the shared-relay notice; any remaining proxy with neither intent is residual, unless unknown, foreign, or local takes precedence.
```

### `docs-site/src/content/docs/ko/guides/claude-code.md` — current anchor `docs-site/src/content/docs/ko/guides/claude-code.md:142`: `Desktop은 claude.ai에 로그인된 채로 남아 채팅, 커넥터, 원격 제어를 계속 사용할 수 있어요.`
```diff
@@ -142,9 +142,1 @@
-Desktop은 claude.ai에 로그인된 채로 남아 채팅, 커넥터, 원격 제어를 계속 사용할 수 있어요.
-OpenCodex는 `~/.claude/settings.json`(`CLAUDE_CONFIG_DIR` 지원)의 `env`에
-`HTTPS_PROXY`와 `NODE_EXTRA_CA_CERTS`만 써요. Code 탭이 실행한 Claude Code와 그
-서브에이전트, 터미널의 `claude` CLI만 로컬 프록시를 거쳐요. 프록시 주소는
-`http://opencodex:<설치별 토큰>@127.0.0.1:<포트>` 형태이고, 토큰은 소유자만 읽을 수 있는
-`~/.opencodex/claude-intercept/proxy-token`에 보관해요. 프록시는 모든 CONNECT를 이 토큰으로
-인증해요. 그 밖의 `api.anthropic.com`
-경로는 Anthropic으로 전달돼요. CA는 OS 신뢰 저장소에 설치하지 않고,
-`NODE_EXTRA_CA_CERTS`를 읽는 Node 프로세스만 신뢰해요.
+Desktop 1P를 켜면 Code 탭과 서브에이전트의 요청을 OpenCodex가 처리해요. 독립 실행 Claude Code CLI에는 별도 1P 스위치가 있어요. 두 클라이언트는 같은 `settings.json` 프록시·CA 설정을 읽기 때문에 하나만 켜도 다른 쪽 트래픽이 로컬 프록시를 거칠 수 있어요. 그때 TLS는 로컬에서 끝나지만 Messages 요청은 바꾸지 않고 Anthropic으로 전달해요.
```

Insert before current `docs-site/src/content/docs/ko/guides/claude-code.md:161`: `### Picker 모드: 1P Code 탭에 opencodex 모델 표시하기`.
```diff
@@ -161,1 +161,8 @@
+### Claude Code CLI 1P
+
+Claude → Code에서 CLI 1P를 켜거나 `ocx claude config set --first-party on`을 실행하세요. 끌 때는 `off`를 사용해요. 프록시가 꺼져 있거나 실행 중이지 않거나, CA·설정 파일을 준비할 수 없거나, 다른 프로그램이 프록시 설정을 소유하면 켜기 요청은 거절돼요. 끄기는 프록시 상태와 관계없이 저장돼요. Desktop 1P만 켜진 상태에서 터미널을 완전히 직접 연결하려면 셸에 `NO_PROXY='*'`를 설정하세요. 위의 계정 위험은 CLI 1P에도 적용돼요.
+Claude 라우팅을 꺼도 소유한 설정 환경 변수는 남아요. 리스너가 실행 중이면 모든 Messages 요청을 그대로 전달하지만, 프록시가 멈추면 OpenCodex를 실행하거나 Desktop/CLI 1P를 끄기 전까지 일반 `claude`는 연결할 수 없어요. `ocx claude`는 소유한 설정 환경 변수가 있고 상속된 외부 HTTPS 프록시가 없을 때만 `NO_PROXY=*`를 설정해요. 외부 프록시가 있으면 보존하고, 설정의 인터셉트가 계속 적용되므로 1P를 끄거나 설정을 해제하라는 경고를 표시해요.
+화면은 설정을 읽지 못한 상태(unknown), opencodex 토큰이 있는 프록시에 관리 대상이 아닌 CA가 붙은 상태(foreign), Claude 라우팅이 꺼졌지만 리스너는 살아 있어 요청을 그대로 전달하는 상태(disabled)를 구분해요. foreign이면 HTTPS_PROXY / NODE_EXTRA_CA_CERTS를 직접 고치고, disabled이면 재시작 전에 1P를 꺼서 설정을 지우세요. 리스너가 없으면 stopped, 관리 대상 CA를 쓰지만 포트·토큰이 다르면 broken이에요. 1P가 켜진 상태에서 인터셉트를 제공할 수 없으면 stopped와 broken 모두 routingOff 경고를 보여 줘요. Claude 라우팅이나 인터셉트가 꺼졌거나 이 기기가 다른 opencodex 허브의 클라이언트일 수 있으므로, 이 기기에서 다시 켜거나 1P를 꺼서 설정을 지우라고 안내해요. 인터셉트가 가능한 설정일 때만 stopped는 opencodex 실행, broken은 `ocx ensure` 또는 재시작을 안내해요. CLI 1P만 켰는데 프록시 설정이 없으면 미적용, 한쪽만 켜고 프록시가 정상이면 공유 전달, 둘 다 껐는데 설정이 남으면 잔여 설정으로 표시해요.
+unknown은 설정이 아직 opencodex 프록시를 가리키는지 판단할 수 없다는 뜻이에요. 외부 CA와 토큰 없는 127.0.0.1 프록시가 함께 있으면 local로 표시해요. opencodex 소유인지 확인할 수 없으므로 더 이상 사용하지 않는다면 ~/.claude/settings.json에서 HTTPS_PROXY를 지우세요. disabled는 현재 리스너와 설정이 정확히 맞을 때만 나타나고, 포트나 토큰이 어긋나면 라우팅이 꺼져 있어도 broken이에요.
+
 ### Picker 모드: 1P Code 탭에 opencodex 모델 표시하기
```

### `docs-site/src/content/docs/fr/guides/claude-code.md` — current anchor `docs-site/src/content/docs/fr/guides/claude-code.md:145`: ``~/.claude/settings.json` (ou le répertoire `CLAUDE_CONFIG_DIR`). Le Claude Code lancé par l'onglet`
```diff
@@ -143,9 +143,1 @@
-Desktop reste connecté à claude.ai : Chat, les connecteurs et le contrôle à distance continuent de
-fonctionner. OpenCodex écrit seulement `HTTPS_PROXY` et `NODE_EXTRA_CA_CERTS` dans le bloc `env` de
-`~/.claude/settings.json` (ou le répertoire `CLAUDE_CONFIG_DIR`). Le Claude Code lancé par l'onglet
-Code, ses sous-agents et la CLI `claude` passent par le proxy local. L'adresse du proxy est de
-la forme `http://opencodex:<jeton par installation>@127.0.0.1:<port>` ; le jeton est conservé
-dans `~/.opencodex/claude-intercept/proxy-token`, lisible uniquement par son propriétaire, et le
-proxy authentifie chaque CONNECT avec lui. Les autres chemins de
-`api.anthropic.com` sont relayés vers Anthropic. L'AC n'est jamais installée dans le magasin de
-confiance du système ; seuls les processus Node qui lisent `NODE_EXTRA_CA_CERTS` lui font confiance.
+Le mode first-party de Desktop route son onglet Code et ses sous-agents via OpenCodex. La CLI Claude Code autonome possède un interrupteur distinct. Les deux lisent les mêmes réglages de proxy et d’autorité dans `settings.json` : si un seul mode est actif, l’autre client traverse encore le proxy local, où TLS se termine, mais ses requêtes Messages sont relayées sans modification vers Anthropic.
```

Insert before current `docs-site/src/content/docs/fr/guides/claude-code.md:163`: `### Mode picker : modèles opencodex dans le sélecteur Code first-party`.
```diff
@@ -163,1 +163,8 @@
+### First-party de la CLI Claude Code
+
+Activez l’interrupteur dans Claude → Code ou lancez `ocx claude config set --first-party on` ; utilisez `off` pour désactiver. L’activation est refusée si le proxy local est indisponible, si l’autorité ne peut être préparée, si les réglages sont illisibles ou si des clés appartiennent à un autre programme. La désactivation reste enregistrable. Avec le seul first-party Desktop actif, définissez `NO_PROXY='*'` dans le shell pour un terminal entièrement natif. Le risque pour le compte décrit ci-dessus s’applique aussi à la CLI.
+Désactiver le routage Claude conserve les variables de proxy gérées. Tant que le listener fonctionne, toutes les requêtes Messages sont relayées sans modification ; après son arrêt, `claude` ne peut plus se connecter avant le lancement d’OpenCodex ou la désactivation du first-party Desktop/CLI. Le lancement natif via `ocx claude` ne définit `NO_PROXY=*` que pour un environnement géré sans proxy HTTPS hérité d’un autre programme. Sinon il conserve ce proxy et avertit que l’interception définie dans les réglages reste active ; désactivez le first-party ou retirez ce réglage.
+L’interface distingue les réglages illisibles (unknown), une URL opencodex avec jeton mais une AC étrangère (foreign : corrigez HTTPS_PROXY / NODE_EXTRA_CA_CERTS à la main) et le routage Claude désactivé avec un listener encore actif qui relaie sans modification (disabled : désactivez first-party avant le redémarrage). Sans listener, l’état est stopped ; avec une AC gérée mais un port ou jeton incorrect, il est broken. Avec le first-party actif et une interception indisponible, stopped et broken affichent routingOff : le routage Claude ou l’interception est désactivé, ou cette machine est cliente d’un autre hub opencodex ; réactivez l’interception ici ou désactivez first-party pour supprimer les réglages. Si l’interception est disponible, stopped demande de lancer opencodex et broken conseille `ocx ensure` ou un redémarrage. La CLI activée sans proxy est non appliquée ; un seul client activé avec un proxy opérationnel partage le relais ; aucun client activé avec un proxy restant produit un avertissement de réglage résiduel.
+unknown signifie qu’opencodex ne peut pas déterminer si les réglages pointent encore vers son proxy. Un proxy sans jeton sur 127.0.0.1 avec une AC étrangère est local : sa propriété est incertaine ; supprimez HTTPS_PROXY de ~/.claude/settings.json si vous ne l’utilisez plus. disabled exige des réglages appliqués correspondant au listener ; un port ou jeton différent donne broken même si le routage est désactivé.
+
 ### Mode picker : modèles opencodex dans le sélecteur Code first-party
```

### `docs-site/src/content/docs/ja/guides/claude-code.md` — current anchor `docs-site/src/content/docs/ja/guides/claude-code.md:120`: `OpenCodex が書くのは `~/.claude/settings.json`（`CLAUDE_CONFIG_DIR` に対応）の `env` にある`
```diff
@@ -119,9 +119,1 @@
-Desktop 本体は claude.ai に接続したままで、Chat、コネクタ、リモート操作も使えます。
-OpenCodex が書くのは `~/.claude/settings.json`（`CLAUDE_CONFIG_DIR` に対応）の `env` にある
-`HTTPS_PROXY` と `NODE_EXTRA_CA_CERTS` だけです。Code タブが起動する Claude Code、
-サブエージェント、ターミナルの `claude` CLI がローカルプロキシを通ります。プロキシのアドレスは
-`http://opencodex:<インストールごとのトークン>@127.0.0.1:<ポート>` の形で、トークンは
-所有者だけが読める `~/.opencodex/claude-intercept/proxy-token` に保管され、プロキシは
-すべての CONNECT をこのトークンで認証します。その他の
-`api.anthropic.com` パスは Anthropic に中継されます。CA は OS の信頼ストアに入れず、
-`NODE_EXTRA_CA_CERTS` を読む Node プロセスだけが信頼します。
+Desktop の 1P は Code タブとそのサブエージェントを OpenCodex に接続します。単独の Claude Code CLI には別の 1P スイッチがあります。両者は同じ `settings.json` のプロキシと CA 設定を読むため、一方だけオンでももう一方はローカルプロキシを通ります。その場合 TLS はローカルで終端しますが、Messages 要求は変更せず Anthropic に中継します。
```

Insert before current `docs-site/src/content/docs/ja/guides/claude-code.md:138`: `### Picker モード: 1P の Code タブで opencodex モデルを表示する`.
```diff
@@ -138,1 +138,8 @@
+### Claude Code CLI の 1P
+
+Claude → Code で CLI の 1P をオンにするか、`ocx claude config set --first-party on` を実行します。オフには `off` を使います。プロキシの停止、CA の準備失敗、設定の読み取り失敗、他プログラムが所有するキーがある場合、オンへの切り替えは拒否されます。オフはプロキシが使えなくても保存できます。Desktop の 1P だけがオンのとき、ターミナルから完全に直接接続するにはシェルで `NO_PROXY='*'` を設定してください。上記のアカウントリスクは CLI にも適用されます。
+Claude のルーティングを無効にしても管理対象の設定環境変数は残ります。リスナーが動いている間はすべての Messages 要求を変更せず中継しますが、停止後は OpenCodex を起動するか Desktop/CLI の 1P をオフにするまで通常の `claude` は接続できません。`ocx claude` は管理対象の設定があり、外部の HTTPS プロキシを継承していない場合だけ `NO_PROXY=*` を設定します。外部プロキシは保持し、設定側の傍受が続くため 1P をオフにするか設定を解除するよう警告します。
+画面では設定を読めない unknown、opencodex のトークン付き URL と管理外 CA が組み合わさった foreign、Claude ルーティングがオフでも動作中のリスナーが要求をそのまま中継する disabled を区別します。foreign は HTTPS_PROXY / NODE_EXTRA_CA_CERTS を手動で直し、disabled は再起動前に 1P をオフにして設定を消してください。リスナーがなければ stopped、管理対象 CA でもポートやトークンが違えば broken です。1P がオンでもインターセプトを提供できなければ、stopped と broken は routingOff を表示します。Claude ルーティングまたはインターセプトがオフか、この端末が別の opencodex ハブのクライアントであるため、この端末で再度有効にするか 1P をオフにして設定を削除するよう案内します。インターセプトを提供できる設定の場合だけ、stopped は opencodex の起動、broken は `ocx ensure` または再起動を案内します。CLI だけオンでプロキシ設定がなければ未適用、片方だけオンで正常なら共有中継、両方オフでも設定が残れば残留設定を表示します。
+unknown は設定がまだ opencodex のプロキシを指すか判断できない状態です。外部 CA とトークンなしの 127.0.0.1 プロキシがある場合は local と表示します。所有者を確認できないため、使っていなければ ~/.claude/settings.json から HTTPS_PROXY を削除してください。disabled は設定と動作中のリスナーが一致する場合だけで、ポートやトークンが違えばルーティングがオフでも broken です。
+
 ### Picker モード: 1P の Code タブで opencodex モデルを表示する
```

### `docs-site/src/content/docs/ru/guides/claude-code.md` — current anchor `docs-site/src/content/docs/ru/guides/claude-code.md:128`: ``~/.claude/settings.json` (с учётом `CLAUDE_CONFIG_DIR`). Claude Code во вкладке Code, его`
```diff
@@ -126,6 +126,1 @@
-Desktop остаётся подключён к claude.ai: Chat, коннекторы и удалённое управление продолжают работать.
-OpenCodex записывает только `HTTPS_PROXY` и `NODE_EXTRA_CA_CERTS` в блок `env` файла
-`~/.claude/settings.json` (с учётом `CLAUDE_CONFIG_DIR`). Claude Code во вкладке Code, его
-субагенты и отдельная CLI `claude` проходят через локальный прокси; остальные пути
-`api.anthropic.com` пересылаются Anthropic. CA не устанавливается в системное хранилище доверия:
-ему доверяют только процессы Node, читающие `NODE_EXTRA_CA_CERTS`.
+Режим first-party Desktop направляет вкладку Code и её субагентов через OpenCodex. У отдельного Claude Code CLI есть собственный переключатель. Оба читают одни настройки прокси и CA в `settings.json`: когда включён только один режим, другой клиент всё равно проходит через локальный прокси с локальным завершением TLS, но его запросы Messages без изменений пересылаются Anthropic.
```

Insert before current `docs-site/src/content/docs/ru/guides/claude-code.md:142`: `### Режим picker: модели opencodex в селекторе Code first-party`.
```diff
@@ -142,1 +142,8 @@
+### First-party для Claude Code CLI
+
+Включите переключатель в Claude → Code или выполните `ocx claude config set --first-party on`; для выключения используйте `off`. Включение отклоняется при недоступном прокси, ошибке подготовки CA, нечитаемых настройках или чужих ключах прокси. Выключение сохраняется и при недоступном прокси. Если активен только first-party Desktop, задайте `NO_PROXY='*'` в оболочке для полностью нативного терминала. Описанный выше риск для аккаунта относится и к CLI.
+Отключение маршрутизации Claude сохраняет управляемые настройки прокси. Пока listener работает, все запросы Messages пересылаются без изменений; после его остановки обычный `claude` не подключится до запуска OpenCodex или выключения first-party Desktop/CLI. Нативный запуск через `ocx claude` задаёт `NO_PROXY=*` только при управляемых настройках без унаследованного чужого HTTPS-прокси. Иначе он сохраняет чужой прокси и предупреждает, что перехват в настройках остаётся активным: выключите first-party или удалите настройку.
+Интерфейс различает нечитаемые настройки (unknown), URL opencodex с токеном и чужим CA (foreign: исправьте HTTPS_PROXY / NODE_EXTRA_CA_CERTS вручную) и выключенную маршрутизацию Claude при ещё работающем listener, который передаёт запросы без изменений (disabled: выключите first-party до перезапуска). Без listener состояние stopped; с управляемым CA, но неверным портом или токеном — broken. При включённом first-party и недоступном перехвате stopped и broken показывают routingOff: маршрутизация Claude или перехват отключены либо этот компьютер является клиентом другого хаба opencodex; включите перехват здесь или выключите first-party, чтобы удалить настройки. Только если перехват доступен, stopped предлагает запустить opencodex, а broken — выполнить `ocx ensure` или перезапустить его. Включённая CLI без прокси показывает отсутствие применения, один включённый клиент с работающим прокси — общий ретранслятор, оба выключенных при оставшемся прокси — остаточную настройку.
+unknown означает, что opencodex не может определить, указывают ли настройки на его прокси. Прокси без токена на 127.0.0.1 вместе с чужим CA получает состояние local: принадлежность не подтверждена; если он больше не нужен, удалите HTTPS_PROXY из ~/.claude/settings.json. disabled возможно только при совпадении настроек с работающим listener; другой порт или токен даёт broken даже при выключенной маршрутизации.
+
 ### Режим picker: модели opencodex в селекторе Code first-party
```

### `docs-site/src/content/docs/tr/guides/claude-code.md` — current anchor `docs-site/src/content/docs/tr/guides/claude-code.md:170`: `Claude Code, alt ajanları ve bağımsız `claude` CLI yerel vekilden geçer; diğer`
```diff
@@ -167,6 +167,1 @@
-Desktop claude.ai oturumunu korur; Chat, bağlayıcılar ve uzaktan kontrol çalışmaya devam eder.
-OpenCodex yalnızca `~/.claude/settings.json` dosyasındaki (`CLAUDE_CONFIG_DIR` desteklenir)
-`env` alanına `HTTPS_PROXY` ve `NODE_EXTRA_CA_CERTS` yazar. Code sekmesinin başlattığı
-Claude Code, alt ajanları ve bağımsız `claude` CLI yerel vekilden geçer; diğer
-`api.anthropic.com` yolları Anthropic'e iletilir. CA, işletim sisteminin güven deposuna
-kurulmaz; yalnızca `NODE_EXTRA_CA_CERTS` okuyan Node süreçleri ona güvenir.
+Desktop first-party, Code sekmesini ve alt ajanlarını OpenCodex üzerinden yönlendirir. Bağımsız Claude Code CLI için ayrı bir anahtar vardır. İkisi de `settings.json` içindeki aynı vekil ve CA ayarlarını okur: yalnızca biri açıkken diğeri de TLS’nin yerelde sonlandığı yerel vekilden geçer, ancak Messages istekleri değiştirilmeden Anthropic’e iletilir.
```

Insert before current `docs-site/src/content/docs/tr/guides/claude-code.md:183`: `### Picker modu: first-party Code sekmesinde opencodex modelleri`.
```diff
@@ -183,1 +183,8 @@
+### Claude Code CLI first-party
+
+Claude → Code bölümünde CLI anahtarını açın veya `ocx claude config set --first-party on` çalıştırın; kapatmak için `off` kullanın. Yerel vekil kullanılamıyorsa, CA hazırlanamazsa, ayarlar okunamazsa veya anahtarlar başka bir programa aitse açma isteği reddedilir. Kapatma yine de kaydedilir. Yalnız Desktop first-party açıkken terminalde tamamen yerel bağlantı için kabukta `NO_PROXY='*'` ayarlayın. Yukarıdaki hesap riski CLI için de geçerlidir.
+Claude yönlendirmesini kapatmak yönetilen vekil ayarlarını korur. Dinleyici çalışırken tüm Messages istekleri değiştirilmeden iletilir; durduğunda OpenCodex çalışana veya Desktop/CLI first-party kapatılana kadar doğrudan `claude` bağlanamaz. `ocx claude` yerel başlatması `NO_PROXY=*` değerini yalnızca yönetilen ayarlar varken ve yabancı bir HTTPS vekili miras alınmamışken ayarlar. Aksi halde yabancı vekili korur ve ayarlardaki kesmenin sürdüğünü bildirir: first-party özelliğini kapatın veya ayarı kaldırın.
+Arayüz okunamayan ayarları (unknown), opencodex belirteçli URL ile yabancı CA birleşimini (foreign: HTTPS_PROXY / NODE_EXTRA_CA_CERTS değerlerini elle düzeltin) ve Claude yönlendirmesi kapalıyken dinleyicinin istekleri değiştirmeden iletmeye devam etmesini (disabled: yeniden başlatmadan önce first-party modunu kapatın) ayırt eder. Dinleyici yoksa stopped; yönetilen CA ile port veya belirteç uyuşmuyorsa broken durumudur. First-party açıkken kesme kullanılamıyorsa stopped ve broken, routingOff uyarısını gösterir: Claude yönlendirmesi veya kesme kapalı ya da bu makine başka bir opencodex merkezinin istemcisidir; bu makinede yeniden etkinleştirin veya ayarları kaldırmak için first-party modunu kapatın. Kesme kullanılabilirken stopped opencodex uygulamasını başlatmayı, broken ise `ocx ensure` ya da yeniden başlatmayı önerir. Yalnız CLI açık ama vekil yoksa uygulanmadı, tek istemci açık ve vekil çalışıyorsa paylaşılan iletim, iki istemci kapalıyken vekil kalmışsa artık ayar uyarısı görünür.
+unknown, ayarların hâlâ opencodex vekiline işaret edip etmediğinin belirlenemediği anlamına gelir. Yabancı CA ile birlikte 127.0.0.1 üzerindeki belirteçsiz vekil local durumudur: sahipliği doğrulanamaz; artık kullanmıyorsanız ~/.claude/settings.json içindeki HTTPS_PROXY değerini kaldırın. disabled yalnızca ayarlar çalışan dinleyiciyle eşleşiyorsa geçerlidir; port veya belirteç farklıysa yönlendirme kapalı olsa bile broken görünür.
+
 ### Picker modu: first-party Code sekmesinde opencodex modelleri
```

### `docs-site/src/content/docs/zh-cn/guides/claude-code.md` — current anchor `docs-site/src/content/docs/zh-cn/guides/claude-code.md:115`: `和 `NODE_EXTRA_CA_CERTS`。Code 标签页启动的 Claude Code、子代理及独立的 `claude` CLI`
```diff
@@ -113,5 +113,1 @@
-Desktop 保持登录 claude.ai，聊天、连接器和远程控制仍可使用。OpenCodex 只在
-`~/.claude/settings.json`（支持 `CLAUDE_CONFIG_DIR`）的 `env` 中写入 `HTTPS_PROXY`
-和 `NODE_EXTRA_CA_CERTS`。Code 标签页启动的 Claude Code、子代理及独立的 `claude` CLI
-经过本地代理；其他 `api.anthropic.com` 路径会转发给 Anthropic。CA 不会安装到操作系统
-信任存储中，只有读取 `NODE_EXTRA_CA_CERTS` 的 Node 进程会信任它。
+Desktop 第一方模式通过 OpenCodex 处理 Code 标签页及其子代理。独立的 Claude Code CLI 有单独开关。两者读取同一份 `settings.json` 代理与 CA 设置：只开启其中一个时，另一个仍会经过本地代理，TLS 在本地终止，但 Messages 请求会原样转发给 Anthropic。
```

Insert before current `docs-site/src/content/docs/zh-cn/guides/claude-code.md:127`: `### Picker 模式：在第一方 Code 标签页中显示 opencodex 模型`.
```diff
@@ -127,1 +127,8 @@
+### Claude Code CLI 第一方模式
+
+在 Claude → Code 中开启 CLI 开关，或运行 `ocx claude config set --first-party on`；关闭时用 `off`。若本地代理不可用、CA 无法准备、设置无法读取，或代理键由其他程序所有，开启请求会被拒绝。关闭操作始终可以保存。仅开启 Desktop 第一方模式时，要让终端完全原生直连，请在 shell 中设置 `NO_PROXY='*'`。上述账户风险也适用于 CLI。
+关闭 Claude 路由会保留由 OpenCodex 管理的代理设置。监听器仍运行时，所有 Messages 请求原样转发；停止后，运行 OpenCodex 或关闭 Desktop/CLI 第一方模式之前，直接运行 `claude` 无法连接。`ocx claude` 原生启动仅在有自有设置且未继承外部 HTTPS 代理时设置 `NO_PROXY=*`。否则保留外部代理，并警告设置中的拦截仍生效；请关闭第一方模式或取消该设置。
+界面区分设置不可读（unknown）、带 opencodex 令牌的代理 URL 却搭配外部 CA（foreign：手动修正 HTTPS_PROXY / NODE_EXTRA_CA_CERTS），以及 Claude 路由已关闭但仍有监听器原样转发请求（disabled：重启前关闭第一方模式以清除设置）。没有监听器时为 stopped；使用受管理的 CA 但端口或令牌不匹配时为 broken。第一方模式开启但无法提供拦截服务时，stopped 和 broken 都显示 routingOff：Claude 路由或拦截功能已关闭，或此设备是另一台 opencodex 中枢的客户端；请在此设备上重新启用拦截服务，或关闭第一方模式以移除设置。仅在拦截服务可用时，stopped 才提示启动 opencodex，broken 才提示运行 `ocx ensure` 或重启。CLI 已开启但没有代理设置为未应用；仅开启一个客户端且代理正常时提示共享转发；两个客户端都关闭但代理设置仍在时提示残留。
+unknown 表示 opencodex 无法确定设置是否仍指向自己的代理。外部 CA 搭配 127.0.0.1 上无令牌的代理时显示 local：归属无法确认；如果不再使用，请从 ~/.claude/settings.json 中删除 HTTPS_PROXY。disabled 仅在设置与运行中的监听器匹配时出现；端口或令牌不匹配时，即使路由关闭也显示 broken。
+
 ### Picker 模式：在第一方 Code 标签页中显示 opencodex 模型
```

### `docs-site/src/content/docs/zh-tw/guides/claude-code.md` — current anchor `docs-site/src/content/docs/zh-tw/guides/claude-code.md:125`: `與 `NODE_EXTRA_CA_CERTS`。Code 分頁啟動的 Claude Code、子代理及獨立的 `claude` CLI`
```diff
@@ -123,5 +123,1 @@
-Desktop 維持 claude.ai 登入，聊天、連接器和遠端控制仍可使用。OpenCodex 只在
-`~/.claude/settings.json`（支援 `CLAUDE_CONFIG_DIR`）的 `env` 中寫入 `HTTPS_PROXY`
-與 `NODE_EXTRA_CA_CERTS`。Code 分頁啟動的 Claude Code、子代理及獨立的 `claude` CLI
-經過本機代理；其他 `api.anthropic.com` 路徑會轉送給 Anthropic。CA 不會安裝到作業系統
-信任儲存區，只有讀取 `NODE_EXTRA_CA_CERTS` 的 Node 程序會信任它。
+Desktop 第一方模式透過 OpenCodex 處理 Code 分頁及其子代理。獨立的 Claude Code CLI 有單獨開關。兩者讀取同一份 `settings.json` 代理與 CA 設定：只啟用其中一個時，另一個仍會經過本機代理，TLS 在本機終止，但 Messages 請求會原樣轉送給 Anthropic。
```

Insert before current `docs-site/src/content/docs/zh-tw/guides/claude-code.md:137`: `### Picker 模式：在第一方 Code 分頁顯示 opencodex 模型`.
```diff
@@ -137,1 +137,8 @@
+### Claude Code CLI 第一方模式
+
+在 Claude → Code 開啟 CLI 開關，或執行 `ocx claude config set --first-party on`；關閉時使用 `off`。若本機代理無法使用、CA 無法準備、設定無法讀取，或代理鍵由其他程式擁有，開啟要求會被拒絕。關閉仍可儲存。只有 Desktop 第一方模式開啟時，若要讓終端機完全原生直連，請在 shell 設定 `NO_PROXY='*'`。上述帳號風險也適用於 CLI。
+關閉 Claude 路由會保留由 OpenCodex 管理的代理設定。監聽器仍執行時，所有 Messages 請求原樣轉送；停止後，執行 OpenCodex 或關閉 Desktop/CLI 第一方模式前，直接執行 `claude` 無法連線。`ocx claude` 原生啟動只在有自有設定且未繼承外部 HTTPS 代理時設定 `NO_PROXY=*`。否則保留外部代理，並警告設定中的攔截仍生效；請關閉第一方模式或取消該設定。
+介面會區分設定無法讀取（unknown）、帶有 opencodex 權杖的代理 URL 卻搭配外部 CA（foreign：手動修正 HTTPS_PROXY / NODE_EXTRA_CA_CERTS），以及 Claude 路由已關閉但監聽器仍原樣轉送要求（disabled：重新啟動前關閉第一方模式以移除設定）。沒有監聽器時為 stopped；使用受管理的 CA 但連接埠或權杖不符時為 broken。第一方模式開啟但無法提供攔截服務時，stopped 和 broken 都顯示 routingOff：Claude 路由或攔截功能已關閉，或這台裝置是另一個 opencodex 中樞的用戶端；請在這台裝置上重新啟用攔截服務，或關閉第一方模式以移除設定。只有攔截服務可用時，stopped 才提示啟動 opencodex，broken 才提示執行 `ocx ensure` 或重新啟動。CLI 已開啟但沒有代理設定時為未套用；只開啟一個用戶端且代理正常時提示共享轉送；兩者皆關閉但代理設定仍在時提示殘留。
+unknown 表示 opencodex 無法確定設定是否仍指向自己的代理。外部 CA 搭配 127.0.0.1 上沒有權杖的代理時顯示 local：無法確認歸屬；若不再使用，請從 ~/.claude/settings.json 移除 HTTPS_PROXY。disabled 僅在設定與執行中的監聽器相符時出現；連接埠或權杖不相符時，即使路由關閉也顯示 broken。
+
 ### Picker 模式：在第一方 Code 分頁顯示 opencodex 模型
```
English mode-inference copy at `guides/claude-code.md:197-201` and the seven corresponding paragraphs must add: an env owned solely for CLI first-party is not evidence that Desktop is in first-party mode. This is the wp2 D1 inference contract; keep each locale's existing mode precedence wording, adding the exclusion.

## Structure ownership pointer
The source-owned structure updates are specified in `010_foundations.md` (config, Desktop inference and the pure eight-state F classifier), `020_intercept_classification.md` (runtime and relay), and `030_management_cli.md` (`structure/gui-and-management-api.md`: GET emits `sharedProxy` from the ordered F-contract, derives `cliFirstPartyApplied` from `live`, and reads `interceptRunning` from bound listener plus eligibility, and `interceptEligible` from the same config snapshot; PUT checks the persisted port inside its mutation lock and warns for every non-`none` residual status, including `local`, after nothing-desired reconcile). wp5 makes no `structure/` edit. The GUI consumes the single status contract and documents the ten notice outcomes.

## PLAN-FIELD-CHAIN-01
| Value | Creation | Serialization | Deserialization | Consumers |
|---|---|---|---|---|
| `ClaudeCodeState.cliFirstParty` | wp4 GET `src/server/management/agent-settings-routes.ts`; immediate GUI PUT and `src/cli/integrations.ts` CLI command | wp4 `src/types/config.ts` → `src/config/schema/` persisted config; GET/PUT JSON | wp4 config loader; GUI `ClaudeCode.tsx:fetchCode` normalizes old cache | GUI switch and shared notice; wp2 `src/claude/first-party-settings.ts`; wp3 runtime callback |
| `cliFirstPartyApplied` | wp4 `cliFirstParty && sharedProxy === "live"` | GET JSON only; N/A persisted, observational | GUI GET normalization | Available for status display; notice selector does not consume it |
| `desktopFirstParty` | wp4 Desktop desired-state computation | GET JSON only; N/A persisted, derived | GUI GET/cache normalization | `selectFirstPartyNotice` desired/XOR and residual decisions |
| `interceptRunning` | wp4 bound listener exists and `claudeInterceptEnabled(config)` | GET JSON only; N/A persisted, live state | GUI GET normalization | Status display only; disabled Claude relays even while a listener remains bound; never an input to notice selection |
| `interceptEligible` | wp4 `claudeInterceptEnabled(config)` from the same snapshot as `sharedProxy` and `interceptRunning` | GET JSON boolean only; N/A persisted, observational | GUI GET/cache: `value === undefined ? true : value === true` | Selector shows `routingOff` for stopped/broken only when false; old cache cannot show `routingOff` |
| `sharedProxy` | wp2 `firstPartyProxyStatus` consumes inspected settings, bound port, eligibility in F-contract order; wp4 GET uses `deps.getClaudeInterceptState` | GET JSON eight-state enum; N/A persisted, observational | `ClaudeCode.tsx:fetchCode` and initial cache preserve all eight members; only `undefined` defaults to `none`, while `null` or any unrecognized value becomes `unknown` | `selectFirstPartyNotice` yields ten notice variants or null by ordered precedence; `FIRST_PARTY_PROXY_STATUSES` and the `Record` coverage map live in GUI source; wp4 PUT warns for non-`none` residual, except unreadable settings take the 500 path |
| refusal `code` values | wp4 PUT guard results | HTTP JSON `{error,code}` | GUI response JSON branch | six localized refusal messages; unknown code → `claude.saveFailed` |
| GUI locale keys | English catalog `en.ts` | compiled bundle; N/A persisted | `catalogs.ts` `Record<TKey,string>` | `ClaudeCode.tsx`, `ClaudeDesktop.tsx` |

The `sharedProxy` enum is created by wp2, emitted by wp4 and consumed exhaustively in wp5. A tokenless loopback URL beside a foreign CA is `local`; a token-bearing opencodex URL beside a foreign CA is `foreign`. With a bound listener, matching applied settings and ineligible routing yield `disabled`, while a stale port or token yields `broken` even if ineligible. No bound listener yields `stopped` after the foreign/local checks. `interceptEligible` is separately emitted by wp4 from the same config snapshot, normalized by wp5 (missing means true), and read only after the selector's unknown/foreign/local/residual/disabled branches. The refusal codes are fixed by wp4; this phase consumes every listed member. No `cliFirstParty` field is serialized by the draft Save writer.

## Tests and activation
Modify existing `gui/tests/claude-toggle-race.test.tsx` (current anchor `:31` `let claudeEnabled = false;`, `:93` `const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: boolean };`, `:161` `test("rapid Claude toggle clicks issue only one PUT until the first settles", async () => {`):
```diff
@@ -31,1 +31,2 @@
 let claudeEnabled = false;
+let cliFirstParty = false;
@@ -82,1 +83,2 @@
   claudeEnabled = false;
+  cliFirstParty = false;
@@ -93,1 +95,2 @@
-      const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: boolean };
+      const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: boolean; cliFirstParty?: boolean };
+      if (typeof body.cliFirstParty === "boolean") cliFirstParty = body.cliFirstParty;
@@ -100,1 +103,1 @@
-      return jsonResponse({ ...CLAUDE_CODE_STATE, enabled: claudeEnabled });
+      return jsonResponse({ ...CLAUDE_CODE_STATE, enabled: claudeEnabled, cliFirstParty, desktopFirstParty: false, cliFirstPartyApplied: cliFirstParty && claudeEnabled, interceptEligible: claudeEnabled, interceptRunning: claudeEnabled, sharedProxy: cliFirstParty ? (claudeEnabled ? "live" : "stopped") : "none" });
@@ -103,1 +106,1 @@
-      return jsonResponse({ ...CLAUDE_CODE_STATE, enabled: claudeEnabled });
+      return jsonResponse({ ...CLAUDE_CODE_STATE, enabled: claudeEnabled, cliFirstParty, desktopFirstParty: false, cliFirstPartyApplied: cliFirstParty && claudeEnabled, interceptEligible: claudeEnabled, interceptRunning: claudeEnabled, sharedProxy: cliFirstParty ? (claudeEnabled ? "live" : "stopped") : "none" });
```
Append a mounted test using the existing `act`, `waitFor`, `LanguageProvider` and `App` imports; set `claudeEnabled = true` before mounting so the fixture reports a running intercept:
```diff
@@ -225,0 +226,28 @@
+test("CLI first-party waits for one PUT and a confirmed GET", async () => {
+  claudeEnabled = true;
+  const { resetApiAuthFetchForTests, installApiAuthFetch } = await import("../src/api");
+  resetApiAuthFetchForTests();
+  installApiAuthFetch();
+  Object.defineProperty(globalThis, "fetch", { configurable: true, value: window.fetch });
+  const [{ createRoot }, { LanguageProvider }, { default: App }] = await Promise.all([
+    import("react-dom/client"), import("../src/i18n/provider"), import("../src/App"),
+  ]);
+  await act(async () => {
+    root = createRoot(container);
+    root.render(<LanguageProvider><App /></LanguageProvider>);
+  });
+  const firstPartySwitch = () => Array.from(container.querySelectorAll("button")).find(
+    button => button.getAttribute("aria-label") === "Toggle Claude Code CLI first-party",
+  ) as HTMLButtonElement | undefined;
+  await waitFor(() => !!firstPartySwitch());
+  await act(async () => {
+    firstPartySwitch()!.click();
+    firstPartySwitch()!.click();
+    firstPartySwitch()!.click();
+  });
+  expect(putBodies).toEqual([{ cliFirstParty: true }]);
+  expect(firstPartySwitch()!.disabled).toBe(true);
+  expect(firstPartySwitch()!.getAttribute("aria-pressed")).toBe("false");
+  await act(async () => { releasePut?.(); releasePut = null; await Promise.resolve(); });
+  await waitFor(() => firstPartySwitch()?.getAttribute("aria-pressed") === "true");
+});
```
Add sibling parameterized cases for all six refusal codes (409/500 response `{error,code}` → exact localized message and switch unchanged), malformed/network response → fallback, successful PUT with divergent GET → GET wins, off with stopped intercept → `false` PUT persists, old cached DTO → false defaults, Save after immediate toggle → body lacks `cliFirstParty`. Each case must set the mock response to activate its branch.

Modify `gui/tests/claude-desktop-mode-picker.test.tsx` (current anchor `:176` `expect(bar.textContent ?? "").toContain("First-party: Code tab routed through the local proxy");`):
```diff
@@ -176,1 +176,2 @@
-  expect(bar.textContent ?? "").toContain("First-party: Code tab routed through the local proxy");
+  expect(bar.textContent ?? "").toContain("First-party: Desktop Code tab routed through the local proxy");
+  expect(container.textContent ?? "").toContain("the standalone CLI has its own switch");
```
Create `gui/tests/claude-code-first-party.test.ts` with this executable selector table (import from `../src/pages/claude-code-first-party`). It covers all 64 status × intent × eligibility combinations without a listener or proxy:
```ts
import { expect, test } from "bun:test";
import { FIRST_PARTY_PROXY_STATUSES, normalizeSharedProxy, selectFirstPartyNotice, type FirstPartyNotice } from "../src/pages/claude-code-first-party";
import type { ClaudeCodeState } from "../src/pages/claude-code-types";

type Notices = readonly [FirstPartyNotice, FirstPartyNotice, FirstPartyNotice, FirstPartyNotice];
const expectedEligible: Record<ClaudeCodeState["sharedProxy"], Notices> = {
  none:     [null,       null,       "notApplied", "notApplied"],
  live:     ["residual", "shared",   "shared",     null],
  stopped:  ["residual", "stopped",  "stopped",    "stopped"],
  disabled: ["residual", "disabled", "disabled",   "disabled"],
  broken:   ["residual", "broken",   "broken",     "broken"],
  foreign:  ["foreign",  "foreign",  "foreign",    "foreign"],
  local:    ["local",    "local",    "local",      "local"],
  unknown:  ["unknown",  "unknown",  "unknown",    "unknown"],
};
const expectedIneligible: Record<ClaudeCodeState["sharedProxy"], Notices> = {
  ...expectedEligible,
  stopped: ["residual", "routingOff", "routingOff", "routingOff"],
  broken:  ["residual", "routingOff", "routingOff", "routingOff"],
};
for (const [interceptEligible, expected] of [[true, expectedEligible], [false, expectedIneligible]] as const) {
  for (const sharedProxy of FIRST_PARTY_PROXY_STATUSES) {
    const [neither, desktopOnly, cliOnly, both] = expected[sharedProxy];
    for (const [desktopFirstParty, cliFirstParty, notice] of [
      [false, false, neither], [true, false, desktopOnly],
      [false, true, cliOnly], [true, true, both],
    ] as const) {
      test(`${sharedProxy}: eligible ${interceptEligible}, Desktop ${desktopFirstParty}, CLI ${cliFirstParty}`, () => {
        expect(selectFirstPartyNotice({ sharedProxy, desktopFirstParty, cliFirstParty, interceptEligible })).toBe(notice);
      });
    }
  }
}
test("only missing status normalizes to none; invalid and future values warn", () => {
  for (const status of FIRST_PARTY_PROXY_STATUSES) expect(normalizeSharedProxy(status)).toBe(status);
  expect(normalizeSharedProxy("future")).toBe("unknown");
  expect(normalizeSharedProxy(42)).toBe("unknown");
  expect(normalizeSharedProxy(undefined)).toBe("none");
  expect(normalizeSharedProxy(null)).toBe("unknown");
});
```
The GUI-source `Record<ClaudeCodeState["sharedProxy"], true>` is checked by `tsc -p gui/tsconfig.app.json`; the test iterates the source roster and its typed expectation maps cover each status with both eligibility values. A new status requires a roster entry and a selector outcome. The selector's ordered branches encode: unknown, foreign, local, residual, disabled, routingOff for ineligible stopped/broken, stopped, broken, notApplied, shared, then null.

wp2 owns the classifier implementation and its focused test in `tests/claude-integration/claude-desktop-first-party.test.ts`. Add this typed table there (register no new root test file); the F-contract rule implementation belongs in `010_foundations.md`, with `000_plan.md` the cross-phase authority:
```ts
const owned = "http://opencodex:t@127.0.0.1:10100";
const drifted = "http://opencodex:old@127.0.0.1:10100";
const tokenless = "http://127.0.0.1:10100";
const ca = "/owned/ca.pem";
const classifierCases = [
  [{ kind: "unreadable", path: "/settings.json" }, null, false, "unknown"],
  [{ kind: "absent" }, null, false, "none"],
  [{ kind: "stale", env: { NODE_EXTRA_CA_CERTS: ca } }, null, false, "none"],
  [{ kind: "foreign", env: { HTTPS_PROXY: tokenless, NODE_EXTRA_CA_CERTS: "/foreign/ca.pem" } }, 10100, true, "local"],
  [{ kind: "foreign", env: { HTTPS_PROXY: owned, NODE_EXTRA_CA_CERTS: "/foreign/ca.pem" } }, 10100, true, "foreign"],
  [{ kind: "applied", env: { HTTPS_PROXY: owned, NODE_EXTRA_CA_CERTS: ca } }, null, false, "stopped"],
  [{ kind: "applied", env: { HTTPS_PROXY: owned, NODE_EXTRA_CA_CERTS: ca } }, 10100, false, "disabled"],
  [{ kind: "stale", env: { HTTPS_PROXY: "http://opencodex:t@127.0.0.1:10099", NODE_EXTRA_CA_CERTS: ca } }, 10100, false, "broken"],
  [{ kind: "stale", env: { HTTPS_PROXY: drifted, NODE_EXTRA_CA_CERTS: ca } }, 10100, false, "broken"],
  [{ kind: "applied", env: { HTTPS_PROXY: owned, NODE_EXTRA_CA_CERTS: ca } }, 10100, true, "live"],
  [{ kind: "applied", env: { HTTPS_PROXY: "http://opencodex:t@127.0.0.1:80", NODE_EXTRA_CA_CERTS: ca } }, 80, true, "live"],
  [{ kind: "applied", env: { HTTPS_PROXY: owned, NODE_EXTRA_CA_CERTS: ca } }, 10101, true, "broken"],
  [{ kind: "stale", env: { HTTPS_PROXY: drifted, NODE_EXTRA_CA_CERTS: ca } }, 10100, true, "broken"],
] as const;
for (const [settings, boundProxyPort, eligible, expected] of classifierCases) {
  test(`classifier: ${settings.kind}, ${boundProxyPort}, ${eligible}, ${expected}`, () => {
    expect(firstPartyProxyStatus({ settings, boundProxyPort, eligible })).toBe(expected);
  });
}
```
Import `firstPartyProxyStatus` from `../../src/claude/first-party-settings` in that existing test. The table activates each ordered F classifier rule, including port 80, tokenless foreign CA (`local`), token-bearing foreign CA (`foreign`), applied settings on a bound ineligible listener (`disabled`), stale older-port and same-port token drift on an ineligible listener (`broken`), stopped before eligibility, and owned-CA drift. Add PUT coverage in wp4: after a nothing-desired reconcile, `readFirstPartyProxyStatus(...) !== "none"` yields `settings_residual`, including `local`; unreadable settings take the existing 500 path. In the route test, CLI off with a legacy tokenless loopback URL and foreign CA returns 200 plus `settings_residual` and leaves those settings untouched. GET must derive `cliFirstPartyApplied` only for `live`, `interceptEligible` from `claudeInterceptEnabled(config)` in the same snapshot used by the classifier, and `interceptRunning` from bound listener plus eligibility.

Add this GET route table to `tests/claude-integration/claude-management-api.test.ts` using its existing temporary Claude settings directory and `getClaudeInterceptState` seam. Keep the seam bound at port 10100 and the owned CA matching; write a stale `HTTPS_PROXY` URL at port 10099. Change only the named eligibility field between rows, GET each time, and assert every listed field. Each ineligible row proves that a bound listener and stale settings stay `broken`; the selector then chooses `routingOff` instead of suggesting `ocx ensure`.

| Eligibility configuration | Seam bound port | Settings proxy port | GET `sharedProxy` | GET `interceptEligible` | GET `interceptRunning` |
|---|---:|---:|---|---|---|
| `claudeCode.enabled: false` | 10100 | 10099 | `broken` | `false` | `false` |
| `claudeCode.intercept.enabled: false` | 10100 | 10099 | `broken` | `false` | `false` |
| `runtimeRole: "client"` | 10100 | 10099 | `broken` | `false` | `false` |
| All three eligibility conditions enabled | 10100 | 10099 | `broken` | `true` | `true` |

Mounted tests use fresh GET fixtures and assert one notice by role/text for: unreadable `unknown` regardless of intent, token-bearing URL with foreign CA `foreign` regardless of intent, tokenless loopback URL with foreign CA `local` regardless of intent, matching applied settings with bound ineligible listener `disabled` when an intent is on, `stopped` with no bound listener and eligible routing, `broken` from older URL port or token drift with owned CA and eligible routing, ineligible `stopped` and `broken` with an intent on (`routingOff`), `live` with XOR client (shared relay), `none` with CLI intent (not applied), and `live/stopped/disabled/broken` with both intents off (residual). Assert that `unknown/foreign/local` override residual even with both intents off; residual also overrides `routingOff`. For `live` with both intents on, no proxy notice; for `none` with Desktop-only intent, no proxy notice. Assert CLI account-risk independently on CLI intent. A CA-only stale env or absent URL yields `none`, never stopped/foreign. Mount an old cached DTO without `sharedProxy` and assert no proxy notice (`none`); mount an old cached DTO with `stopped` or `broken` but no `interceptEligible` and assert the eligible notice, never `routingOff`; a new DTO with `interceptEligible:false` shows `routingOff`. Mount `null` and future status values and assert the `unknown` notice; a valid `unknown` must render its notice. Use DOM text/role, not snapshots. wp2–wp4 tests own status classification, disabling-Claude relay, and `enabled:false` env retention.

All three GUI test files live under `gui/tests/`; root test layout registries do not apply. If a new `tests/**.test.ts` file is created by later work, register its basename in both `scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json`; source-oracle tests use `tests/helpers/repo-root.ts`.

## G-contract acceptance
| Activation | Observable acceptance |
|---|---|
| Settings unreadable, absent, missing proxy URL, tokenless URL with foreign CA, or token-bearing URL with foreign CA | Classifier returns `unknown`, `none`, `none`, `local`, or `foreign` respectively; no token is minted by inspection. |
| Owned URL with no bound listener; bound but ineligible listener with matching applied settings; applied URL on port 80 with bound 80; stale older port or token drift with bound ineligible listener | Classifier returns `stopped`, `disabled`, `live`, or `broken` for each stale case respectively. |
| GET with CLI intent on and each status; GET with stale settings and a seam-bound listener for each of the three ineligibility causes | `cliFirstPartyApplied` is true only for `live`; `interceptEligible` equals `claudeInterceptEnabled(config)` in the same snapshot as `sharedProxy`; `interceptRunning` is true only when both bound and eligible. Each stale-port, seam-bound ineligible route case returns `broken`, `false`, `false`; the eligible control returns `broken`, `true`, `true`. |
| PUT after nothing-desired reconcile leaves a readable non-`none` status, including legacy tokenless loopback URL with foreign CA; settings unreadable | First returns 200 plus `settings_residual` with settings untouched for the `local` case; second follows the existing unreadable 500 path. |
| Selector given each of eight statuses × four intent pairs × two eligibility values | Sixty-four exact outcomes follow unknown → foreign → local → residual → disabled → routingOff (ineligible stopped/broken) → stopped → broken → notApplied → shared → null precedence; only `undefined` status normalizes to `none`; `null`, future string, and 42 normalize to `unknown`. |
| Mounted GUI renders unknown, foreign, local, disabled, routingOff, stopped, broken, notApplied, shared, and residual | One corresponding proxy notice appears; an old cache without `interceptEligible` acts eligible and cannot show `routingOff`; risk notice remains independent; all ten locale catalogs provide the same keys. |
| Eight public guides describe an ineligible bound listener, foreign CA, local unknown-ownership proxy, uncertain settings, and stopped/broken recovery | Each distinguishes pass-through until restart, manual HTTPS_PROXY / NODE_EXTRA_CA_CERTS repair, optional removal of unused local HTTPS_PROXY, and inability to determine settings state; ineligible stopped/broken directs routing back on or first-party off, while eligible stopped directs starting opencodex and eligible broken directs `ocx ensure` or restart. |

## Verifiers actually run (plan baseline; rerun after build)
| Command | Exit | Reads this phase target? |
|---|---:|---|
| `rg -n "Code tab" src/cli src/claude src/server` | 0 | Yes: found `src/cli/claude-desktop.ts:56,356` and picker-specific statements |
| `bun test gui/tests/claude-toggle-race.test.tsx gui/tests/claude-desktop-mode-picker.test.tsx` | 1 | No: Bun treated filters as names and matched no files; corrected below |
| `bun test ./gui/tests/claude-toggle-race.test.tsx ./gui/tests/claude-desktop-mode-picker.test.tsx` | 1 | Yes: discovers both files, then fails before tests because local `zod/v4` dependency is unavailable (`src/config/schema/leaf-validators.ts`) |
| `bun test ./gui/tests/claude-toggle-race.test.tsx ./gui/tests/claude-desktop-mode-picker.test.tsx` (revision 2, dependencies installed) | 0 | Yes: 10 pass, 0 fail, 46 assertions; baseline existing tests only, not the planned new cases |
| Earlier F baseline: `bun -e` extracting the selector and both executable tables above; evaluates F rules with a pure in-memory classifier | 0 | Historical result before G: 57 assertions passed (32 selector combinations, 12 normalization assertions, 13 classifier cases). This checks the former plan, not future source code. |
| `bun -e` extracts the current G selector source and selector table, transpiles them in memory, and evaluates the two GET route rows | 0 | Current G plan: 76 selector/normalization assertions (64 selector + 12 normalization) and 2 GET route rows passed. This checks this document's contract, not future source code or a live route. |
| `cd gui && bun x tsc -p tsconfig.app.json --noEmit` | 0 | `include: ["src"]` confirms the future GUI source coverage map will be typechecked; current exit 0 is a baseline, not proof that the planned module compiles. |

Future builder gates (maintainer directive: no local test suites): `bun run typecheck`, `cd gui && bun x tsc -p tsconfig.app.json --noEmit && bun run lint:i18n && bun run lint && bun run build`, and `cd docs-site && bun install --frozen-lockfile && bun run build` if it completes in reasonable time. The GUI and route test files named above are written in wp5 and verified by hosted CI on the PR head, never run locally. These are planned, **not** claimed passed. `lint:i18n` checks JSX literals, while TypeScript `Record<TKey,string>` checks locale completeness; neither verifies translation quality. Take GUI screenshots showing the new switch and routingOff/stopped/broken/residual notices, upload through the `pr-assets` branch convention in root `AGENTS.md`; link the commit-SHA asset in the PR description, never commit it to this feature branch.

## Risks, bypass, open questions
- Shared `settings.json` means turning one intent off does not remove the env while the other needs it; disabling Claude alone also leaves it untouched (M4/M6). A relayed client's TLS terminates locally while the listener runs. If settings point to a stopped proxy, plain `claude` cannot connect. Document both states wherever a switch is shown.
- The User-Agent split is a routing hint, forgeable by a local process. wp3 owns that classifier; this phase must not imply an authorization boundary.
- PLAN-BYPASS-NAMED-01 for the GUI's in-flight guard: tier E7 (component state/ref), executing surface `ClaudeCode.tsx`, bypass via direct management API/CLI or another tab, residual risk concurrent writes handled by wp4 transaction, wording “UI duplicate-click guard,” not enforcement. Final layer: wp4 server transaction and owned-env checks, subject to local-user control.
- Main must verify wp4 GET exposes the five booleans and eight-state `sharedProxy`, with CA-only stale env as `none`, tokenless local URL plus foreign CA as `local`, a token-bearing URL plus foreign CA as `foreign`, unreadable as `unknown`, matching applied settings on a bound ineligible listener as `disabled`, stale port/token on that listener as `broken`, no bound listener as `stopped`, and owned-CA drift as `broken`. The bound-stale `enabled:false` GET case must expose `sharedProxy:"broken"`, `interceptEligible:false`, and `interceptRunning:false` from one snapshot. The awaited GET supports a wp4 PUT success body of `{ok:true}` or 204. RP2–RP5 server checks remain owned by wp2–wp4; wp5 consumes their result.
- The original plan baseline could not execute the two GUI tests because `zod/v4` was absent. Revision 2 re-ran them successfully with installed dependencies; the planned new cases still require build-phase verification.

Revisions 2, 3, 5, 6, 7, RP1–RP6, and E1–E4 are superseded by the current in-place G-contract above. The F classifier remains unchanged; G adds eligibility to GET and the GUI notice contract.

## Replan F (historical; notice selector superseded by G)
- F1: Eight statuses include `local`; only `undefined` normalizes to `none`, while `null` and unrecognized values warn as `unknown`.
- F2: The F-stage source-owned roster and coverage map fed 32 selector cases; G expands them to 64 while preserving `local` before residual and residual before disabled.
- F3: Ten catalogs and eight guides add local ownership uncertainty and broader unknown copy; route and classifier tests cover foreign CA, bound eligibility, and stale settings.
- F4: The F-stage field chain, structure pointer, acceptance, and PUT residual coverage followed the wp2/wp4 classifier contract; the current field chain and acceptance are G.

## Replan G
- G1: GET carries `interceptEligible` from the classifier's config snapshot; GUI GET and cache normalization default only a missing eligibility field to true.
- G2: The selector inserts `routingOff` after disabled for ineligible stopped/broken states; eligible stopped/broken retain distinct recovery advice. The 64-case table tests both values.
- G3: Ten catalogs and eight guides give routing-off recovery advice; the notice map, mounted cases, route table, field chain, and acceptance now use the single G definition.

## Replan H changelog
- H: Made the ten-locale `routingOff` copy and eight guide descriptions cover all three ineligibility causes; expanded the GET route table and acceptance to each cause.

# 020 — Phase 2: reclassify local to oauth

**Work-phase:** wp3. **Write set:** `src/providers/registry.ts`,
`src/oauth/index.ts`, `src/providers/devin-cli-authmode-migration.ts` (NEW),
`src/providers/model-rename-startup.ts`, `src/adapters/devin-cli/adapter.ts`
(comment only), `tests/providers/devin-cli-adapter.test.ts`, NEW migration test.

Rewritten after audit rounds 1 and 2. Folded: `dashboardPreset: false` (blocker
2, missing from the first draft) and the honest upgrade story (blocker 1).

Atomic: `oauthConfig("devin-cli")` throws unless the registry row already says
`authKind: "oauth"` (`src/providers/derive.ts:350-353`), so the registry edit and
the OAUTH_PROVIDERS entry land in one commit.

## MODIFY `src/providers/registry.ts`

```diff
-    // Drives the locally installed Devin CLI. The CLI owns its own credentials
-    // from `devin auth login`, so this provider takes no key and the proxy never
-    // holds one. Inference happens in the child process, which is why the
-    // destination is a stdio scheme rather than a URL.
+    // Drives the locally installed Devin CLI. The CLI owns its own credential and
+    // authenticates itself inside the child, so the proxy still never holds a
+    // Devin token and the adapter never reads one at request time.
+    //
+    // `oauth` classifies the ACCOUNT, not the transport. This is not a local
+    // runtime: unlike Ollama or LM Studio it cannot answer at all until a vendor
+    // account is signed in, and `local` grouped it with things that have no
+    // account. It is also the only classification under which the row reaches the
+    // dashboard Accounts tab, which is built from OAUTH_PROVIDERS.
     id: "devin-cli",
-    authKind: "local",
+    authKind: "oauth",
     featured: false,
-    dashboardPreset: true,
+    // Off, like `devin`. `deriveProviderPresets` keys the preset
+    // catalog off this flag, so leaving it true would draw the row twice: once as
+    // an Accounts login row and again as a preset tile.
+    dashboardPreset: false,
```

`note` keeps "no API key is stored by opencodex" — still true — and gains
"Sign in from the dashboard, or run `devin auth login` yourself; opencodex only
records that the CLI session exists."

## MODIFY `src/oauth/index.ts`

```ts
"devin-cli": {
  login: (ctrl, opts) => loginDevinCli(ctrl, opts),
  refresh: (rt, signal, credential) => refreshDevinCliToken(rt, signal, credential),
  providerConfig: oauthConfig("devin-cli"),
  defaultModel: oauthDefaultModel("devin-cli"),
  // No endpoint to refresh against: the CLI owns the session. Same posture as
  // `devin` and `orcarouter-oauth`.
  defaultRefreshPolicy: "disabled",
},
```

Not in `FORCE_REFRESH_PROVIDERS`: a 401 cannot arrive from a provider that never
sends a token.

## NEW `src/providers/devin-cli-authmode-migration.ts`

`src/server/auth-cors.ts:731-737` rejects a saved row whose `authMode === "local"`
once the registry entry is not local, and `derive.ts:217-231` seeded exactly that
value into every config saved while devin-cli was local.

```ts
export function projectDevinCliAuthMode(config: OcxConfig) {
  const prov = config.providers?.["devin-cli"];
  if (!prov || prov.adapter !== "devin-cli" || prov.authMode !== "local") return { config, changed: false, warnings: [] };
  prov.authMode = "oauth";
  return { config, changed: true, warnings: ["rewrote devin-cli authMode local -> oauth: the registry no longer classifies it as local, and the management write boundary fails closed on the mismatch."] };
}
```

Guarded exactly like `projectStaleContextWindows`: exact old value, adapter still
`devin-cli`, nothing else touched. Composed into `projectStartupConfigRepairs`.

**What this migration does NOT do.** It cannot mint a credential.
`projectStartupConfigRepairs` is a synchronous projector persisted through
`mutatePersistedConfig`, which writes `config.json` and never the auth store, and
`getValidAccessTokenSnapshot` reads the auth store. An earlier draft claimed a
boot import would keep existing installs working; the audit disproved it. The
honest upgrade story is therefore:

> After upgrading, an existing `devin-cli` user's first turn returns
> `OAuthLoginRequiredError` until they sign in once — one click in the dashboard
> Accounts tab, or `ocx login devin-cli`. Because login is import-first and the
> CLI is already signed in, that click completes without a browser.

This ships in the release note and in the provider docs. wp4 verifies both the
401-before and the success-after on this machine.

## MODIFY `tests/providers/devin-cli-adapter.test.ts`

```diff
-  test("is a local provider that stores no credential", () => {
+  test("is an account provider whose adapter still holds no credential", () => {
     const entry = PROVIDER_REGISTRY.find((row) => row.id === "devin-cli");
     expect(entry?.adapter).toBe("devin-cli");
-    expect(entry?.authKind).toBe("local");
-    expect(entry?.dashboardPreset).toBe(true);
+    // `oauth` classifies the account, not the request path.
+    expect(entry?.authKind).toBe("oauth");
+    // Off, or the row is drawn twice — Accounts login row plus preset tile.
+    expect(entry?.dashboardPreset).toBe(false);
+    expect(OAUTH_PROVIDERS["devin-cli"]).toBeDefined();
```

New assertion that the runtime posture is unchanged: extend the existing
handshake test so `DEVIN_CLI_SESSION_MARKER` never appears in the child's env or
in anything written to its stdin.

## MODIFY `src/adapters/devin-cli/adapter.ts` (comment only)

Header gains: the dashboard now carries an account row recording that a CLI
session exists; it never produces a credential this adapter reads.

## Acceptance

- `bun test tests/providers/devin-cli-adapter.test.ts tests/providers/devin-cli-login.test.ts` green.
- A config carrying `authMode: "local"` is repaired; proven by a focused test and
  a dry run against the real saved config.
- `listOAuthProviders()` includes `devin-cli`; `deriveProviderPresets()` does not.


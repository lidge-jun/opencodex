# 021 — Phase 2 (revised): oauth classification and the cloud transport

**Supersedes `020`.** The marker, the 401-until-you-click upgrade story, and the
whole reason those existed are gone (`005`).

**Work-phase:** wp3. **Write set:** `src/providers/registry.ts`,
`src/oauth/index.ts`, `src/providers/devin-cli-authmode-migration.ts` (NEW),
`src/providers/model-rename-startup.ts`,
`tests/providers/devin-cli-adapter.test.ts`, NEW migration test.

## MODIFY `src/providers/registry.ts`

```diff
-    // Drives the locally installed Devin CLI. The CLI owns its own credentials
-    // from `devin auth login`, so this provider takes no key and the proxy never
-    // holds one. Inference happens in the child process, which is why the
-    // destination is a stdio scheme rather than a URL.
+    // The signed-in Devin CLI as an account source. The CLI writes a
+    // `devin-session-token$<JWT>` to its own credentials.toml, which is the same
+    // credential RegisterUser hands `ocx login devin` and which the cloud-direct
+    // client already speaks, so this provider imports that token and streams over
+    // Connect-RPC like its browser-login sibling.
+    //
+    // It is NOT a local runtime. Unlike Ollama or LM Studio it cannot answer
+    // without a vendor account, and `local` grouped it with things that have no
+    // account at all. `oauth` is also the only classification that reaches the
+    // dashboard Accounts tab, which is built from OAUTH_PROVIDERS.
     id: "devin-cli",
-    label: "Devin CLI (local)",
-    adapter: "devin-cli",
-    baseUrl: "https://cli.devin.ai",
-    authKind: "local",
+    label: "Devin CLI",
+    adapter: "devin",
+    baseUrl: DEVIN_DEFAULT_API_SERVER,
+    authKind: "oauth",
     featured: false,
-    dashboardPreset: true,
+    // Off, like `devin`. `deriveProviderPresets` keys the preset catalog off this
+    // flag, so leaving it true would draw the row twice: an Accounts login row and
+    // a preset tile.
+    dashboardPreset: false,
+    liveModels: true,
+    modelContextWindows: DEVIN_MODEL_CONTEXT_WINDOWS,
```

`models` / `defaultModel` move from the eleven-entry CLI roster to the cloud
roster, because discovery is now live against the account's own catalog. The
context windows come from `ClientModelConfig` field #18 through the same live
path the `devin` provider uses, so this phase also retires the hand-maintained
`DEVIN_CLI_MODEL_CONTEXT_WINDOWS` table.

### The ACP adapter stays registered, but `devin-cli` can no longer reach it

An earlier draft called this an escape hatch — "set `"adapter": "devin-cli"` in
your row and keep ACP". The audit disproved it. `routedProviderConfig` pins the
adapter from the registry whenever the row's name matches a registry id:

```
// src/router.ts:373-376
const resolved: OcxProviderConfig = { ...provider, adapter: registryEntry.adapter, baseUrl, ...
```

and `providerMatchesRegistryTransport` (`src/providers/registry.ts:3530-3536`)
returns true for anything that is not a `key` destination with
`preserveCustomDestination`, so an oauth row is always pinned. Model discovery
pins the same way (`src/oauth/index.ts:1110-1123`), and `upsertOAuthProvider`
(`:1463-1490`) copies `adapter` from the preset on the first login, so the saved
row is rewritten too.

So the honest statement is: **after this phase the `devin-cli` PRESET is the cloud
transport, and nothing named `devin-cli` runs ACP.** The adapter itself stays
registered and tested, and is reachable from a differently named custom row:

```json
"providers": { "devin-acp": { "adapter": "devin-cli", "baseUrl": "https://cli.devin.ai" } }
```

That is a real capability, not a fig leaf: a custom id is not a registry id, so no
pin applies.

### The migration therefore has to warn, not just rewrite

An operator who deliberately chose ACP would otherwise switch transports silently
on upgrade. `projectDevinCliAuthMode` gains a second, non-mutating job: when the
saved row still carries `adapter: "devin-cli"`, emit a startup warning naming the
change and the exact `devin-acp` snippet above. It does not attempt to rename the
row — a rename would move a provider the user's model ids point at.

## MODIFY `src/oauth/index.ts`

```ts
"devin-cli": {
  login: (ctrl, opts) => loginDevinCli(ctrl, opts),
  refresh: (rt, signal, credential) => refreshDevinCliToken(rt, signal, credential),
  providerConfig: oauthConfig("devin-cli"),
  defaultModel: oauthDefaultModel("devin-cli"),
  // The CLI owns the session and Cognition exposes no refresh endpoint. Same
  // posture as `devin` and `orcarouter-oauth`.
  defaultRefreshPolicy: "disabled",
},
```

Atomic with the registry edit: `oauthConfig("devin-cli")` throws at module load
when `deriveOAuthProviderConfig` returns undefined (`src/oauth/index.ts:204-207`),
which it does unless `authKind` is already `"oauth"` — the filter is at
`src/providers/derive.ts:350-353`, the throw is in `oauthConfig`.

## NEW `src/providers/devin-cli-authmode-migration.ts`

`src/server/auth-cors.ts:731-737` rejects a saved row whose `authMode === "local"`
once the registry entry is not local, and `derive.ts:217-231` seeded exactly that
value while devin-cli was local. Rewrite `local` -> `oauth`, guarded on the exact
old value, composed into `projectStartupConfigRepairs` beside the two migrations
already there.

Unlike `020`, this pass no longer has to apologise for a credential it cannot
mint: the token arrives from the import at login.

It must not repeat the hatch claim either. The migration leaves the saved
`adapter` field in place, but **that field does not choose the transport** for a
registry-named row — routing pins it (`src/router.ts:373-376`). Leaving the value
alone preserves nothing except a signal the warning can detect. An existing ACP
user keeps ACP only by moving to a custom-named row, which is what the warning
tells them to do.

## MODIFY `tests/providers/devin-cli-adapter.test.ts`

```diff
-  test("is a local provider that stores no credential", () => {
+  test("is an account provider sourced from the installed CLI", () => {
     const entry = PROVIDER_REGISTRY.find((row) => row.id === "devin-cli");
-    expect(entry?.adapter).toBe("devin-cli");
-    expect(entry?.authKind).toBe("local");
-    expect(entry?.dashboardPreset).toBe(true);
+    expect(entry?.adapter).toBe("devin");
+    expect(entry?.authKind).toBe("oauth");
+    expect(entry?.dashboardPreset).toBe(false);
+    expect(OAUTH_PROVIDERS["devin-cli"]).toBeDefined();
```

The ACP `describe` blocks stay exactly as they are: that adapter is still
registered and still has to work for anyone who selects it explicitly.

## Acceptance

- `bun test tests/providers/devin-cli-adapter.test.ts tests/providers/devin-cli-login.test.ts` green.
- `listOAuthProviders()` includes `devin-cli`; `deriveProviderPresets()` does not.
- A saved `authMode: "local"` row is repaired, proven by a focused test and a dry
  run against the real config.


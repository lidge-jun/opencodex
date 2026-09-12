# 011 — Phase 1 (revised): import the CLI's credential

**Supersedes `010`.** `005` measured that the Devin CLI stores a real Cognition
key, so this phase is a file import, not an interactive login.

**Work-phase:** wp2. **Write set:** `src/oauth/devin-cli.ts` (NEW), `src/oauth/devin.ts` (export
`identityFromApiKey`, add the `providerId` parameter), `src/adapters/devin.ts`
(consume it), `src/adapters/registry.ts` + `src/server/adapter-resolve.ts` +
`src/server/responses/core.ts` (thread `providerId`),
`tests/providers/devin-cli-login.test.ts` (NEW).

## NEW `src/oauth/devin-cli.ts`

```ts
/**
 * Devin CLI credential import.
 *
 * The installed CLI writes \`$XDG_DATA_HOME/devin/credentials.toml\` after
 * \`devin auth login\`, and the \`windsurf_api_key\` in it is an ordinary
 * \`devin-session-token$<JWT>\` — the same shape RegisterUser returns for
 * \`ocx login devin\`, and the same one the cloud-direct client already speaks.
 * Measured: it mints a user_jwt, opens the 229-model catalog, and streams chat.
 *
 * So this is kiro's import-first login with the same substance: read a signed-in
 * local CLI's own store and adopt the token, rather than starting a browser flow
 * the CLI has already completed.
 */
```

### `devinCliCredentialsPath(env, platform)`

- override `OPENCODEX_DEVIN_CLI_CREDENTIALS` (absolute only)
- Windows `%APPDATA%/devin/credentials.toml`
- otherwise `${XDG_DATA_HOME ?? ~/.local/share}/devin/credentials.toml`

Measured in `004`. Not the config dir.

### `readDevinCliCredentialFile(deps)`

Parses only the two keys it needs, with a minimal line matcher rather than a TOML
dependency — the file is flat and adding a parser for four keys is not worth it:

```
windsurf_api_key = "devin-session-token$..."
api_server_url   = "https://server.codeium.com"
```

Returns `{ apiKey, apiServerUrl }` or `undefined` when the file is absent or
either key is missing. **Never logs either value.**

### `loginDevinCli(ctrl, opts, deps)`

1. file missing or unparseable -> throw, message naming
   `DEVIN_CLI_INSTALL_HINT` plus "run `devin auth login`, then press Login again".
   No browser is ever opened: there is nothing for opencodex to authorize.
2. `resolveDevinApiBaseUrl(apiServerUrl)` — reuse
   `src/oauth/devin/api-base.ts` verbatim. The host comes off disk and then
   receives the key, so it passes the same allowlist as the RegisterUser host.
   An unallowlisted value falls back to the default rather than exfiltrating.
3. Return the credential, reusing the newly exported `identityFromApiKey` from
   `src/oauth/devin.ts` so an email or sub in the JWT becomes the account identity:

```ts
{
  access: apiKey,
  refresh: apiKey,          // durable-key pattern; "" trips detectOAuthWarning
  expires: Number.MAX_SAFE_INTEGER,
  source: "local-cli",
  apiBaseUrl: resolvedHost,
  ...identityFromApiKey(apiKey),
}
```

`ctrl.onProgress?.("Imported the signed-in Devin CLI session.")`; `onAuth` is
never called, which is the shape `startLoginFlow` already handles for local
imports.

### MODIFY `src/oauth/devin.ts` — make host resolution provider-aware

The import stores `apiBaseUrl`, but nothing reads it. `createDevinAdapter` calls
`resolveDevinApiServer(provider.baseUrl)` (`src/adapters/devin.ts:219`), and that
helper is hard-coded to one credential:

```ts
// src/oauth/devin.ts:26-31 — today
export function resolveDevinApiServer(configuredBaseUrl?: string): string {
  return (
    validateDevinApiBaseUrl(getCredential("devin")?.apiBaseUrl) ??
    validateDevinApiBaseUrl(configuredBaseUrl) ??
    DEVIN_DEFAULT_API_SERVER
  );
}
```

Left alone, a `devin-cli`-only user is pinned to the default host regardless of
what their CLI recorded, and a user signed into both providers would send the CLI
key to whatever tenant the browser-login `devin` credential named — an EU or
FedStart account crossed with a US one. Two accounts, one host.

```diff
-export function resolveDevinApiServer(configuredBaseUrl?: string): string {
+export function resolveDevinApiServer(configuredBaseUrl?: string, providerId = "devin"): string {
   return (
-    validateDevinApiBaseUrl(getCredential("devin")?.apiBaseUrl) ??
+    validateDevinApiBaseUrl(getCredential(providerId)?.apiBaseUrl) ??
     validateDevinApiBaseUrl(configuredBaseUrl) ??
     DEVIN_DEFAULT_API_SERVER
   );
 }
```

### The adapter has no provider id today — this is the plumbing

An earlier draft said "the adapter passes the provider it was built for" without
checking that it can. It cannot: `createDevinAdapter` receives only
`OcxProviderConfig`, which has no id, and after the flip both `devin` and
`devin-cli` share `adapter: "devin"`, so the factory cannot infer the store key.
The audit was right that the edit was unimplementable as written.

The name IS available at the call sites — `route.providerName` at
`src/server/responses/core.ts:1436` and `:4171` — so it only has to be threaded:

```diff
 // src/adapters/registry.ts
 export interface AdapterFactoryContext {
   cacheRetention?: AdapterCacheRetention;
+  /**
+   * The configured provider row this adapter serves. Needed when one adapter
+   * backs two provider ids whose credentials differ — `devin` and `devin-cli`
+   * share a transport and a token format but sign in to different accounts and
+   * can sit on different tenants.
+   */
+  providerId?: string;
 }
```

```diff
 // src/server/adapter-resolve.ts
-export function resolveAdapter(providerConfig: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
-  return createRegisteredAdapter(providerConfig, { cacheRetention });
+export function resolveAdapter(
+  providerConfig: OcxProviderConfig,
+  cacheRetention?: "none" | "short" | "long",
+  providerId?: string,
+) {
+  return createRegisteredAdapter(providerConfig, { cacheRetention, ...(providerId ? { providerId } : {}) });
 }
```

Both `core.ts` call sites pass `route.providerName`. The parameter is optional and
every other adapter ignores it, so no existing behaviour moves. This touches
`core.ts` but does not make it reach `src/lab/`, which is the boundary `000` set.

`createDevinAdapter(provider, context)` then resolves with
`context.providerId ?? "devin"`, preserving today's behaviour for any caller that
does not supply one.

One easily-missed hop, flagged by the final audit: the registry factory currently
drops the context on the floor, so the field would arrive nowhere.

```diff
 // src/adapters/registry.ts
   devin: {
     wire: "devin",
     mutation: "codex-owned",
-    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createDevinAdapter(provider),
+    create: (provider: OcxProviderConfig, context: AdapterFactoryContext) => createDevinAdapter(provider, context),
   },
```

`createRegisteredAdapter` already forwards `context` to `definition.create`, so
this one line is the whole remaining gap. Test 9 fails without it, which is the
point of routing that test through the factory.

`identityFromApiKey` is likewise private at `src/oauth/devin.ts:45`; export it
rather than copying the JWT decode into a second file.

### `refreshDevinCliToken()`

Throws `invalid_grant: the Devin CLI owns this session. Run devin auth login again.`
Same posture as `refreshDevinToken`.

### What is deleted relative to `010`

`DEVIN_CLI_SESSION_MARKER`, `spawnInteractive`, `DevinCliLoginChild`, the PKCE
URL scraper, and the deadline path. None of them has a reason to exist once the
credential is readable.

## NEW `tests/providers/devin-cli-login.test.ts`

Registered in `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json` under `providers`.

1. file absent -> throws, message carries the install hint
2. file present -> credential is `access === refresh === <key>`,
   `expires === Number.MAX_SAFE_INTEGER`, `source === "local-cli"`
3. identity: a key whose JWT carries an email surfaces it; one without does not
   invent one
4. `api_server_url` pointing at a non-Cognition host -> falls back to
   `DEVIN_DEFAULT_API_SERVER`, and the off-allowlist host never reaches the
   credential
5. malformed file (missing `windsurf_api_key`) -> throws rather than returning a
   half credential
6. neither the key nor the host appears in anything passed to `onProgress`
7. `refreshDevinCliToken` rejects with `invalid_grant`
8. `resolveDevinApiServer(undefined, "devin-cli")` returns the host stored on the
   devin-cli credential and does NOT read the `devin` credential
9. **through the adapter, not only the helper**: build the adapter with
   `createRegisteredAdapter(devinRow, { providerId: "devin-cli" })` while a
   `devin` credential names a different allowlisted tenant, and assert the RPC
   host is the CLI one. A green helper test alone would not have caught the
   crossed-tenant bug, which is exactly what the audit said

## Acceptance

- No import from `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`.
- `bun test tests/providers/devin-cli-login.test.ts` green.
- A live import against this machine's signed-in CLI yields a credential that
  streams a real turn — the `CLIKEY-OK` probe in `005`, repeated through the
  module rather than through a scratch script.


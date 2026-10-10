# wp9 — #1221 opt-in OS keychain storage for provider API keys (slice 1)

Issue #1221 (score 61). Investigation by grok subagent (Kierkegaard); see 091. Findings that bound
the design: `resolveEnvValue(x.apiKey)` is called at 24 sync sites (router, quota ×15, compact ×2,
catalog, sidecar ×2, images, lab, oauth/index) and adapters read `provider.apiKey` from the routed
clone; `@napi-rs/keyring` ships a sync `Entry` so the request path stays sync; save/backup paths
are plaintext-free automatically once `apiKey` on disk is a reference; `key-failover` and
`addProviderApiKey` write `candidate.key` back — with references in the pool that stays a
reference.

## Design

- Reference syntax: `apiKey: "keychain:<provider>"` (pool entries: `keychain:<provider>/<id>`).
  Keyring service `opencodex.provider-api-key.v1`, account = the part after `keychain:`.
- `src/providers/key-store.ts` (new): `isKeychainReference`, `resolveProviderApiKey(value)` (env
  ref → env; keychain ref → sync `Entry.getPassword()` with a process cache; failure → `undefined`
  + one warning per account, never plaintext fallback), `storeProviderKeyInKeychain` /
  `restoreProviderKeyFromKeychain` (async, write then read-back verify; refuse when unavailable),
  `clearKeychainCacheForTests`. Entry factory injectable.
- Funnel: every `resolveEnvValue(<x>.apiKey)` site → `resolveProviderApiKey`; `maskApiKey`
  returns keychain refs verbatim (non-secret) like env refs.
- Management: `POST /api/providers/keychain` body `{ name, action: "store" | "restore" }` and
  `GET /api/providers/keychain?name=` → `{ store: "keychain" | "file" | "env", available }`.
  `store`: moves the active key and every plaintext pool entry into the keychain, rewrites
  config with references, verifies read-back first (keychain unavailable → 503, config untouched).
  `restore`: reads back, writes plaintext, deletes the keychain items.
- CLI: `ocx provider keychain <name> [store|restore|status] [--json]`.
- Docs: providers.md "Storing keys in the OS keychain" + note on services/headless sessions.

## Out of slice
Dashboard control, global default, DPAPI-specific handling beyond what napi provides, per-request
async resolution.

## Acceptance
- Plain/env keys: identical behavior (existing tests untouched).
- `keychain:` ref resolves through a mock Entry at routing (`routedProviderConfig`), quota, compact.
- Unavailable keyring at request time → key undefined, one warning, no plaintext written.
- store: config rewritten to refs, pool refs, read-back verified; restore reverses; failure leaves config.
- `maskApiKey("keychain:x")` verbatim; `hasApiKey` true.
- tsc, privacy, focused tests: new `tests/provider-key-store.test.ts`, `tests/provider-api-keys.test.ts` (if exists), `tests/router*.test.ts` sanity.


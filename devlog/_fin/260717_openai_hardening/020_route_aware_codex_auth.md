# Cycle 020 — Atomic Three-tier Activation and Route-aware Auth

## Objective

Activate Direct, Multi, and API in one cycle together with all auth, migration,
catalog, management, HTTP, WebSocket, compact, and legacy-`chatgpt` boundaries. The
cycle may not close with any public tier still using route-blind auth.

## Registry, derivation, and routing

### MODIFY `src/providers/registry.ts`

- Add `codexAccountMode?: CodexAccountMode` to `ProviderRegistryEntry` only.
  `ProviderConfigSeed` remains a persisted-config shape and must not contain mode.
- `openai`: label `Codex Direct`, canonical forward transport, mode `direct`, featured.
- NEW adjacent row `openai-multi`: label `Codex Multi-account`, same transport,
  mode `pool`, featured, note “main + added accounts”.
- Rename `openai-apikey` label to `OpenAI API`; id/auth stay compatible.
- Reuse existing `getProviderRegistryEntry(id)` and add only
  `providerCodexAccountMode(id)` as the runtime mode lookup. Delete
  `builtInCodexAccountMode` from
  `src/providers/openai-tiers.ts` and its foundation assertions; no second id→mode map
  remains outside registry metadata.

### MODIFY `src/providers/derive.ts`

Derive preset/init display metadata directly from `ProviderRegistryEntry`, including
account mode, without cloning mode into `OcxProviderConfig` or `ProviderConfigSeed`.
Replace the blanket forward init label with registry labels. Safe public DTOs may
derive mode from the registry; persisted provider rows never contain it.

### MODIFY `src/router.ts`

- Extend `RouteResult` with top-level
  `codexAccountMode?: CodexAccountMode`; `routedProviderConfig` never writes mode into
  the provider config object.
- Before any configured namespace lookup, reject namespace `chatgpt` with the normal
  unknown-provider error, even when a legacy configured row exists.
- Then resolve enabled configured namespaces and attach registry-owned runtime mode.
- Before the generic configured-provider `defaultModel` loop, recognize a bare
  OpenAI-family model and try fixed enabled tier order `openai`, `openai-multi`,
  `openai-apikey`. This prevents `openai-apikey.defaultModel=gpt-5.5` or object
  insertion order from capturing a bare OpenAI id while Direct is enabled.
- The later generic `defaultModel` loop skips all three OpenAI tiers for a bare
  OpenAI-family request. Existing known-pattern, configured-model, and default-provider
  branches then retain their current relative order.
- The bare OpenAI-family branch is terminal. If no enabled fixed tier exists, throw
  `NoEnabledOpenAiTierError`; never fall through to generic defaults, known patterns,
  configured models, disabled rows, or arbitrary `openai-*` prefixes.
- Exclude legacy `chatgpt` from `activeProviderEntries`, known patterns, generic
  defaults, and configured-model candidates.
- The final `defaultProvider` branch explicitly rejects `chatgpt` before lookup, so a
  reinserted legacy row cannot route even when configured as the default.

## Migration and legacy `chatgpt`

### MODIFY `src/config.ts`

- Add schema support for marker 1.
- Add `backupConfigBeforeOpenAiTierMigration()` which is a no-op when the original
  config file does not exist. Otherwise it writes bytes to a sibling temporary file,
  applies POSIX mode 0600 or existing `hardenSecretPath` Windows ACL handling, and
  atomically publishes `<configPath>.pre-openai-tiers-v1.bak` without overwriting an
  existing backup.
- Give the backup helper an injected IO seam covering read, exclusive temp creation,
  write, chmod/ACL, atomic publication, truncate, and unlink. The production
  `publishNoReplace(temp, backup)` implementation uses a same-directory hard link
  (`link(temp, backup)`), which atomically fails with `EEXIST` instead of replacing a
  destination; it then unlinks the temp. A prior destination-existence check is only
  an optimization and never the no-replace guarantee.
- The helper tracks `published = false`. Before publication, a failure may scrub the
  temp to zero bytes and retry unlink because no backup hard link exists. After
  `publishNoReplace` succeeds it sets `published = true`; from that point it never
  truncates the temp while the backup link exists because both paths share one inode.
- Post-publication cleanup first retries temp unlink directly. On permanent temp-unlink
  failure it attempts to unlink the newly published backup link (rollback). Only after
  rollback succeeds may it truncate/remove the remaining temp, and startup still
  aborts with `OpenAiTierBackupCleanupError` without saving the migration. If backup
  rollback also fails, it preserves both hardened links and their complete original
  bytes and aborts with `OpenAiTierBackupRollbackError`; it never continues migration
  or truncates either path. It never delegates secret-temp ownership implicitly to the
  normal config writer.
- If both scrub mechanisms (`truncate`, then empty overwrite) and both unlink attempts
  are denied before publication or after successful rollback, deletion is physically
  impossible. Abort with `OpenAiTierBackupSecretResidualError(tempPath)` and report the
  secret-bearing path honestly; never mislabel it as a zero-byte residual and never save
  the migration.
- If the backup path already exists, compare its bytes with the current original.
  Identical bytes are a reusable downgrade snapshot, including retry after a previous
  migration save failure. Different bytes throw `OpenAiTierBackupCollisionError`
  before save. If `publishNoReplace` races and returns `EEXIST`, reread the winner and
  apply the same byte-equality rule; never overwrite either winner.
- Lock the deterministic seam:

```ts
interface OpenAiTierBackupIO {
  exists(path: string): boolean;
  read(path: string): Uint8Array;
  createExclusive(path: string): void;
  write(path: string, bytes: Uint8Array): void;
  harden(path: string): void;
  publishNoReplace(temp: string, backup: string): void;
  truncate(path: string): void;
  unlink(path: string): void;
}
backupConfigBeforeOpenAiTierMigration(
  configPath?: string,
  io?: OpenAiTierBackupIO,
): "absent" | "created" | "reused";
```

  Production methods wrap the current fs/ACL helpers. Every read/create/write/harden/
  publish/truncate/unlink failure and `EEXIST` race is injected through this interface;
  the helper body performs no direct filesystem call outside the default IO object.
- Harden `atomicWriteFile` with the injected scrub/retry/typed-residual state machine
  specified below. The original file remains intact and residual temp never retains
  secret bytes.

### MODIFY `src/server/index.ts::startServer`

Immediately after `loadConfig()` and before `applyProxyEnv()`:

1. run `projectOpenAiTierMigration`;
2. when changed, create the one-time backup then `saveConfig(projected.config)`;
3. continue startup with the projected config;
4. remove the existing unconditional `upsertOAuthProvider(config, "chatgpt")` block.

Save failure aborts startup. The atomic writer leaves the original config intact;
the backup is the explicit downgrade path. Restoring the backup is documented in 050.
If `projectOpenAiTierMigration` throws `OpenAiTierMigrationCollisionError`, startup
fails before backup creation or `saveConfig`, reports the reserved-id collision without
printing provider contents/credentials, and leaves the original config byte-identical.
Cycle 020 moves invariant checks before the marker-1 early return. A noncanonical
`openai-multi` always throws. Any reinserted own `chatgpt` row is removed again, a
`chatgpt` default is mapped by pool intent, and the repair is persisted. Marker 1 is
therefore idempotent only while these invariants remain true.
Canonical Multi validation fixes adapter/base/auth to the registry seed while allowing
only managed operational overlays `disabled?: boolean` and
`selectedModels?: string[]`. These fields survive restart and do not count as a
reserved-id collision; every other extra field remains fail-closed. Tests cover marker-1
restarts with disabled and selected Multi.
When `legacyPoolIntent` is true and the persisted `defaultProvider` is `openai`, the
projection explicitly changes it to `openai-multi`; without pool intent it stays
Direct. A fresh install has no original file to back up and still persists normally.
`OpenAiTierMigrationCollisionError` aborts before backup or save.

### NEW `src/providers/openai-tier-startup.ts`

Export:

```ts
interface OpenAiTierStartupDeps {
  project: typeof projectOpenAiTierMigration;
  backup: () => void;
  save: (config: OcxConfig) => void;
}
runOpenAiTierStartupMigration(config: OcxConfig, deps?: OpenAiTierStartupDeps): OcxConfig;
```

Call order is project → backup → save only when changed. Return the projected clone,
or the unchanged clone when marker 1 exists; `startServer` continues exclusively with
this returned config, never the originally loaded object.
Projection collision performs neither backup nor save; backup failure performs no save;
save failure propagates. `startServer` calls this coordinator before proxy env setup.

### MODIFY `src/config.ts::atomicWriteFile`

Add an injected IO seam for write, harden, rename, truncate, and unlink. On a failed
prepublication stage, scrub temp with truncate and then an empty overwrite fallback,
and retry unlink once. If scrub succeeds but unlink remains impossible, preserve the
zero-byte temp and throw `AtomicWriteResidualTempError`. If both scrub methods and both
unlink attempts are denied, throw `AtomicWriteSecretResidualError(tempPath)` so the
secret-bearing path is reported honestly; never claim impossible deletion or a false
zero-byte state. Every outcome preserves the original destination and aborts startup.

### MODIFY `src/oauth/index.ts`

Retain `OAUTH_PROVIDERS.chatgpt` and `runLogin("chatgpt")` as legacy credential
compatibility, but:

- `listOAuthProviders()` filters out `chatgpt` from GUI/public provider discovery;
- `runLogin` saves the credential but skips `upsertOAuthProvider` for `chatgpt`;
- `upsertOAuthProvider` refuses `chatgpt` so no future caller recreates a fourth tier.

Add `isPublicOAuthProvider(id)` which excludes `chatgpt` while the lower-level internal
credential/login implementation still recognizes it. Every generic management OAuth
endpoint uses the public predicate.

### MODIFY `src/oauth/login-cli.ts`

User-facing login enumeration/help and generic login dispatch use public OAuth ids only.
`chatgpt` is not addressable from generic CLI OAuth surfaces.

### MODIFY `src/codex/auth-api.ts`

The dedicated `/api/codex-auth/login` path continues calling the lower-level internal
ChatGPT login implementation and never creates a provider row.

Credential records are not deleted or copied. Direct uses caller Codex headers;
Multi uses the Codex account store. The legacy OAuth record remains recoverable by
older CLI flows without becoming a route/card.

## Route-aware auth and transports

### MODIFY `src/codex/auth-context.ts`

`resolveCodexAuthContext(headers, config, mode)` requires mode. `direct` validates a
nonblank caller `Authorization: Bearer ...` and only then returns main before any
affinity/quota/cooldown/token code. Missing or malformed Direct credentials throw
`CodexDirectAuthenticationError` (local 401, zero upstream). `pool` runs existing
selection unchanged, including `MAIN_CODEX_ACCOUNT_ID` as `main-pool`.
`applyCodexAuthContextToProvider` requires both provider mode `pool` and a pool
context before injecting runtime credentials.

Pool mode never returns `kind:"main"`. No selected candidate, an empty pool without a
usable main token, or disappearance of the selected-main token throws typed
`CodexPoolAuthenticationError` (401) before network and never relays caller auth.

### MODIFY `src/codex/routing.ts`

- With no `activeCodexAccountId`, select through `getEligiblePoolAccounts`: main plus
  every usable added account. Main-only selects main; main+added uses existing quota
  scoring and deterministic tie order, then persists the selected active candidate.
- `bindThreadAffinity` accepts `MAIN_CODEX_ACCOUNT_ID` with generation sentinel 0 and
  checks main-account usability instead of requiring an account-store record. A main
  selection is sticky for the same thread and still participates in quota/failure
  re-evaluation.
- Missing main credentials remove main from eligibility. Multi selects a usable added
  account or throws typed pool 401; it never degrades to caller-header Direct.

### MODIFY `src/server/auth-cors.ts` and `src/adapters/openai-responses.ts`

Separate proxy admission from provider auth. For `/v1/responses`, compact, and WS
frames, proxy admission consumes only dedicated `X-OpenCodex-API-Key`; it never treats
caller `Authorization` as the proxy key. Preserve that header until `routeModel`.
After routing, only Direct calls
`validateDirectCodexCredential(headers): void`, which requires a nonblank Bearer and
throws `CodexDirectAuthenticationError` before fetch. Multi resolves account-store
credentials and API-key routes require no Codex bearer/account header.

Management and Anthropic-compatible surfaces retain their existing admission spellings
where they do not collide with forwarded Codex auth. Standalone search/images resolve
the candidate first: Direct validates caller bearer, Multi resolves pool auth, keyed API
uses its API key. Internal web-search/vision inherit the already route-owned selection.
Tests use a dedicated proxy key plus a distinct Direct bearer and prove neither secret
is confused or logged.

### MODIFY `src/server/responses.ts`

- After `routeModel`, resolve Codex auth only for forward Responses providers with
  `route.codexAccountMode`. API/OAuth routes never call pool resolution.
- Replace incoming `authContext`/`selectedForwardHeaders` options with
  `onCodexAuthContextResolved` for WS registry observation.
- Exact callback type is
  `onCodexAuthContextResolved?: (ctx: CodexAuthContext | undefined) => void`.
  Invoke it with `undefined` at the start of every WS frame before parse/route/auth,
  then with the resolved context on success. Any route or auth failure therefore keeps
  account tracking cleared.
- Gate pool outcome recorders on provider mode `pool` plus pool/main-pool context.
- Direct logs provider `openai`; Multi uses privacy-safe account suffixes.
- `handleResponsesCompact` uses the same mode and removes the broad pool-error catch
  that falls back to raw headers. Cooldown=429, expired affinity=409, reauth=401.

### MODIFY `src/server/index.ts`

- WS upgrade stores only selected inbound forward headers; it resolves no account.
- Each response frame enters `handleResponses`, which routes first and reports the
  resolved auth context via callback to `updateCodexWebSocketAuthContext`.
- A Direct/API frame clears previous pool tracking; Multi adds current tracking.
- A failed Multi frame remains cleared (`pool → failed Multi → undefined`) and cannot
  leave the socket registered against the previous account.
- Startup quota prime runs only with enabled configured `openai-multi`.

### MODIFY `src/codex/websocket-registry.ts`

Keep existing map; cover transitions undefined→pool, pool→main/undefined, pool-a→pool-b.

### MODIFY `src/providers/quota.ts`

Codex-account quota labels/cache keys attach to Multi only. API-key quota remains
provider-key-owned; Direct never receives an active pool suffix.

### MODIFY `src/codex/catalog.ts`

`gatherRoutedModels` appends `projectNativeModelsForOpenAiMulti` only for configured,
enabled canonical Multi. Direct stays bare native; API metadata never feeds Multi.

## Management admission

### MODIFY `src/server/auth-cors.ts::providerManagementConfigError`

Before any strip/sanitize step, inspect raw own-properties. Globally reject only these
exact runtime-only fields: `codexAccountMode`, `virtualModels`, `codexAuthContext`,
`selectedForwardHeaders`, `sidecarOutcomeRecorder`, `_codexAccountOverride`, and
`_codexAccountRequired`. Validate the raw object before
`stripCodexRuntimeProviderFields`. For reserved
`openai`/`openai-multi`, reject every own key outside the canonical
seed, including headers/capability extras. Admit forward mode only when name is `openai` or
`openai-multi` and every submitted provider field equals the full trusted registry
seed. Reject `chatgpt`, partial rows, extra fields, and custom bases.

Change the validation boundary to accept raw input before narrowing:

```ts
providerManagementConfigError(name: unknown, provider: unknown): string | undefined
```

It first requires a plain-record provider and inspects raw own-properties, then
narrows to `OcxProviderConfig`. Full canonical-seed equality applies only to reserved
forward tiers `openai` and `openai-multi`; existing `openai-apikey` and custom-provider
admission rules remain unchanged, including supported capability metadata and safe
headers. Sensitive custom headers continue returning 400.

## Central sidecar ownership (moved from Cycle 040)

### NEW `src/providers/openai-sidecar.ts`

Export:

```ts
interface OpenAiForwardSidecarCandidate {
  providerName: "openai" | "openai-multi";
  provider: OcxProviderConfig;
  accountMode: CodexAccountMode;
}
interface ResolvedOpenAiForwardSidecar extends OpenAiForwardSidecarCandidate {
  authContext: CodexAuthContext;
  headers: Headers;
  recordOutcome?: (outcome: CodexUpstreamOutcome) => void;
}
interface OpenAiImagesProviderSelection {
  forwardCandidates: OpenAiForwardSidecarCandidate[];
  keyed?: {
    providerName: "openai-apikey";
    provider: OcxProviderConfig;
    apiKey: string;
  };
}
listOpenAiForwardSidecarCandidates(config: OcxConfig): OpenAiForwardSidecarCandidate[];
resolveFirstUsableOpenAiSidecar(
  candidates: readonly OpenAiForwardSidecarCandidate[],
  incomingHeaders: Headers,
  config: OcxConfig,
): Promise<ResolvedOpenAiForwardSidecar | undefined>;
selectOpenAiImagesProvider(config: OcxConfig): OpenAiImagesProviderSelection;
```

`undefined` means only no configured candidate, or Direct-only with missing caller auth.
If Direct is skipped and configured Multi resolution throws
`CodexPoolAuthenticationError`, propagate it as typed 401; never convert it to
`undefined`. Candidate order is Direct then Multi. Missing Direct upstream auth skips
before network to Multi; an actual Direct upstream 401 is final and never retries Multi.
Each selection owns dedicated headers, auth context, and outcome recorder.
`listOpenAiForwardSidecarCandidates` includes only enabled rows whose Direct/Multi
transport passes `isCanonicalOpenAiForwardProvider`. `selectOpenAiImagesProvider`
returns `keyed` only for the enabled trusted registry-owned API transport after
`resolveEnvValue` produces a nonempty API key; callers never re-resolve it.

### MODIFY `src/server/search.ts`, `src/server/images.ts`,
`src/web-search/index.ts`, `src/vision/index.ts`, and `src/server/responses.ts`

Replace all local forward scans and route-blind auth calls. Standalone and internal
sidecars use the central selector and never reuse a main route's auth for another tier.
Keyed API remains images-only; hosted search/vision uses forward candidates only.
All five callers import these shared result types; source/tests assert no local
`findForwardProvider` or equivalent config-order scan remains.

Change synchronous planner contracts to consume an already resolved shared selection:

```ts
planWebSearch(
  config: OcxConfig,
  parsed: OcxParsedRequest,
  isPassthrough: boolean,
  provider: OcxProviderConfig,
  modelId: string,
  openAiSidecar?: ResolvedOpenAiForwardSidecar,
): SidecarPlan | undefined;
planVisionSidecar(
  config: OcxConfig,
  provider: OcxProviderConfig,
  modelId: string,
  parsed: OcxParsedRequest,
  openAiSidecar?: ResolvedOpenAiForwardSidecar,
): VisionPlan | undefined;
```

`SidecarPlan`/`VisionPlan` replace `forwardProvider` with `forwardSidecar` of the shared
resolved type. They never accept raw incoming headers/auth context and never scan config
for a forward provider. `responses.ts` checks activation/backend first, resolves the
OpenAI sidecar lazily only for the OpenAI backend, then passes the result. Anthropic
planning retains its stored-OAuth owner.

### MODIFY `src/server/management-api.ts`

Keep the existing POST body contract `{ name, provider }`. Only when `name` is the
reserved forward tier `openai` or `openai-multi`, require `provider` to equal the full
immutable canonical config seed field-by-field before persistence. API-key and custom
providers continue through their existing admission rules. Do not strip forbidden
fields before validation and never persist mode. Safe DTO derives account mode and
note from registry metadata and exposes neither credentials nor virtual maps. The
existing modal continues submitting the full seed.

## Tests and activation proof

- MODIFY `tests/provider-registry-parity.test.ts`: three ids/presets/init labels.
- MODIFY `tests/router.test.ts`: reverse insertion order; configured
  `openai-apikey.defaultModel=gpt-5.5`; explicit namespace selects Multi/API;
  `chatgpt/<model>` is rejected even when a configured legacy row exists. Bare matrix:
  Direct enabled → Direct; Direct disabled + Multi enabled → Multi; Direct/Multi
  disabled + API enabled → API; all fixed tiers absent/disabled →
  `NoEnabledOpenAiTierError`; arbitrary `openai-*` and disabled rows never capture.
  Also prove a configured `defaultProvider: "chatgpt"` is rejected by the final branch;
  marker-1 projection strips a reinserted row and rejects noncanonical Multi.
  Marker-1 disabled/selected canonical Multi survives projection and restart.
- MODIFY `tests/server-auth.test.ts`: canonical Multi POST=200; forged base/mode/map/
  headers/capabilities and `chatgpt` POST=400; each forbidden raw own-property=400;
  existing API-key/custom POSTs remain green; safe DTO.
- MODIFY `tests/openai-provider-tier-migration.test.ts`: startup call site, absent-file
  fresh-install backup no-op, atomic backup, POSIX mode, injected Windows ACL hardener,
  injected read/create/write/harden/publish failures; destination created between
  inspection and `publishNoReplace`; pre-publication cleanup failures; transient
  post-publication temp-unlink failure followed by direct retry; permanent temp-unlink
  failure followed by successful backup-link rollback then temp scrub; and permanent
  backup-link rollback failure. Assert no post-publication truncate occurs while the
  backup link exists. In the final branch both paths retain complete original bytes,
  startup aborts, and migration save is never called. Assert every branch's exact
  cleanup attempt, original preservation, and pre-existing-backup bytes;
  noncanonical preexisting `openai-multi` collision aborts before backup/save, redacts
  the row, and preserves the original config bytes;
  identical existing backup is reused after simulated save failure; differing backup
  and differing `EEXIST` race winner throw typed collision; identical race winner is
  reused; no branch overwrites destination bytes;
  two restarts, save-failure original preservation, explicit legacy `openai` default
  to Multi, order, and credential checks.
- NEW `tests/openai-tier-startup.test.ts`: returned projected config becomes runtime
  config; collision → zero backup/save; every backup
  failure → zero save; save failure propagation; exact project/backup/save order;
  atomic writer write/harden/rename/truncate/unlink failures preserve original and
  yield removed temp, typed zero-byte residual, or an honest typed secret-residual path
  only when the injected IO denies both scrubbing and deletion.
- MODIFY `tests/codex-auth-context.test.ts`: Direct pool spies remain untouched;
  Multi selects main/added and errors honestly; API makes zero pool calls.
- MODIFY `tests/codex-main-rotation.test.ts`: main eligibility and outcome rotation.
- MODIFY `tests/codex-routing.test.ts`: main-only/no-active selects and binds main;
  main+added/no-active scores all candidates; repeated main thread remains sticky;
  missing main token selects an added account or fails honestly.
- MODIFY `tests/codex-websocket-registry.test.ts`: sequential Direct→Multi→Direct and
  pool-a→pool-b frames plus pool→failed-Multi→undefined cleanup.
- MODIFY `tests/server-auth.test.ts`: HTTP/compact plus a real WebSocket connection that
  sends Direct→Multi→API→Direct and pool-a→pool-b frames; assert per-frame URL/headers,
  pool-call counts, registry tracking/clearing, handshake-time zero pool resolution;
  empty pool and selected-main token disappearance return 401 with zero upstream.
- Add HTTP/WS/compact matrix: missing Direct Authorization returns local 401 with zero
  fetch; Multi and API succeed without caller Authorization using their own credential
  owners; dedicated proxy-key admission does not consume the Direct bearer.
- MODIFY `tests/server-search.test.ts`, `tests/server-images.test.ts`,
  `tests/web-search-anthropic.test.ts`, `tests/vision-anthropic.test.ts`, and
  `tests/sidecar-abort.test.ts`: insertion-order permutations, endpoint/auth/account,
  outcome owner, missing-Direct-auth pre-network Multi skip, Direct 401 no retry.
- MODIFY `tests/web-search.test.ts`, `tests/web-search-timeout-plan.test.ts`,
  `tests/claude-sidecar-override.test.ts`,
  `tests/e2e-style/phase100-native-parity.test.ts`, and `tests/vision-cache.test.ts`:
  direct planner consumers pass deterministic resolved-sidecar fixtures (or undefined)
  under the exact new signatures; no stale raw header/auth-context constructor remains.
- Direct missing auth + empty Multi propagates typed 401; Direct-only missing auth
  returns `undefined`; timeout/connect_error outcomes target the selected Multi account.
- Cover disabled/noncanonical Direct, disabled/noncanonical Multi, absent/unresolved API
  key, and environment-resolved nonempty API key eligibility.
- Add HTTP/WS/compact/search/images admission-secret tests: bearer admission only makes
  zero forward requests and leaks no secret; proxy-key header plus distinct Codex bearer
  forwards only the Codex bearer.
- Add OAuth public-surface tests: discovery, generic login/code/status/logout/accounts,
  CLI help, presets, config, routing omit `chatgpt`; dedicated Codex-auth login remains.
- MODIFY `tests/codex-quota-prime.test.ts`: Direct/API/disabled Multi no prime;
  enabled Multi one prime.
- MODIFY `tests/provider-quota.test.ts`: Direct/API produce no Codex quota report or
  active-account cache dependency; enabled Multi is the sole WHAM/account-cache owner.
- MODIFY `tests/codex-catalog.test.ts`: configured Multi projection activated.
- NEW `tests/oauth-public-surface.test.ts`; MODIFY `tests/chatgpt-oauth.test.ts`,
  `tests/oauth-login-summary.test.ts`, and `tests/server-auth.test.ts`: generic discovery,
  login/code/status/logout/accounts and CLI help omit/reject `chatgpt`; dedicated
  `/api/codex-auth/login` reaches internal login without creating a provider row.

## Verification and exit gate

```sh
bun test tests/openai-provider-tiers.test.ts tests/openai-provider-tier-migration.test.ts tests/openai-tier-startup.test.ts tests/provider-registry-parity.test.ts tests/router.test.ts tests/codex-catalog.test.ts tests/codex-auth-context.test.ts tests/codex-routing.test.ts tests/codex-main-rotation.test.ts tests/codex-websocket-registry.test.ts tests/codex-quota-prime.test.ts tests/provider-quota.test.ts tests/server-auth.test.ts tests/server-search.test.ts tests/server-images.test.ts tests/web-search-anthropic.test.ts tests/vision-anthropic.test.ts tests/sidecar-abort.test.ts tests/web-search.test.ts tests/web-search-timeout-plan.test.ts tests/claude-sidecar-override.test.ts tests/e2e-style/phase100-native-parity.test.ts tests/vision-cache.test.ts tests/oauth-public-surface.test.ts tests/chatgpt-oauth.test.ts tests/oauth-login-summary.test.ts
bun x tsc --noEmit
```

After the cycle, test snapshots and one local mock smoke must prove: exactly three
public tiers; Direct never touches pool state; Multi includes main and added accounts;
API uses key auth; no configured/public/routable `chatgpt` remains.

## Terminal closeout

`done` — landed in `3a9e498f` with audit closure in `005cbb8d`; final cross-tier proof and
terminal criteria are indexed in [`050_integration_verification.md`](./050_integration_verification.md),
[`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), and the `051` audit.

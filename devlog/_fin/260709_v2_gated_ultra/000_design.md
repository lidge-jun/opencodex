# 050 — opencodex v2-gated ultra + toggle surface (wp5)

## Decision (user-confirmed, 260709)

| model class | v2 on | v2 off |
|---|---|---|
| max-native (anthropic/*, gpt-5.6 family) | max + ultra | max only (ultra stripped, incl. native ultra on 5.6-sol/terra) |
| mock-max (gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex-spark, routed models) | ultra only | neither (ladder ends at xhigh/high) |

Mock max is NEVER visible in the picker regardless of v2 (current shipped ocx
behavior already never invents a visible max: `applyReasoningLevels` appends max
only when the provider advertises it; `ensureUltraReasoningLevel` deliberately
appends ultra alone — wire clamps ultra->max->highest native). This phase adds
the v2 gate; it does not add any max emission.

## Repo: /Users/jun/Developer/new/700_projects/opencodex

### NEW src/codex/features.ts

- `isMultiAgentV2Enabled(codexHome?: string): boolean` — resolve home via the
  existing helper in `src/codex/paths.ts` (respect `CODEX_HOME`), read
  `config.toml` as text, detect BOTH forms:
  `[features.multi_agent_v2]` table with `enabled = true`, and
  `[features]`-section boolean `multi_agent_v2 = true`. Missing file/key ->
  false (upstream default_enabled=false). Pure read; NEVER writes.
- `hasAgentsMaxThreads(codexHome?)` — regex for a `[agents]` table with
  `max_threads =` (used by the toggle warning; v2 on + agents.max_threads is a
  codex-rs boot validation error).

### MODIFY src/codex/catalog.ts

Compute `const v2 = isMultiAgentV2Enabled()` once per catalog build and thread
it to the three ultra points:

1. `applyReasoningLevels` (routed): when `!v2`, filter `"ultra"` out of the
   effort list (including provider-supplied overrides) and skip the append.
2. `ensureUltraReasoningLevel` (older natives): no-op when `!v2`.
3. `ensureGpt56ReasoningLevels` (5.6 fallback): keep the `max` append; skip
   `ultra` when `!v2`.
4. NEW `stripUltraWhenV2Off(entry, v2)` applied at the shared emission point
   (`finishUpstreamNativeEntry` + the routed/derived exit of `deriveEntry`):
   removes any `ultra` level that arrived from upstream snapshots (5.6-sol) and
   repairs `default_reasoning_level` if it pointed at ultra.

No other ladder change; native max stays exactly as upstream advertises.
Catalog build stays read-only w.r.t. config.

### NEW src/cli/v2.ts + MODIFY src/cli/index.ts dispatch

`ocx v2 status|on|off`:

- status: print enabled state + resulting picker policy line.
- on/off: shell out to `codex features enable|disable multi_agent_v2`
  (format-preserving TOML edit stays upstream-owned); on: warn when
  `hasAgentsMaxThreads()` (name the boot error + the fix); then
  `invalidateCodexModelsCache()` (existing export, catalog.ts:1338) and print
  "new sessions only; restart the Codex app / wait for cache refresh".
- NEVER auto-flips from any other code path.

### MODIFY src/server/management-api.ts

- `GET /api/v2` -> `{ enabled, agentsMaxThreadsConflict }`.
- `PUT /api/v2` body `{ enabled: boolean }` -> same routine as the CLI
  (features CLI + cache invalidation), responds with warnings array. Follows
  the existing `/api/disabled-models` pattern (which already documents the
  models-cache invalidation contract at management-api.ts:365-367).

### Tests (tests/)

- features parser: table form, boolean form, absent file -> false; CODEX_HOME
  override respected (temp dir fixtures).
- catalog gate: with temp CODEX_HOME v2 OFF -> routed model + gpt-5.5 have no
  ultra; gpt-5.6-sol ladder has max but no ultra; luna unchanged. v2 ON ->
  current behavior preserved (ultra present; sol keeps native ultra).
  Activation scenario per C-ACTIVATION-GROUNDING-01: the OFF fixture is the
  trigger; assertion on the emitted `supported_reasoning_levels` is the
  observed effect.
- endpoint: PUT /api/v2 flips + returns warning when agents.max_threads fixture
  present (runner-level, mock exec for `codex features`).

## Risks

- Codex desktop picker caches models beyond models_cache.json: toggle output
  must set expectation (restart note) — UI lag is not a gate failure.
- `codex features disable` on an under-development flag: verify exit code in B;
  if unsupported, fall back to `codex features enable`-symmetric config edit via
  the CLI's documented surface and record the deviation.

## A-gate fold-back (Feynman, GO-WITH-FIXES blockers=4, 260709)

1. Strip choke point: `stripUltraWhenV2Off` ALSO runs in the final
   `mergedEntries` map of `mergeCatalogEntriesForSync` (catalog.ts:1234-1245) —
   preserved genuine natives (:1199), empty-fetch fallback (:1221) and
   preservedForeignRouted (:1226) bypass deriveEntry, and the bundled/disk
   catalog carries native ultra (sol/terra). deriveEntry exits still get the
   strip for /v1/models.
2. Toggle = resync, not invalidate-only: `invalidateCodexModelsCache` is a
   verbatim catalog->cache copy (:1338). CLI/PUT flow follows the
   /api/disabled-models template: `refreshCodexCatalogBestEffort`
   (management-api.ts:56-63) -> `refreshCodexModelCatalog` (refresh.ts:37-46)
   = syncCatalogModels THEN invalidate. CLI reuses the `ocx sync` routine
   (cli/index.ts:467-470), never the invalidate-only sync-cache.
3. Purity/test isolation: `buildCatalogEntries` is documented pure
   (codex-catalog-golden.test.ts:5). The v2 state is resolved ONLY at the
   fs-boundary callers (server/index.ts:261 /v1/models; syncCatalogModels
   catalog.ts:1260) and threaded as an explicit `ultraEnabled` param
   (default true) through buildCatalogEntries/mergeCatalogEntriesForSync/
   deriveEntry — existing tests keep current behavior without edits.
4. CODEX_HOME resolver: paths.ts exports only the frozen module-load const;
   features.ts follows the call-time `activeCodexHome()`/`activeCodexConfigPath()`
   pattern (catalog.ts:40-54) and additionally accepts an explicit configPath
   param for hermetic fixtures.

Corollaries recorded: codex-rs picker enumerates ALL supported efforts, so a
hidden-but-supported level is impossible — never-emit mock max is the only
honest policy (already ours). `validate_spawn_agent_reasoning_effort` is pure
membership — ultra-only ladders validate; v2-off spawn effort=ultra yields a
clean "not supported" error. Startup invalidate paths (server/index.ts:161,
refresh.ts:26-29) become harmless once the sync choke point strips.

## Amendment (260709, user decision): universal mock max

Subagents are spawned with `reasoning_effort: "max"` DIRECTLY (no ultra->max client
conversion happens at spawn), and codex-rs validates spawn efforts by catalog
membership — so a ladder without max hard-fails subagent max spawns. Policy change:

- EVERY reasoning-capable entry now advertises `max` (routed + old natives +
  preserved disk entries via the merge choke point). Picker purity for mock max is
  intentionally traded away; the wire stays honest:
  - natives without real max: `nativeEffortClamp` in handleResponses rewrites
    max/ultra -> the model's real top rung (xhigh) before any adapter (incl. the
    ChatGPT passthrough _rawBody) — fixes the live "Invalid value: 'max'" 400.
  - routed models: existing adapter clamp (clampToSupportedCodexEffort).
- ultra stays v2-gated (stripUltraReasoningLevel when off); 5.6 exact ladders keep
  their upstream shape (luna never gains ultra; choke point adds max only).

## Amendment 2 (260709 evening): V2 collab rescue — encrypted-marker strip

Live failure reproduced: subagent probes on gpt-5.5 died with 502 "Encrypted
function output content could not be decrypted or decoded" on every forked-turn
replay (request log burst 17:47-17:48, requestIds ocx-mrd9k*/l*). Same account —
the binding that breaks is the encrypted payload itself on an unprovisioned
ChatGPT account (openai/codex#26753 closed not-planned, #27331).

Rescue shipped: src/responses/encrypted-tools.ts strips the Responses-only
`"encrypted": true` JSON-schema markers (codex-rs json_schema.rs:50) from
outgoing tools[] in handleResponses — the backend never encrypts collab
payloads, so neither the schema 400 nor the replay 502 can trigger. Plaintext
inter-agent messages = V1-equivalent privacy, fine for a single-user proxy.
Limits: cannot repair threads that already carry encrypted items (respawn
probes after deploy); unverified against a backend that keys encryption on
tool NAME instead of the marker (no such evidence upstream; #26753's error
text blames the schema). Needs publish + ocx restart like the rest.

## Hotfix (260709): clamp misfired on routed models

Live report: anthropic/claude-opus-4-6 (REAL max) logged `max->xhigh`. Cause:
the clamp judged nativeness by route.modelId, which is read AFTER routeModel
strips the "<provider>/" namespace — every routed model looked like an
off-snapshot bare native and hit the conservative xhigh clamp. Fix: guard on
the originally requested id (logCtx.requestedModel, captured pre-strip); any
namespaced request skips the clamp entirely — routed efforts belong to their
adapters (anthropic passes max through natively). gpt-5.5-style bare natives
keep the clamp. Needs an ocx restart to land (the live service demonstrably
runs from this tree — the max->xhigh markers in the log are this code).

## Amendment 2 FALSIFIED + reverted (260709 18:1x)

Fresh-session test with the strip live still died with "could not be decrypted
or decoded". Root cause (codex-rs source): `InterAgentCommunication::new_encrypted`
(protocol.rs / multi_agents_v2.rs:59) is CLIENT-side and UNCONDITIONAL — codex
stuffs the model's tool-call message verbatim into `encrypted_content`, expecting
the BACKEND to have encrypted it inside the function args (schema marker). With
the marker stripped, plaintext lands in encrypted_content and the backend's
decrypt/decode fails deterministically. Without the strip, this account's
backend blobs fail decrypt on replay anyway (17:47 burst). The envelope is a
client<->backend E2E protocol the proxy cannot mediate. Strip REVERTED
(encrypted-tools.ts + tests deleted, responses.ts call removed). Verdict:
multi_agent_v2 subagent spawns on ChatGPT-account natives are not proxy-rescuable;
the working state is `ocx v2 off` (V1 subagents, ultra hidden per the gate) until
upstream provisions the account/backend path (#26753 closed not-planned).

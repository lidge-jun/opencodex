# 005 — execution-cycle staleness audit of the decade docs

Research doc. No diffs. Two independent read-only terra-high explorer lanes audited
`020`-`060` against the tree at HEAD `2435b1149` before implementation started, so each
later work-phase's P begins from verified anchors rather than re-deriving them.

Lane 1 covered `020`/`030`; lane 2 covered `040`/`050`/`060`. Both were forbidden from
writing to the tree.

## Confirmed upstream facts (all four surfaces still exist under the names we assumed)

| Key | Upstream location | Type | Effective default |
|---|---|---|---|
| `agents.enabled` | `codex-rs/config/src/config_toml.rs:686` | `Option<bool>` | `true` (`core/src/config/mod.rs:3723`) |
| `agents.max_depth` | `config_toml.rs:693` | `Option<i32>` | `1` (`mod.rs:270` `DEFAULT_AGENT_MAX_DEPTH`, applied at `mod.rs:3738`) |
| `multi_agent_v2.subagent_developer_instructions` | `codex-rs/features/src/feature_configs.rs:100` | `Option<String>` | `None` (`mod.rs:1279`) |
| sideband override | `config_toml.rs:380` | `experimental_realtime_ws_base_url` | none |

Two semantics the plans did not state:

- V2 takes precedence over `[agents]` whenever the feature is on
  (`mod.rs:1521-1522`), so `agents.max_depth` is V1-only — upstream's own comment says
  "Ignored by V2".
- Upstream `.trim()`s `subagent_developer_instructions` (`mod.rs:2732`), so a
  whitespace-only value is effectively `""`. Our writer must not treat that as a
  meaningful distinction.
- `feature_configs.rs:73` carries `#[serde(deny_unknown_fields)]`: writing a key
  upstream does not know into that table breaks native config parsing outright. Any
  future mirrored key must match an upstream field name exactly.

## WP2 (`020`) — three High findings

1. **Drop the `OcxConfig` mirrors.** `020` proposed `agentsEnabled` and
   `subagentDeveloperInstructions` fields on `OcxConfig` (`src/types.ts:514`), but these
   keys live in the *native* `config.toml`, and `/api/v2` already reads native state
   directly (`src/server/management/agent-settings-routes.ts:107`). Adding OpenCodex-side
   mirrors creates two sources of truth for one value. Read natively; do not mirror.
2. **The inline-table regex cannot carry arbitrary instruction text.** The existing
   inline handling is `/^\s*multi_agent_v2\s*=\s*\{([^}]*)\}/m`
   (`src/codex/features.ts:152`, and the writer's variant at `:184`). `[^}]*` terminates
   at the first `}`, so any instruction string containing `}` — or TOML escaping — breaks
   it. A quoted-string-aware inline scanner is required, or the writer must promote the
   inline form to a dedicated `[features.multi_agent_v2]` table before writing the string.
3. **Helper visibility is not what `020` assumed.** `dominantEol` (:25),
   `mergeTrailingComments` (:37), `readConfigText` (:56), `tomlTableBody` (:67),
   `editAgentsMaxThreads` (:227), and `applyConfigEditsAtomically` (:336) are all
   module-private. Only `setMaxConcurrentThreads` (:166) and `atomicWriteFile`
   (`src/config.ts:92`) are exported. New scalar helpers stay private unless WP3 proves it
   needs them.

Stale anchors: `getAgentsMaxThreads` is 132-142 (not "ends 141"); `editAgentsMaxThreads`
starts at 227 (not ~237); the upstream config reference `mod.rs:1421` has moved (agent
validation now 3719-3738); `config.schema.json` lives at `codex-rs/core/`, not under
`core/src/config/`.

No duplicate implementation exists for any planned name, so WP2 is genuinely additive.

**Bun TOML bug reproduced independently.** Bun 1.3.14. Input bytes for `k = "tab\there"`
contain `92,116` (`\t`); `Bun.TOML.parse` returns byte `12` (`\f`). The reader is wrong,
not our encoder — byte-level assertions stand as `020` instructs.

## WP3 (`030`) — one High, two underspecified

1. **Multi-key PUT needs a transaction rule.** The existing migration deliberately
   funnels every native edit through one `applyConfigEditsAtomically` call
   (`features.ts:336`). A PUT that sets several new keys with independent writes can
   half-apply. `030` must either compose one atomic edit or state partial-success
   semantics explicitly.
2. **`agentsMaxDepthAppliesToActiveBackend` is not derivable as named.** Under default
   mode, per-model upstream pins choose the backend, so there is no single global "active
   backend" for a model-less endpoint. Either scope the field to the global
   `multi_agent_v2` flag and rename it accordingly, or take a model selector.
3. CLI help needs no change for a read-only status extension: `ocx v2 status` reads local
   files (`src/cli/v2.ts:84-86`), so the three readers are printed there without a new
   subcommand. `tests/cli-headless-parity.test.ts:87` only maps the route name and does
   not assert status text — the `030` claim that it needs updating is stale.

Current `/api/v2` GET returns exactly `enabled`, `agentsMaxThreadsConflict`,
`maxConcurrentThreadsPerSession`, `multiAgentMode`; PUT accepts `enabled`,
`maxConcurrentThreadsPerSession`, `multiAgentMode`, rejects `{}` with 400, and returns
those four plus `ok` and `warnings`.

## WP4 (`040`) — reachability claim CONFIRMED, one parity question opened

The central claim survives adversarial checking: exactly two provider shapes reach the
sideband builder.

- forward: `adapter === "openai-responses" && authMode === "forward" &&
  normalizedBaseUrl(baseUrl) === CODEX_FORWARD_BASE_URL` (`src/providers/openai-tiers.ts:32`)
- keyed: `adapter === "openai-responses" && authMode !== "forward" &&
  baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1"` (`src/providers/openai-sidecar.ts:117`)

Everything else is refused at `src/server/live.ts:372` with "Routed providers cannot
serve voice call-create." So the strict-parity change remains byte-neutral for every
reachable user, exactly as `040` argues.

One correction and one new decision:

- "pinned to exactly `https://api.openai.com/v1`" is slightly overstated: the keyed gate
  trims trailing slashes, so `https://api.openai.com/v1//` also passes and can produce a
  duplicated `/v1` in today's builder. That is a real (if cosmetic) defect the planned
  normalizer fixes, and it deserves a test.
- **Upstream does not send `intent=quicksilver`.** Upstream builds from
  `OPENAI_REALTIME_API_BASE_URL` (`methods.rs:58`) with `query_params: None`, appending
  only `call_id` (`methods.rs:806`, `:987`). OpenCodex adds `intent=quicksilver`
  (`live.ts:204`). WP4 must decide explicitly whether that parameter is required
  OpenCodex compatibility — and if it is kept, WP4 must stop describing itself as
  byte-for-byte upstream URL parity.

Coverage: only `tests/server-live.test.ts:554` builds these URLs directly (relay at
:470); nothing currently tests the routed-provider rejection.

## WP5 (`050`) — NOOP confirmed, but the doc's wording is wrong

Fresh scan, both spellings:

```
rg -n --glob '*.ts' --glob '*.tsx' -e 'code_mode_host|codeModeHost|enable_fanout|enableFanout|item_ids|itemIds' src gui/src
(no matches, exit 1)
```

Upstream status corrects `050`'s framing: `enable_fanout` (`features/src/lib.rs:1100`)
and `item_ids` (`:1256`) are `Stage::Removed` but **still accepted** as compatibility
keys, and `code_mode_host` (`:904`) is `Stage::Stable` and enabled by default — not
removed at all. `multi_agent_v2` itself is `Stage::Stable`, default false (`:1088`).
So the honest statement is "OpenCodex never mirrored these; upstream retains two as
accepted-but-inert keys and one as a live feature."

The regression test should assert the delegation boundary behaviorally, in
`tests/codex-v2-gate.test.ts`: a config carrying all three keys does not perturb
`isMultiAgentV2Enabled`, and `codexFeaturesInvocation("enable").args` is exactly
`["features", "enable", "multi_agent_v2"]`. A source-regex absence test is weaker — it
trips on comments and misses a mirrored key stored as a bare TOML string.

## WP6 (`060`) — the open risk is now sharp, and it may invalidate the planned fix

Both filter sites are exactly where `060` says:

```
src/codex/catalog/sync.ts:89   .filter(({ entry }) => surface !== "v2" || entry.multi_agent_version === "v2")
src/codex/catalog/sync.ts:113  if (surface === "v2" && entry.multi_agent_version !== "v2")
```

Snapshot distribution verified against `src/codex/data/upstream-models.json`: `v2` = 2,
`v1` = 1, explicit `null` = 5, key-absent = 0 out of 8 entries. The absent case does not
occur in the snapshot — but it **does** occur in production, because routed
normalization runs `delete entry.multi_agent_version` (`src/codex/catalog/parsing.ts:325`)
and `RawEntry` is `Record<string, unknown>` (`parsing.ts:117`), so absent reads as
`undefined`, never `null`. The predicate must be
`pinned === "v2" || pinned === null || pinned === undefined`. The existing fixture helper
cannot even construct the absent case — it rewrites `undefined` to `"v2"`
(`tests/multi-agent-compat.test.ts:53`) — so WP6 must fix that helper or add an explicit
omission fixture, or the production-only branch ships untested.

**The named open risk is now concrete and points the other way.** We write
`CODEX_HOME/opencodex-catalog.json` (`sync.ts:519`, resolved at `parsing.ts:167` /
`src/codex/paths.ts:27`) and advertise it via `model_catalog_json` (`src/codex/inject.ts:351`),
which upstream says "replaces the bundled catalog for the current process"
(`core/src/config/mod.rs:968`). But `spawn_agent` then applies **its own** V2 pin
predicate to that list (`core/src/tools/handlers/multi_agents_common.rs:271` fetches,
`:416` filters). No independent hardcoded allowlist exists — which means the gate is the
`multi_agent_version` value *in the catalog we write*. Widening only our advisory roster
while still emitting `null`/absent would therefore leave the binary refusing the model.

Implication for WP6's P: option B likely requires writing `"v2"` for routed models in the
emitted catalog, not merely relaxing our own filter. That is a bigger change than `060`
scoped, and it must be settled by a real spawn against an isolated `CODEX_HOME`, not by
reading Rust. If the refusal reproduces and cannot be fixed inside our catalog writer,
WP6 closes `BLOCKED` with that evidence.

Test impact: `tests/multi-agent-compat.test.ts:126` currently asserts explicit-null
`gpt-5.5` is excluded and must flip; its matrix at :159 is the right home for the new
cases. `tests/codex-catalog.test.ts:939` and `tests/codex-v2-gate.test.ts:522` should
stay green.

## Phase-order consequence

WP2 and WP3 both touch regions WP1 edits (`features.ts` around 147-166, 227, 317, 406).
Each later P re-reads the file after the previous phase lands rather than resolving those
hunks speculatively.

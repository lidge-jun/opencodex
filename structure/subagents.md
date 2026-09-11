# Subagents And Multi-Agent Surface

## Multi-agent surface mode (3-state)

`OcxConfig.multiAgentMode` controls the `multi_agent_version` field stamped on catalog entries:

| Mode | Behavior |
| --- | --- |
| `"v1"` | Force ALL entries to `multi_agent_version = "v1"` — overrides upstream pins (sol/terra included). |
| `"default"` (install default) | Respect upstream model pins (sol/terra=v2, luna=v1, others=null → codex feature flag decides). On sync, stale forced values are cleared and upstream pins restored. |
| `"v2"` | Force ALL entries to `multi_agent_version = "v2"` — overrides upstream pins (luna included). |

The override is applied as a final pass in both `buildCatalogEntries` (live `/v1/models` path) and
`mergeCatalogEntriesForSync` (on-disk sync), AFTER all normalization and visibility processing. This
ensures `normalizeRoutedCatalogEntry` (which deletes `multi_agent_version` from routed entries) does
not clobber the forced value.

CLI: `ocx v2 mode v1|default|v2`. GUI: segmented control on the Models page. API: `GET/PUT /api/v2`
with `multiAgentMode` field.

The `multi_agent_v2` feature flag and the logical maximum thread count are separate from
`multiAgentMode` (`src/codex/features.ts`): the mode decides which surface Codex advertises, while
the flag and thread count decide what the native runtime allows.

`keepNativeChatGptOnV1` makes mode `v2` a catalog-driven hybrid: OpenCodex disables the global
`multi_agent_v2` override because codex-rs resolves that override before a model row's explicit
`multi_agent_version`. Native ChatGPT rows then select v1 from the catalog and routed rows select
v2. An explicit attempt to enable the global flag while the hybrid pin is active is rejected.

### What the five-model `spawn_agent` window is, and how V1 differs from V2

`MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5` (mirrored in `src/codex/catalog/sync.ts`) is **not** a
subagent concurrency limit and **not** an eligibility limit. Upstream uses it in exactly two
places: the model list rendered into the `spawn_agent` tool description
(`multi_agents_spec.rs:789`) and the "Available models:" suggestions in an unknown-model error
(`multi_agents_common.rs:448`, inside the `ok_or_else` closure that runs only *after* the lookup
already failed). The success path `find_spawn_agent_model_name` (`:431-442`) scans the whole
catalog with neither the cap nor a `show_in_picker` filter, so a model outside the advertised
five is still accepted when named exactly.

Three different numbers, often conflated:

| Quantity | Value | Source |
| --- | --- | --- |
| Models **advertised** as overrides | `min(5, picker-visible eligible rows)` | `multi_agents_spec.rs:785-790` |
| Models **eligible** as targets | no numeric cap (only `"disabled"` is excluded, and only on V2) | `multi_agents_common.rs:36-42` |
| **Concurrent** subagents | V1 6 children (root excluded); V2 total 4 including root → 3 children | `config/mod.rs:211-212`, `:1497-1506` |

**The cap is the same 5 on both surfaces, but the window's contents are not.** The eligibility
filter runs *before* `.take(5)`, and it behaves differently per surface: on a V1 call
`model_supports_multi_agent_backend` short-circuits true for every row (including `disabled`
ones), while a V2 call drops `Some(Disabled)` first — which lets a later row move into the five.
Same catalog, different advertised list:

| # | Model | pin | V1 advertises | V2 advertises |
| ---: | --- | --- | :---: | :---: |
| 1 | `v2-a` | `v2` | ✅ | ✅ |
| 2 | `disabled-a` | `disabled` | ✅ | — |
| 3 | `v1-a` | `v1` | ✅ | ✅ |
| 4 | `null-a` | absent | ✅ | ✅ |
| 5 | `v2-b` | `v2` | ✅ | ✅ |
| 6 | `disabled-b` | `disabled` | — | — |
| 7 | `null-b` | absent | — | ✅ |

opencodex already matches this: `effectiveSubagentRoster` filters with
`surface !== "v2" || isEligibleV2SubagentEntry(entry)`, so the V1 path skips the eligibility
filter exactly as upstream does. opencodex also injects no roster on V1
(`src/server/responses/collaboration.ts` emits only proactive text at the top effort tier), so
the upstream tool description remains the authority there.

Two further V1/V2 differences worth knowing: the list gate is
`hide_agent_type_model_reasoning` on V1 (hard-coded `false` at registration, so V1 always
advertises) but `expose_spawn_agent_model_overrides` on V2 (default `true`; when false the list
is omitted *and* the `model`/`reasoning_effort` schema fields are removed). And V2's
`hide_spawn_agent_metadata` defaults true, which removes `service_tier`.

`modelPickerOrder` (#1649) separates **OpenCodex guidance** from native advertisement.
`SPAWN_PRIORITY_FIELD` preserves the natural priority used by `effectiveSubagentRoster`, so
OpenCodex's preferred/guidance candidate calculation stays independent of display order.
Native Codex ignores that private field: its advertised five on V1 and exposed V2 follow the
native `priority` and may change when the picker is reordered. Exact-name override lookup is
not restricted to those five advertised rows. V1 receives no OpenCodex preferred-roster
injection; V2 can additionally receive natural-priority guidance when its catalog state permits.
The helper tests pin guidance behavior, not native tool-description equivalence.

A nonblank bare id in `modelPickerOrder` opts into complete-picker display ordering. Exact
ids take precedence over raw/encoded equivalents; routed-only and empty lists keep the legacy
ordering behavior. This does not change the separate `opencodex_spawn_priority` contract.
Retained rows recompute their natural ranks from the current featured roster and account-selector
stride before display order is applied, so a discovery outage cannot preserve an obsolete
featured or picker rank. Canonical `opencode-go` rows retain their configured reasoning ladder
both when generated and when merged from retained catalog state; synthetic max/ultra choices
are not added to that provider's declared ladder.

Full derivation with per-line citations: `devlog/_plan/260816_codexrs_multiagent_v2_and_history_perf/013_five_cap_v1_vs_v2.md`.

## Subagents

New non-OAuth provider registrations carry `initialModelSelection` with a unique
registration identity. Until reliable live/static discovery completes, public
catalogs and model candidates withhold those providers' models; the provider itself
stays active. At 20 or more canonical Models switch rows, initialization appends
all corresponding disabled selectors once. Existing registrations and later manual
choices are not reinitialized. OAuth/ChatGPT forwarding is exempt using the same
usable-key override predicate as routing. Display aliases do not add switch rows.

`src/providers/initial-model-selection-runtime.ts` commits the decision against a
matching registration/inventory snapshot before catalog authority is captured.
Ordinary management discovery also completes it with Codex integration OFF. The
final catalog merge fences pending retained rows, including delete/re-add recovery.
Raw management rows remain visible as pending/OFF. Config listener bindings are
excluded from inventory identity because live and persisted bindings may differ.

Codex `spawn_agent` advertises only the highest-priority first five picker-visible catalog rows.
Use at most five configured `subagentModels` ids; they may contain bare catalog ids, routed
`provider/model` ids, or exact account-qualified `<selector>/<native-openai-model>` ids. The
dashboard offers bare native and routed choices; exact account-qualified choices are configured
through `ocx agent subagents set` or the opencodex configuration.

When account selectors are active, one featured bare native id expands into a complete selector row
group. Catalog priorities use the selector count as a stride so each group stays together without
widening Codex's five-row advertisement window. Fresh defaults are Astra, Sol, Terra, Luna, 5.5.
Startup upgrades unmarked rosters once: prepend `gpt-6-astra`, retain the first four unique
non-Astra choices, then move retained bare `gpt-5.5` last. The old fifth choice is dropped;
an unmarked empty list becomes Astra only, and an unset list receives the fresh defaults.
`subagentModelsVersion: 1` records completion, so later user edits (including an empty list or
removing Astra) persist. The migration rebases on the latest disk config under the existing
mutation lock; failed persistence degrades to an in-memory roster for that run without a stale
whole-config overwrite. Existing disabled-model visibility rules remain unchanged.

Quota-aware fallback walks a configured chain when the featured model is exhausted, probing
availability on a bounded interval (default 60 s, `src/codex/subagent-model-fallback.ts`). It rewrites
the requested model id only; effort remains owned by the caps described under
[Ultra reasoning level](#ultra-reasoning-level).

`injectionModel` and `injectionEffort` are shared selections with two independent consumers.
`multiAgentGuidanceEnabled` controls only OpenCodex-authored delegation guidance.
`syncCodexSubagentDefaults` is a separate, default-off opt-in that applies the selected values to
Codex's native `[agents]` defaults on sync/restart for newly created Codex tasks when OpenCodex owns
the active Codex routing; external user-managed provider configs remain untouched. It does not itself
cause delegation. The TOML edit owns only marker-tagged values, preserves existing unmarked
user-owned `[agents]` defaults rather than overwriting them, and rejects ambiguous table shapes
without changing the file.

V2 proxy guidance uses `<opencodex_subagent_guidance>` for both built-in metadata and
custom `injectionPrompt` bodies. The built-in text reports the resolved preferred model,
effort, roster and fallback chain without prescribing delegation, spawn overrides or
`fork_turns`. Custom bodies retain their placeholder behavior. The guidance switch and
catalog-state gates still apply; stale or unknown catalog state suppresses proxy guidance.
V1 uses the shared `MULTI_AGENT_MODE_HINT_RECOMMENDATION.text` inside `<multi_agent_mode>`
at `max` or `ultra`. Only the separate explicit delegation-request trigger changes; user,
authority, task-scope and collaboration-tool rules remain applicable. This is guidance,
not an enforcement mechanism or a change to native settings or tool access.

Replay deduplication compares the latest exact generated developer text separately for
each tag family, preserving built-in → custom → built-in transitions without duplicating
unchanged proxy metadata after a native policy change. Native and legacy-tagged history
remain intact: tags do not establish historical authorship or revoke old instructions,
and mixed-version transition detection is not guaranteed.

The native mode hint is separate from proxy guidance and native `[agents]` defaults.
`src/codex/multi-agent-mode-policy.ts` owns the proactive recommendation; the dashboard
obtains it from `/api/v2` rather than maintaining its own preset. An explicit dashboard,
API or CLI hint write passes through `setMultiAgentModeHintText`, which replaces only
the two byte-exact released OpenCodex presets with the current recommendation. Other
valid custom text, including whitespace variants, is preserved. Reads, unrelated writes
and upgrades do not migrate stored hints. The writer retains its native capability check
and stores only `features.multi_agent_v2.multi_agent_mode_hint_text` in Codex TOML;
`null` removes that key. The hint affects new native Codex sessions when their v2 surface
is active, without changing reasoning effort or the proxy guidance switch.

Claude Code `ocx-*` agent definitions consume the same effective `claudeCode.blockedSkills` policy
as inbound bundle elision. When the list is non-empty (default: `claude-api`), generated definitions
whose marker-stripped model resolves to a routed id receive a preventive instruction not to invoke
those skills. Direct `provider/model` selectors are routed even when their inbound resolution is
identity. The only unguarded `ocx-self` case is an identity-resolved `claude|anthropic` model while
native passthrough is enabled; `modelMap` claims and `nativePassthrough:false` restore the guard. The
guard avoids creating oversized skill messages before the proxy can intervene; inbound elision remains
the fallback if a client still sends a blocked bundle. An explicit empty list disables both routed-model
behaviors.

> Decision record: [ADR-0027](decisions/ADR-0027-subagents.md)


### Saved picker presets

The Models page saves routed snapshots in `modelPickerOrder` and records their origin in
`modelPickerOrderMode` (`alphabetical`, `provider`, `most-used`). Mode is UI provenance, not a
catalog sorting policy: catalog writers consume the saved array. Routed-only featured/native
bands and complete-picker natural-rank preservation remain as described above. Public
`buildCatalogEntries` accepts the order as its final argument and applies the complete-order
pass after building. On-disk convergence retains its existing post-merge final pass.

Claude ModelInfo ordering receives optional `{ modelPickerOrder, featured }` after `fastRows`.
It orders routed output groups after alias deduplication, preserving the collision winner and
base/1M/Fast siblings. Native groups and explicit Desktop profile ownership are unchanged.
Native Codex advertisements still follow display priority; private guidance ranks do not freeze them.

# Catalog And Subagents SOT

## Shared catalog

`src/codex/catalog.ts` builds a shared Codex-shaped catalog for CLI, TUI, App, and SDK. It:

- preserves native OpenAI entries from the live catalog or static fallback, and emits
  gpt-5.6 natives from the pinned upstream models.json snapshot
  (`src/codex/data/upstream-models.json` — exact per-slug ladders: luna has no ultra);
- upgrades either an observed selector-qualified `*/gpt-daybreak-blue-latest` account row or an
  explicitly configured canonical `openai/gpt-daybreak-blue-latest` Codex-forward row from the
  pinned Sol capability metadata while preserving its selector and Daybreak wire identity;
  this never expands the bare/API-key model lists or rewrites the wire model to `gpt-5.6-sol`;
- clones a native template for routed `provider/model` entries;
- forces strict Codex catalog fields required by the current parser;
- hides `disabledModels` without blocking direct routing (routed provider ids are excluded;
  account-qualified native ids hide only that selector row; BARE native slugs hide the bare row
  and all account-selector clones and drop that model family from raw `/v1/models`);
- applies exact provider/model compatibility exclusions after live discovery and metadata
  augmentation, so upstream-advertised but uncallable rows never enter dashboard or Codex pickers;
- strips native-only service tier and WebSocket metadata unless the final routed provider/model
  explicitly enables the verified OpenAI-compatible service tier;
- backs up the pristine catalog once per catalog: the copy is keyed by a hash of the catalog path
  (`catalog-backup-<id>.json`), and the legacy unsuffixed `catalog-backup.json` is retained in
  addition for the default catalog, so a restore resolves the backup for the catalog it is restoring
  rather than assuming a single file;
- invalidates `$CODEX_HOME/models_cache.json` when model visibility changes.

On the default `opencodex-catalog.json` path, sync deliberately uses two catalog sources: Codex's
bundled catalog supplies a current native entry template, while the actual on-disk catalog supplies
the rows being merged. This split is required because empty or partial provider discovery must
preserve routed entries and genuine user-native rows from the file that will be overwritten; a
bundled catalog never contains those rows. Retained sync and evidence-bound convergence share an
explicit observed-state merge policy and restore native priorities from the once-only pristine
backup rather than from a catalog whose priorities may already have been rewritten. A configured
custom catalog remains the native metadata/template authority even when a bundled-catalog memo is
warm. Both paths may use an admitted matching bundled memo only as installed-runtime capability
evidence to remove unsupported reasoning efforts; convergence never probes Codex itself.

When account selectors are enabled, the sync path may also observe exact, visible, API-supported
OpenAI-family ids from Codex's user-owned catalog/cache. Only rows with native catalog provenance
are trusted; unknown ids are carried through startup cache invalidation as hidden observations and
are emitted only as selector-qualified rows whose account provenance matches. They never expand
the bare native or API-key model list. This keeps account-scoped upstream ids such as
`gpt-daybreak-blue-latest` callable without treating them as a static release allowlist.

Account-gated native ids are a stricter subset. Their authenticated ChatGPT `/models` roster is
cached per credential generation with a bounded timeout. A bare gated row is emitted only when at
least one confirmed eligible account reports it; a selector-qualified row is emitted only when the
mapped account reports it. A failed or malformed discovery is not positive evidence and therefore
hides the gated row until a later refresh. The same snapshot gates Pool selection, so the catalog
and runtime cannot disagree by advertising through one account and dispatching through another.

The app-server's model list comes from this shared catalog, not from patching the App. Codex Desktop
may still apply its remote native-only allowlist after `model/list`; an explicitly configured combo
`nativeAlias` is the bounded compatibility path. It replaces one supported bare native row with a
routed, labeled row, routes the bare id before canonical OpenAI, and keeps account-qualified native
selectors genuine. Missing target discovery capabilities inherit the replaced native row's metadata,
while explicit target limits remain authoritative. Because the affected renderer ignores `visibility: "hide"`, the presence of any
native alias also omits disabled bare native rows from the effective catalog. Dashboard rows remain
derived from the static native set, and sync retains bundled/pristine native recovery sources so a
later re-enable or alias removal restores native metadata.

Provider live-model lists are cached with a configured TTL (`src/codex/model-cache.ts`). Adding,
deleting, or editing a provider's shape clears that per-provider cache; a disabled-only change
deliberately does not, because a disabled provider is already excluded from the catalog gather
instead. Codex's own `models_cache.json` is a different cache, invalidated by catalog refresh.

### Windows request-path catalog-state discovery

[Decision Log]
- 목적과 의도: Prevent Windows PowerShell/CIM process discovery from blocking Bun's event loop while v2 sub-agent guidance is assembled.
- 기존 구현 및 제약 조건: The stale-catalog check is advisory on the request path, but CLI/service lifecycle operations use the same process evidence before warning or terminating narrowly matched app-servers.
- 검토한 주요 대안: Remove stale-catalog guidance, move every platform collector into workers, or isolate only the Windows request path behind asynchronous child processes.
- 선택한 방식: Keep the synchronous fail-closed collector for explicit lifecycle operations; v2 requests use asynchronous trusted-System32 PowerShell, one identity-scoped in-flight refresh, and the existing short cache. Cache invalidation advances a generation so a pre-write CIM result cannot repopulate post-write state.
- 다른 대안 대신 이 방식을 선택한 이유: This preserves process ownership and matching invariants while preventing a slow CIM query from starving `/healthz` and unrelated proxy traffic.
- 장점, 단점 및 영향: Concurrent v2 turns do not multiply CIM walks and the event loop remains responsive. A cold request can still await the bounded advisory check, and collection failure suppresses OpenCodex-authored model guidance as `unknown`.

## Startup readiness

Each `startServer` invocation owns a private, one-shot readiness gate created before the listener
binds. `handleStart` supplies its gate and transitions it only after the shared catalog sync and
best-effort Claude Code roster reconciliation have both settled. The catalog sync remains the
authority for ready versus failed; a roster warning does not make an otherwise healthy proxy fail.
Calls without a supplied gate receive a fresh private gate that intentionally remains pending. Only
`ok: true` with no nonempty warning becomes ready; `null`, a throw, `ok !== true`, or a nonempty
warning becomes failed. State is isolated per server instance.

Exact unauthenticated `GET /readyz` returns sanitized identity fields plus pending, ready, or failed:
`200` for ready, or `503` with `Retry-After: 1` for pending and terminal failed. The full CLI syntax
is `ocx ready [--json] [--wait [--timeout <seconds>]]`. The probe validates the service, version,
uptime, PID, port, status, and HTTP/status pairing. The default is one probe. With `--wait`, it
applies one absolute deadline (45 seconds by default) across discovery, readiness probes, polling,
and sleeps, but exits immediately on terminal failed. `--timeout <seconds>` requires `--wait` and
accepts positive integer seconds from 1–300. CLI `--json` emits
`{ready, status, pid, port}`, with status in `ready|pending|failed|unreachable`. Exit 0 means ready;
exit 1 covers not-ready, pending, failed, timeout, and unreachable; exit 64 means invalid arguments.
Older proxies without `/readyz` fail closed as unreachable. `/healthz` remains the separate
liveness contract.

## Entry shape

Routed entries keep Codex-required metadata such as reasoning levels, shell type, API support flags,
base instructions, modalities, auto-compact fields, and strict parser booleans. The public slug uses
the canonical `provider/model`. Its display name uses the provider's exact `modelDisplayNames` override first,
then trusted catalog metadata such as a configured qualified provider/model alias, then the public slug.
This overlay never changes route identity or the upstream wire model, and its catalog fingerprint makes
a label edit refresh Codex output.

## Native passthrough

Native bare OpenAI entries form one `openai` group. The provider's Pool(default)/Direct option
changes account selection without changing those ids; `openai-apikey/<model>` creates the separate
API-key identity. The API GPT-5.6 rows use 1,050,000 context / 922,000 max input; their `*-pro` virtual rows
rewrite to the base upstream model with `reasoning.mode: "pro"` while public state keeps the virtual
slug. Routed non-OpenAI models must not
inherit native-only service tier or WebSocket metadata unless the user explicitly enables that
capability. Detailed invariants live in [`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).

Native passthrough entries depend on the enabled provider set. With at least one enabled provider,
they appear only while an enabled canonical OpenAI forward provider exists — disabling every such
provider removes the native rows rather than leaving entries that resolve to no credential. With no
enabled provider at all, the native rows remain as bootstrap so a fresh install still has something
to route.

## Accounts, namespaces, and pool rotation

Pool mode routes across main plus added Codex credentials. Key rules:

- **A namespace is a public selector mapped to an internal target.** Generated selectors are how a
  caller names an account — the main login's selector is `main` (collision-suffixed if taken),
  which maps to the config-only sentinel `@main`; the sentinel deliberately sits outside the
  pool-account id grammar. Selector initialization requires an explicit opt-in and fills only an
  absent or empty map; a non-empty user map keeps its object identity and insertion order. Generated
  selectors avoid provider, combo, routing-policy, and slash-qualified routing-profile namespaces.
  Collision checks normalize provider and reserved namespace keys, while account and
  routing-profile selector prefixes are exact-case (`src/codex/account-namespaces.ts`,
  `src/codex/account-namespace-match.ts`, `src/routing/profile-namespace.ts`).
- **Selector labels carry no account-role semantics.** When at least one selector is advertisable,
  the Codex catalog clones each supported native row per selector and hides the bare picker rows;
  bare ids remain routable and stay in raw `/v1/models` unless explicitly disabled. Missing stored
  account targets are not advertised, and private account ids never become catalog labels.
  `codexAccountPickerEnabled: false` hides generated rows without deleting exact routing bindings;
  an omitted flag preserves the established behavior of a nonempty hand-written selector map.
- **Rotation is sticky.** A conversation stays on its selected account while that account is
  usable; failure moves it, success does not (`src/codex/pool-rotation.ts`).
- **The credential store is generation-guarded.** A refresh takes a lock and persists only if the
  generation it started from still holds; a lost race raises a generation-conflict error rather
  than overwriting the newer credential (`src/codex/account-store.ts`). Callers handle that error;
  they do not assume a silent retry.

Warmup issues a bounded request with a fallback model so a cold account reports usability before a
real turn depends on it (`src/codex/warmup.ts`).

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

`modelPickerOrder` (#1649) deliberately does **not** feed this window: it rewrites only the
Codex-visible `priority` while `SPAWN_PRIORITY_FIELD` preserves the natural priority the roster
sorts by, so a display reorder can never change candidate membership. That divergence from
upstream's own ordering is the feature's purpose, not a defect —
`tests/codex-catalog-model-picker-order.test.ts` pins it.

Full derivation with per-line citations: `devlog/_plan/260816_codexrs_multiagent_v2_and_history_perf/013_five_cap_v1_vs_v2.md`.

## Routed tool discovery and hosted search

All routed catalog rows advertise `supports_search_tool: true` together with
`tool_mode: "code_mode_only"` — the pair is load-bearing. The field selects Codex's deferred
tool-discovery surface; it does not describe the hosted web-search sidecar. Under code mode,
deferred MCP tools remain callable through exec's `tools` global / `ALL_TOOLS` without a
`tool_search` round-trip (upstream codex-rs code_mode suite; live canary 2026-08-13: routed
kimi/k3 executed `tools.mcp__node_repl__js`, devlog `260813_tool_catalog_deferral/010+020`).
Stamping `false` instead forces every MCP declaration into `exec.description` — a measured 2.7x
turn-1 payload regression (96,699 → 258,929 chars). For Cursor this can also make the unified
`exec` exceed the 120,000-byte serialized `McpTools` ceiling; the budget then drops `exec` and
its companion `wait` (#1830). Hosted search remains independent: non-Cursor routes keep
`web_search_tool_type: "text_and_image"`, while Cursor omits it because runTurn bypasses the
search sidecar.

[Decision Log]
- 목적과 의도: keep routed plugin/MCP tools reachable without paying the full-catalog turn-1 payload tax or starving Cursor's unified execution bridge.
- 기존 구현 및 제약 조건: #1596 restored deferred discovery only for non-Cursor rows because Cursor bypasses the hosted-search sidecar; codex-rs treats deferred exposure and hosted search as separate capabilities, and Cursor independently enforces a 120,000-byte serialized tool-catalog limit.
- 검토한 주요 대안: keep Cursor opted out, raise/disable Cursor's transport ceiling, synthesize another execution bridge, or enable Cursor-native local exec only when the bridge disappears.
- 선택한 방식: enable Codex deferred exposure for Cursor code-mode rows too, while continuing to omit Cursor's hosted `web_search_tool_type`.
- 다른 대안 대신 이 방식을 선택한 이유: it removes the known exec-description inflation before Cursor budgeting without weakening the measured transport limit, inventing caller tools, or turning bridge absence into local-execution authority.
- 장점, 단점 및 영향: Cursor keeps a compact Responses-owned `exec` path under rich tool catalogs and hosted-search behavior remains unchanged; the existing Cursor budget and native-local-exec fail-closed policy remain authoritative.

## Ultra reasoning level

Ultra is always advertised in the catalog regardless of the `multi_agent_v2` toggle. The v2 toggle
controls only the multi-agent collab surface, not ultra visibility. The `nativeEffortClamp` function
wire-clamps ultra/max to each model's real top rung (e.g. gpt-5.5 ultra → xhigh on the wire).

`effortCap` and `subagentEffortCap` are hard ceilings applied on the V2 path
(`src/server/effort-policy.ts`): they lower or preserve the requested effort rather than rejecting
the request, and they never raise it.

[Decision Log]
- 목적과 의도: Xiaomi MiMo의 공식 OpenAI Chat endpoint가 실제로 받지 않는 `max`/
  `ultra` reasoning tier를 catalog에 노출하지 않도록 한다.
- 기존 구현 및 제약 조건: `xiaomi`는 Anthropic endpoint, `mimo`는 token-plan endpoint를
  소유하며, 공식 `https://api.xiaomimimo.com/v1`은 generic custom provider로 처리됐다.
- 검토한 주요 대안: 기존 `xiaomi`/`mimo` contract를 확장하기, 모든 custom provider의 ladder를
  일괄 축소하기, 공식 public endpoint만을 별도 registry row로 소유하기.
- 선택한 방식: `xiaomi-mimo`를 고정 목적지의 `openai-chat` preset으로 등록하고
  `low`/`medium`/`high`만 노출하며 높은 direct request는 `high`로 clamp한다.
- 다른 대안 대신 이 방식을 선택한 이유: 서로 다른 auth/wire/host를 하나의 preset으로
  합치지 않으면서 upstream error로 확인된 계약만 적용할 수 있다.
- 장점, 단점 및 영향: 공식 endpoint에서 안전한 picker/wire 계약을 제공하고,
  `preserveCustomDestination`으로 같은 이름의 다른 host/key를 보호한다. 대신 새 preset 표면을
  문서와 registry parity에서 함께 유지해야 한다.

[Decision Log]
- 목적과 의도: Xiaomi token-plan에서 image input을 거부하는 `mimo-v2.5-pro`만 vision
  sidecar로 우회하고, 실제 image input을 받는 `mimo-v2.5`는 native vision 경로에 남긴다.
- 기존 구현 및 제약 조건: upstream `/v1/models`는 input modality를 제공하지 않으며,
  `noVisionModels`는 text-only 모델을 sidecar로 보내면서 Codex catalog에는 image input을
  광고하는 provider-scoped 계약이다.
- 검토한 주요 대안: MiMo 전체를 text-only로 분류하기, live discovery에서 modality를
  추측하기, `mimo-v2.5-pro` 하나만 registry에 고정 분류하기.
- 선택한 방식: canonical `mimo` preset의 `noVisionModels`에 `mimo-v2.5-pro`만 추가한다.
- 다른 대안 대신 이 방식을 선택한 이유: live endpoint 검증으로 확인된 최소 범위만
  적용하며, 정상 동작하는 `mimo-v2.5`의 native image 경로를 훼손하지 않는다.
- 장점, 단점 및 영향: Pro image 요청의 404를 sidecar 설명 경로로 바꾸고 base 모델은
  그대로 유지한다. `preserveCustomDestination` guard 때문에 같은 provider id를 다른 host에
  연결한 사용자 설정에는 이 capability 분류가 전파되지 않는다.

[Decision Log]
- 목적과 의도: GitHub Copilot의 live model catalog가 명시하는 모델별 image-input 지원을
  Codex catalog에 정확히 보존한다.
- 기존 구현 및 제약 조건: 공용 discovery parser는 직접 `capabilities.vision`과 표준 modality
  필드는 읽었지만 Copilot의 `capabilities.supports.vision` 중첩 boolean은 읽지 않아 모든
  Copilot 모델이 text-only fallback으로 축소되었다.
- 검토한 주요 대안: 모든 Copilot 모델에 정적 vision seed를 추가하기, 모델 이름을 외부
  metadata alias에 연결하기, live 모델별 boolean을 공용 parser에서 해석하기.
- 선택한 방식: 직접 vision boolean이 없을 때만 중첩 `supports.vision`의 명시적 boolean을
  사용하고, `false`도 보존하며 malformed 값은 추론하지 않는다.
- 다른 대안 대신 이 방식을 선택한 이유: live 응답이 모델별 capability의 가장 좁은 근거라서
  새 모델에도 적용되며 text-only 모델을 image-capable로 과장하지 않는다.
- 장점, 단점 및 영향: Copilot vision 모델은 image attachment를 받을 수 있고 명시적 text-only
  모델은 계속 차단된다. Capability를 제공하지 않는 모델은 기존 fallback을 유지한다.

[Decision Log]
- 목적과 의도: bare `defaultModel` selectors that route into third-party providers must keep their
  adapter-owned effort ladder; only true ChatGPT-native requests should receive the mock-max repair.
- 기존 구현 및 제약 조건: `nativeEffortClamp` already needed the original request id because
  routing strips `provider/`, but bare third-party selectors like `glm-5.2-fast-preview` still look
  native after that strip.
- 검토한 주요 대안: (1) infer nativeness from the bare slug prefix alone, (2) gate clamping by the
  resolved provider identity, (3) disable the clamp for all off-snapshot slugs.
- 선택한 방식: request-time clamp entry is allowed only when the resolved route is the canonical
  built-in OpenAI/Codex forward provider and the original request id is still bare.
- 다른 대안 대신 이 방식을 선택한 이유: provider identity is the only durable signal that
  distinguishes true native ChatGPT traffic from third-party `defaultModel` routes when both share a
  bare model id shape.
- 장점, 단점 및 영향: preserves `gpt-5.5 max -> xhigh` repair for native traffic, removes false
  clamps for bare routed models, and keeps adapter-specific effort mapping as the single source of
  truth for third-party providers.

## Subagents

Codex `spawn_agent` advertises only the highest-priority first five picker-visible catalog rows.
Use at most five configured `subagentModels` ids; they may contain bare catalog ids, routed
`provider/model` ids, or exact account-qualified `<selector>/<native-openai-model>` ids. The
dashboard offers bare native and routed choices; exact account-qualified choices are configured
through `ocx agent subagents set` or the opencodex configuration.

When account selectors are active, one featured bare native id expands into a complete selector row
group. Catalog priorities use the selector count as a stride so each group stays together without
widening Codex's five-row advertisement window. Startup seeds bare native GPT defaults only when
`subagentModels` is unset; an explicit empty list persists.

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

Claude Code `ocx-*` agent definitions consume the same effective `claudeCode.blockedSkills` policy
as inbound bundle elision. When the list is non-empty (default: `claude-api`), generated definitions
whose marker-stripped model resolves to a routed id receive a preventive instruction not to invoke
those skills. Direct `provider/model` selectors are routed even when their inbound resolution is
identity. The only unguarded `ocx-self` case is an identity-resolved `claude|anthropic` model while
native passthrough is enabled; `modelMap` claims and `nativePassthrough:false` restore the guard. The
guard avoids creating oversized skill messages before the proxy can intervene; inbound elision remains
the fallback if a client still sends a blocked bundle. An explicit empty list disables both routed-model
behaviors.

[Decision Log]
- 목적과 의도: keep generated Claude Code `ocx-*.md` roster files synchronized when the proxy is
  started or ensured on Linux, Windows, and macOS, including background service restarts.
- 기존 구현 및 제약 조건: explicit `ocx claude` launches and Management API writes reconciled the
  files, while the startup call inside `injectSystemEnv` ran only on macOS with system-env enabled.
  `startServer` is also used as an in-process library/test primitive and cannot safely mutate the
  real user home on every invocation.
- 검토한 주요 대안: write from `startServer`; duplicate hooks in each OS service manager; reconcile
  once from the owning CLI lifecycle after the listener becomes available.
- 선택한 방식: the foreground/service start and live-proxy ensure paths call one best-effort helper
  after bind, using the live Management API context-window map and the existing marker-verified
  atomic roster writer. macOS system-env startup keeps its existing shared-window sync and skips the
  duplicate call.
- 다른 대안 대신 이 방식을 선택한 이유: it covers every supported service entrypoint without
  adding home-directory side effects to server-library consumers or creating a second roster format.
- 장점, 단점 및 영향: stale OpenCodex-owned definitions converge on every daemon start, disabled integration
  prunes them without provider discovery, and catalog failure falls back to unmarked definitions so
  startup remains available. A later dashboard save or `ocx claude` launch restores missing context
  markers after a transient failure.

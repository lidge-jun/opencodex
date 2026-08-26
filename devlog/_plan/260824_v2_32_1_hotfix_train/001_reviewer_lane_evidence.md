# 001 — Reviewer lane evidence (verbatim)

Four read-only `gpt-5.6-sol` lanes at medium effort ran in parallel on
2026-08-24 against `origin/dev` = `c44e43f00`. Each was given the same packet
shape: read the real diff, read the surrounding source, enumerate unresolved
review blockers verbatim, name existing and missing tests, and return a merge
verdict with `path:line` citations.

Their returns are recorded below unedited. Where the main agent disagreed with a
lane's verdict, the disagreement is recorded in the owning decade doc, not by
editing the lane's text.

## Lane summary

| Lane | Agent | PRs | Verdict |
|------|-------|-----|---------|
| A | Dirac | #2483, #2481 | NEEDS-FIX both (test-matrix gaps + fork CI) |
| B | Ohm | #2473 | NEEDS-FIX (typed 1009 error not plumbed) |
| C | Feynman | #2477 | NEEDS-FIX (foreign tool-type authorization hole confirmed) |
| D | Linnaeus | #2476, #2427 | DEFER / NEEDS-FIX |

The single finding that changes this train's shape is lane C's: the `allowed_tools`
branch of #2477 filters on `name` alone and never inspects `tool.type`, so a
`{type:"file_search", name:"<namespace-wire-name>"}` selector still retains the
alias. The main agent verified this independently against the PR diff before
accepting it.

---

## Lane A — verbatim return

## PR #2483 — fix(anthropic): classify capitalized/dotted Claude ids as adaptive thinking

- **head SHA / base / mergeable:** `3304814c54d32f6d000bf270b29f865b7fa29f86` / `dev` / `MERGEABLE`.
- **WHAT IT CHANGES:**
  - `src/adapters/anthropic.ts:468-478` changes the classifier regex from lowercase/dash-only to case-insensitive dot-or-dash parsing:
    > `/(?:^|\/)claude-([a-z]+)-(\d+)(?:[.-](\d{1,2}))?(?![\d.])/i`
    
    It also normalizes the capture with:
    > `family: match[1]!.toLowerCase()`
  - `tests/anthropic-reasoning.test.ts:53-71` adds adaptive-wire cases for `"Claude-Opus-4.8-joybuilder"` and `"claude-opus-4.8-joybuilder"`, asserting:
    > `expect(b.thinking).toEqual({ type: "adaptive" });`
    >
    > `expect(b.output_config).toEqual({ effort: "xhigh" });`
  - `tests/anthropic-reasoning.test.ts:277-291` adds `"Claude-Opus-4.6-joybuilder"` to the legacy-wire matrix.

- **CORRECTNESS:**
  - The classifier has one direct caller, `meetsFamilyMinimum`, at `src/adapters/anthropic.ts:481-489`:
    > `const parsed = claudeFamilyVersion(modelId);`
  - That shared caller feeds both capability predicates:
    - `usesAdaptiveThinking` at `src/adapters/anthropic.ts:492-494`.
    - `supportsExplicitThinkingDisable` at `src/adapters/anthropic.ts:512-514`.
  - Their runtime callers are respectively `src/adapters/anthropic.ts:932` and `src/adapters/anthropic.ts:929`.
  - The repaired parser classifies capitalized/lowercase dotted and dashed `4.8` as `["opus", 4, 8]`, while both capitalized and lowercase `4-20250514` parse as minor `0`. The `(?![\d.])` guard at `src/adapters/anthropic.ts:472` prevents the date prefix from becoming minor `20`.
  - Wrong classification demonstrably selects the legacy branch: failed `usesAdaptiveThinking(...)` falls through at `src/adapters/anthropic.ts:948-958` to:
    > `body.thinking = { type: "enabled", budget_tokens: budget };`
  - The source records that adaptive families “400 on `thinking.type: "enabled"`” at `src/adapters/anthropic.ts:439-444`. The PR’s live report supplies the exact upstream response:
    > `ValidationException: "thinking.type.enabled" is not supported for this model.`
    >
    > `Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.`
    
    It also reports the same request changed from Bedrock `400` to `200` (`PR body:8-20`). I confirmed the wire-producing path statically; I did not replay the credentialed Bedrock request.

- **GAPS/RISKS:**
  - The parser is shared with explicit-disable classification, but the new capitalization/separator behavior is tested only through adaptive/legacy reasoning. Existing explicit-disable cases remain lowercase at `tests/anthropic-reasoning.test.ts:318-330`; `"Claude-Sonnet-5"` is missing.
  - The acceptance matrix is not completely explicit: lowercase dashed and date-pinned cases exist at `tests/anthropic-reasoning.test.ts:53-59,277-282`, but capitalized dashed and capitalized date-pinned IDs are absent.
  - Current PR checks are only `CodeRabbit`, `enforce-target`, `hygiene`, `label`, and `resolve-pr`; no repository Cross-platform CI/full-suite result is attached.

- **UNRESOLVED REVIEW BLOCKERS:**
  - None. `gh api .../pulls/2483/reviews` returned `[]`; GraphQL returned no review threads. CodeRabbit says:
    > `No actionable comments were generated in the recent review. 🎉`

- **EXISTING TESTS:**
  - `tests/anthropic-reasoning.test.ts:53-71` — adaptive wire matrix.
  - `tests/anthropic-reasoning.test.ts:277-305` — legacy/date-pinned and slash-bearing adaptive cases.
  - `tests/anthropic-reasoning.test.ts:306-335` — explicit-disable caller.
  - PR body reports `bun test tests/anthropic-reasoning.test.ts` → `54 pass`; this was not independently rerun against a checked-out PR head because the lane is read-only.

- **MISSING TESTS:**
  - `BUG-R2483 capitalized and lowercase Claude Opus 4.8 separators select adaptive thinking` — table-test `"Claude-Opus-4-8"`, `"claude-opus-4-8"`, `"Claude-Opus-4.8"`, and `"claude-opus-4.8"`; assert `thinking.adaptive` and `output_config.effort`.
  - `BUG-R2483 capitalized date-pinned Opus remains legacy` — assert `"Claude-Opus-4-20250514"` produces `thinking.enabled`, has `budget_tokens`, and omits `output_config`.
  - `BUG-R2483 capitalized Sonnet 5 supports explicit thinking disable` — exercise the classifier’s second caller with reasoning `"none"` and assert `{ type: "disabled" }`.

- **MERGE VERDICT:** **NEEDS-FIX** (complete the capitalization/separator/date-pinned matrix, cover the second classifier caller, and obtain the required full-suite/Cross-platform CI result).

## PR #2481 — fix(catalog): match selectedModels the way the canonical resolver matches it

- **head SHA / base / mergeable:** `a81275fea06d8fad0c8df18b7eb8f697c3d7e6a3` / `dev` / `MERGEABLE`.
- **WHAT IT CHANGES:**
  - `src/codex/catalog/provider-fetch.ts:44` imports `slugEquivalenceKey`.
  - `src/codex/catalog/provider-fetch.ts:1555-1582` replaces exact native-ID matching:
    > `new Set(sel)` / `allow.has(m.id)`
    
    with canonical routed keys on both sides:
    > `new Set(sel.map(model => slugEquivalenceKey(routedSlug(name, model))))`
    >
    > `allow.has(slugEquivalenceKey(routedSlug(m.provider, m.id)))`
  - `tests/selected-models.test.ts:51-87` adds four ZenMux cases: encoded selector, native selector, mixed selection, and exclusion outside the allowlist.

- **CORRECTNESS:**
  - The codec contract explicitly names OpenRouter, NVIDIA, Together, and Fireworks as slash-ID providers at `src/providers/slug-codec.ts:2-21`. `routedSlug` encodes every inner slash at `src/providers/slug-codec.ts:27-49`.
  - **`/v1/models` listing:** `src/server/index.ts:979-1004` handles the route; `src/server/index.ts:1056-1057` runs:
    > `const goEnabled = filterCatalogVisibleModels(goModels, config);`
    
    Both the Codex `client_version` catalog at `src/server/index.ts:1092-1131` and OpenAI list at `src/server/index.ts:1189-1200` consume that filtered `goOrdered`.
  - **Injected/on-disk Codex catalog:** `src/codex/catalog/sync.ts:1442-1446` performs the same preliminary filter. The later canonical merge already builds selected keys at `src/codex/catalog/sync.ts:819-821` and compares them at `src/codex/catalog/sync.ts:1036-1039`. The PR repairs the earlier filter that could discard the row before this canonical merge.
  - **CLI model removal:** `src/cli/models.ts:271-288` uses a different primitive:
    > `slugEquals(target, model.provider, model.modelId)`
    
    Existing coverage at `tests/cli-models.test.ts:332-346` tests both `"test/openai/gpt-5.5"` and `"test/openai-gpt-5.5"`.
  - **Actual routing:** `src/router.ts:638-665` decodes the routed model portion with:
    > `decodeRoutedModelIdOrThrow(modelId.slice(slash + 1), known)`
    
    Existing coverage at `tests/slug-codec.test.ts:201-209` proves an encoded selector routes to native `"openai/gpt-5.5"`.
  - Therefore all four surfaces recognize normal raw/encoded pairs, but they do **not** share one equivalence helper:
    - listing and injected catalog: `slugEquivalenceKey(routedSlug(...))`;
    - CLI removal: `slugEquals`;
    - routing: `decodeRoutedModelIdOrThrow`.
    
    They share the `slug-codec.ts` module, not one collision policy.

- **GAPS/RISKS:**
  - Collision semantics diverge. `slugEquivalenceKey` deliberately maps `p/a/b` and `p/a-b` to the same key at `src/providers/slug-codec.ts:89-97`, so selecting either can expose both if a provider publishes both native IDs. Routing instead rejects ambiguity at `src/providers/slug-codec.ts:72-80`; tests prove that rejection at `tests/slug-codec.test.ts:211-237`.
  - The new tests call only `filterCatalogVisibleModels` directly and use only ZenMux (`tests/selected-models.test.ts:51-87`). They do not exercise the actual `/v1/models` handler or catalog-sync merge.
  - OpenRouter has static slash IDs at `src/providers/registry.ts:1455-1469`; Together and Fireworks rely on live discovery at `src/providers/registry.ts:2088-2090`; NVIDIA derives known IDs from slash-bearing capability maps at `src/providers/registry.ts:2122-2135`. No PR test covers these four named providers.
  - Current checks still omit Cross-platform CI/full tests.

- **UNRESOLVED REVIEW BLOCKERS:**
  - No formal reviews or review threads exist, and CodeRabbit says:
    > `No actionable comments were generated in the recent review. 🎉`
  - One maintainer comment remains operationally blocking:
    > `포크라서 Cross-platform CI 와 React Doctor 가 action_required 다. ... 리눅스 본 시험이 새 시험을 아직 안 돌렸다. ... 지금 머지하지 말 것.`
    >
    > `포크 Cross-platform CI 를 승인한 뒤 새 시험이 초록이면 머지한다. 지금 머지하지 말 것.`

- **EXISTING TESTS:**
  - `tests/selected-models.test.ts:15-49` — ordinary per-provider allowlist behavior.
  - PR-head `tests/selected-models.test.ts:51-87` — raw/encoded filter behavior.
  - `tests/codex-catalog.test.ts:345-379` — injected catalog provider allowlist, but only plain IDs.
  - `tests/cli-models.test.ts:332-346` — CLI raw/encoded removal.
  - `tests/slug-codec.test.ts:56-115` — codec equivalence and collision primitives.
  - `tests/slug-codec.test.ts:201-237` — routing decode and ambiguity handling.

- **MISSING TESTS:**
  - `BUG-R2481 /v1/models preserves slash-bearing models selected by encoded slug` — route-level request with table rows for `openrouter`, `nvidia`, `together`, and `fireworks`; assert raw and encoded `selectedModels` produce the same listed model.
  - `BUG-R2481 injected Codex catalog preserves encoded selectedModels` — drive the sync/merge path, not the helper alone; assert native and encoded selectors emit the same single catalog slug.
  - `BUG-R2481 selectedModels collision policy matches routing` — fixture containing native IDs `"a/b"` and `"a-b"`; assert the chosen fail-closed/exact-precedence contract consistently across listing, injected catalog, CLI, and routing.
  - A focused cross-surface parity test should hardcode expected outputs rather than deriving them from `slugEquivalenceKey`, preserving oracle independence.

- **MERGE VERDICT:** **NEEDS-FIX** (add `/v1/models` and injected-catalog regressions, define/test collision semantics across the divergent helpers, then satisfy the maintainer’s Cross-platform CI blocker).

`LANE COMPLETE`




## Lane B — verbatim return

(not captured)


## Lane C — verbatim return

## PR #2477 — fix(responses): honor tool_choice for namespace aliases

- Head SHA: `71afa5f145af2bf55bb6503d2d2ea4ea7db7e506`
- Base: `dev` at `c44e43f00f1b8001f30292067324fb419e5ffc86`
- Mergeable: `MERGEABLE`
- Remote `dev`, local `HEAD`, and `origin/dev` all matched `c44e43f00…`.

### WHAT IT CHANGES

- `src/responses/namespace-tool-compat.ts:242-272` (PR head) adds `authorizedAliases()`. It keeps all aliases for absent/`auto`/`required`, none for `none` or malformed/foreign top-level selectors, and filters named selectors:

```ts
if (toolChoice === undefined || toolChoice === "auto" || toolChoice === "required") return aliases;
if (toolChoice === "none" || !isPlainObject(toolChoice)) return new Map();
```

- `src/responses/namespace-tool-compat.ts:319-328` applies the filter after namespace selector rewriting:

```ts
const toolChoice = rewriteToolChoice(body.tool_choice, plan);
// ...
aliases: authorizedAliases(plan.aliases, toolChoice),
```

This replaces current `dev`’s unconditional restoration map:

```ts
// src/responses/namespace-tool-compat.ts:287-295 (dev)
const toolChoice = rewriteToolChoice(body.tool_choice, plan);
// ...
aliases: plan.aliases,
```

- `tests/namespace-tool-compat.test.ts:107-138` adds `"only arms response aliases authorized by tool_choice"`. It covers an allowed `function`, an excluded child, forced-function exclusion, and `"none"`.

### CORRECTNESS

The PR repairs the broad original defect, but does not fully close the authorization boundary.

Alias construction is request-local and maps every non-reserved namespace child’s wire name at `src/responses/namespace-tool-compat.ts:121-142`:

```ts
if (parsed.namespace !== BUILTIN_FUNCTIONS_NAMESPACE) {
  aliases.set(wireName, { namespace: parsed.namespace, name: childName });
}
```

Filtering after `rewriteToolChoice` is correctly ordered: named namespace selectors are converted to wire names at `src/responses/namespace-tool-compat.ts:226-239`, then compared at PR-head lines 319-328.

However, `allowed_tools` authorization still matches by name only at PR-head `src/responses/namespace-tool-compat.ts:260-265`:

```ts
toolChoice.tools
  .filter(tool => isPlainObject(tool) && typeof tool.name === "string")
  .map(tool => tool.name as string)
```

Therefore this input still retains the alias:

```ts
{ type: "file_search", name: "collaboration__safe" }
```

An upstream call can then be recovered into a client namespace call. `src/responses/namespace-tool-compat.ts:354-362` accepts either `function_call` or `custom_tool_call`, looks up only the name, and injects the namespace:

```ts
const identity = aliases.get(value.name);
if (identity) {
  restored.name = identity.name;
  restored.namespace = identity.namespace;
  changed = true;
}
```

That map reaches both transport paths:

- `src/adapters/openai-responses.ts:1754-1760` stores `rewritten.aliases`.
- `src/server/responses/core.ts:3682-3687` applies it to SSE.
- `src/server/responses/core.ts:3911-3914` applies it to JSON.

The undeclared-tool guard does not close this hole. It derives authorization from the complete declared catalog, not `tool_choice`, at `src/server/responses/core.ts:2933-2944`, and accepts a restored namespaced call when its flattened name was declared at `src/server/responses-undeclared-tool-guard.ts:202-208`:

```ts
if (declared.has(name)) return undefined;
if (typeof item.namespace === "string" && declared.has(namespacedToolName(item.namespace, name))) {
  return undefined;
}
```

Selector-type contract:

- Only `function` and `custom` may authorize namespace alias restoration.
- Top-level schema-supported foreign selectors that must not authorize it are `web_search`, `web_search_preview`, `file_search`, `computer_use_preview`, `code_interpreter`, `image_generation`, and `mcp` (`src/responses/schema.ts:115-129`).
- Inside `allowed_tools`, the accepted type is currently unbounded:

```ts
// src/responses/schema.ts:120
const allowedToolEntrySchema = z.object({ type: z.string(), name: z.string().optional() });
```

- Other known non-function/custom kinds present in the runtime include `computer_use`, `image_gen`, `tool_search`, `local_shell`, and `x_search` (`src/server/responses-undeclared-tool-guard.ts:23-37`; `src/responses/parser.ts:147-153`). `namespace`, nested `allowed_tools`, arbitrary strings, and future kinds are also structurally accepted as entries. A strict `function | custom` whitelist therefore closes both current and future variants.

### GAPS/RISKS

- Major: a named foreign-kind entry retains the namespace alias (`src/responses/namespace-tool-compat.ts:260-265`, PR head).
- Impact: a noncanonical upstream can return `{type:"function_call", name:"<retained-wire-name>"}` and have it rewritten to `{namespace, name}` for client execution (`src/responses/namespace-tool-compat.ts:354-362`).
- The added regression uses only `{type:"function"}` and therefore cannot fail when the type check is absent (`tests/namespace-tool-compat.test.ts:117-131`).
- The test checks that the forced-function selector excludes the other alias, but does not assert that the selected alias remains authorized (`tests/namespace-tool-compat.test.ts:133-136`).
- No exact-head cross-platform test run is attached. Fresh check-run inspection showed only hygiene/target/label/resolve and CodeRabbit checks.

Exact minimal patch: in `src/responses/namespace-tool-compat.ts`, function `authorizedAliases`, replace the filter at PR-head lines 263-264 with:

```ts
.filter(tool =>
  isPlainObject(tool)
  && (tool.type === "function" || tool.type === "custom")
  && typeof tool.name === "string",
)
```

No declaration filtering, restoration changes, or new helper is required.

### UNRESOLVED REVIEW BLOCKERS

CodeRabbit unresolved thread at `src/responses/namespace-tool-compat.ts:265`:

> **Reject other tool kinds in `allowed_tools` authorization.**
>
> Lines 261-265 authorize every entry with a string `name`. They do not validate `tool.type`.
>
> A selector such as `{ type: "file_search", name: "collaboration__safe" }` retains the `collaboration__safe` alias. A later `function_call` with that wire name is then restored as a client namespace call. This violates the required behavior for selectors targeting another tool kind.
>
> Keep only `function` and `custom` entries in `authorizedNames`. Add a regression test that uses a foreign tool type and verifies that no alias is returned or restored.

Maintainer review comment:

> allowed_tools 갈래가 이름 문자열만 보고 타입을 안 본다. 코더래빗이 말했다. `{ type: "file_search", name: "collaboration__safe" }` 같은 다른 종류 항목이 그 전선 이름 별칭을 남긴다. 본문이 다른 종류는 빈 지도로 닫겠다고 했는데, allowed_tools 안에서는 그 약속이 깨진다. function 과 custom 만 남기면 된다.

And:

> 시험이 그 갈래를 잠그지 않는다. auto 와 required 와 없는 선택이 별칭을 다 남기는지, 맨 위 file_search 가 빈 지도인지, allowed_tools 안 다른 종류가 별칭을 안 남기는지 없다.

### EXISTING TESTS

- `tests/namespace-tool-compat.test.ts:10-71` — namespace declaration, selector, replay flattening.
- `tests/namespace-tool-compat.test.ts:73-105` — unique, ambiguous, and colliding selectors.
- `tests/namespace-tool-compat.test.ts:107-138` — PR’s authorization test.
- `tests/namespace-tool-compat.test.ts:272-308` — mapped versus unmapped restoration through object/JSON/SSE helpers.
- `tests/responses-parser.test.ts:133-159` — preserves `allowed_tools`.
- `tests/responses-parser.test.ts:161-213` — internal tool bridge filters namespace/custom/tool-search tools by parsed choice.

### MISSING TESTS

- `rejects non-function/custom allowed_tools entries from namespace alias authorization`
  - Table over `web_search`, `web_search_preview`, `file_search`, `computer_use_preview`, `computer_use`, `code_interpreter`, `image_generation`, `image_gen`, `mcp`, `tool_search`, `local_shell`, `x_search`, and an unknown future kind.
  - Each entry carries the exact namespace wire name.
  - Assert `aliases.has(wireName) === false`, `aliases.size === 0`, and restoration of an upstream `function_call` returns `changed === false` with no `namespace`.

- `retains namespace aliases for function and custom allowed_tools entries`
  - Assert both accepted kinds retain their selected aliases and can be restored.
  - This independently proves the whitelist is not deny-all.

- `applies default and foreign top-level alias policies`
  - Assert absent, `"auto"`, and `"required"` retain aliases.
  - Assert `"none"` and top-level `{type:"file_search"}` return an empty map.
  - Assert a forced `function`/`custom` selector retains the selected alias, not merely that it excludes another one.

### MERGE VERDICT: NEEDS-FIX

Require the `function | custom` type whitelist, the hostile foreign-kind restoration regression, and exact-head required CI before merge.

LANE COMPLETE


## Lane D — verbatim return

## PR #2476 — fix(responses): stop rewriting an unchanged snapshot every two seconds

- **head SHA / base / mergeable:** `1c571654cf374afb595d82b6dbf9c7afaf8f4ae5` / `dev@c44e43f00f1b8001f30292067324fb419e5ffc86` / `MERGEABLE`. Branch is `2` commits ahead, `0` behind current `origin/dev`; PR remains Draft with readiness `2/4`.

- **WHAT IT CHANGES:**

  - `src/responses/state.ts:21-26,99-103` adds the 1 MiB scaling threshold, 30-second ceiling, and last-written byte/digest state: `"let lastSnapshotBytes = 0;"`, `"let lastSnapshotDigest: string | null = null;"`.
  - `src/responses/state.ts:802-820` serializes once, computes byte length plus `Bun.hash`, and skips `atomicWriteFileAsync` only when digest and length match **and** `existsSync(path)` is true.
  - `src/responses/state.ts:839-859` adds linear scaling: `"Math.round(SNAPSHOT_DEBOUNCE_MS * (lastSnapshotBytes / SNAPSHOT_DEBOUNCE_SCALE_FROM_BYTES))"` and clamps with `"Math.min(..., SNAPSHOT_DEBOUNCE_MAX_MS)"`.
  - `src/responses/state.ts:1463-1464` resets cached write metadata during the test/process-restart simulation.
  - `tests/responses-state-write-amplification.test.ts:1-149` adds six tests for unchanged/changed writes, deletion recovery, small/large delays, and round-trip validity.
  - `docs-site/src/content/docs/troubleshooting/disk-usage-temp-files.md:53-68` documents that timing derives from the **last written** snapshot and that the first large write may retain the prior short delay.

- **CORRECTNESS:**

  - **(a) Identical payload skips atomic replacement: YES.** `src/responses/state.ts:802-820` says:
    > `const unchanged = lastSnapshotDigest !== null ... && existsSync(path);`  
    > `if (!unchanged) { ... await atomicWriteFileAsync(path, payload); ... }`

    The regression backdates the file and asserts unchanged mtime at `tests/responses-state-write-amplification.test.ts:75-87`.

  - **Externally deleted file trap: HANDLED.** Because skipping requires `existsSync(path)` at `src/responses/state.ts:810-813`, deletion forces a rewrite. The direct regression deletes the file and asserts recreation at `tests/responses-state-write-amplification.test.ts:100-109`.

  - **(b) Debounce scales 2–30 seconds: YES, based on the last successful write.** Constants are `2_000`, 1 MiB, and `30_000` at `src/responses/state.ts:20-26`; scaling and clamping are at `src/responses/state.ts:848-851`; scheduling consumes that result at `src/responses/state.ts:854-859`. Small and ~3.2 MiB cases are covered at `tests/responses-state-write-amplification.test.ts:111-134`.

  - **(c) Existing 24 MiB/TTL/spill/eviction ordering is preserved.** The patch leaves the 24 MiB selection constant at `src/responses/state.ts:32-37`; newest-first selection, 2 MiB per-entry skip, and 24 MiB aggregate stop remain in the same order at `src/responses/state.ts:782-801`. TTL → count → resident spill/demotion ordering remains unchanged at `src/responses/state.ts:994-1027`. Existing spill durability ordering drains deferred unlinks only after a stable snapshot at `src/responses/state.ts:862-876`.

  - **(d) Graceful shutdown bypasses the debounce: YES.** `flushResponseState()` cancels the pending timer and awaits `persistNow(..., true)` at `src/responses/state.ts:885-896`. The unchanged lifecycle calls and awaits it at `src/server/lifecycle.ts:438-447`. “Immediately” here means immediately relative to the pending 2–30 second timer, after the normal turn/shell drain stages.

- **GAPS/RISKS:**

  - A restart forgets the existing file’s size and digest: `clearResponseStateMemoryForTests()` resets both to zero/null at `src/responses/state.ts:1463-1464`, and snapshot loading does not initialize them. Therefore the first post-restart schedule is 2 seconds and its first flush rewrites even unchanged state.
  - External **replacement or modification**, unlike deletion, is not detected. If the path still exists, comparison uses only the in-memory digest of the last payload—not the current disk bytes—at `src/responses/state.ts:802-813`; an externally corrupted/stale file can therefore survive an unchanged flush.
  - Serialization and synchronous hashing still occur before every skip decision at `src/responses/state.ts:802-804`; only atomic replacement is avoided.
  - The “24 MiB cap” remains the existing aggregate-entry budget (`total + size`) at `src/responses/state.ts:795-799`; JSON envelope bytes are outside that counter.

- **UNRESOLVED REVIEW BLOCKERS:**

  - No unresolved inline threads; GraphQL `reviewThreads` returned `[]`.
  - Maintainer process blocker remains unmet:
    > “초안으로 둔다. 지금 머지하지 말 것. 구멍은 맞다. 점검 네 칸과 깃허브 초록, 리눅스 시험이 새 파일을 돌린 뒤에 본다.”

    [Maintainer review comment](https://github.com/lidge-jun/opencodex/pull/2476#issuecomment-5392886362). The PR is still Draft, readiness is `2/4`, and current checks contain hygiene/target/review automation only—no Linux/full-suite execution.

- **EXISTING TESTS:**

  - New: `tests/responses-state-write-amplification.test.ts:75-148`.
  - Spill unlink durability: `tests/responses-state.test.ts:902-913,1216-1234`.
  - TTL/count eviction: `tests/responses-state.test.ts:915-937`.
  - Resident-before-stub eviction ordering: `tests/responses-state.test.ts:1236-1248`.
  - TTL accounting: `tests/responses-state.test.ts:1502-1524`.
  - Snapshot restart/TTL/UTF-8 selection: `tests/responses-state.test.ts:1533`, `1960-1983`, `2465-2472`.
  - Lifecycle shutdown tests exist in `tests/shutdown-drain.test.ts:82-317`, but none asserts response-state persistence.

- **MISSING TESTS:**

  - `test("clamps debounce to exactly 30_000 ms at the snapshot bound")` — build a near-cap persisted snapshot and assert the next scheduled delay equals `30_000`, not merely `<= 30_000`.
  - `test("snapshot selection keeps newest rows and stays within the 24 MiB entry budget")` — cross the total cap and assert newest-first retention plus overflow exclusion.
  - `test("graceful drain flushes pending response state without waiting for the debounce")` — schedule a large-cache write, invoke `drainAndShutdown`, and assert the latest response is on disk before `server.stop`.
  - `test("an externally replaced snapshot is repaired when the in-memory digest is unchanged")` — replace existing bytes without deleting the path and require the next unchanged flush to restore them; this currently fails.

- **MERGE VERDICT:** **DEFER** — the implementation fixes the stated amplification and deletion trap without disturbing persistence ordering, but the maintainer’s exact-head Linux/full-suite gate and readiness requirements remain unmet.

## PR #2427 — fix(test): pass --parallel so the full suite finishes instead of reading as hung

- **head SHA / base / mergeable:** `eb7b101a96bc47ce7c2feb5dca5d337b76346417` / `dev@35a89903ca8f308779b337bf50dd31c2ca2e8763` / `MERGEABLE`.
- Current `origin/dev` is `c44e43f00f1b8001f30292067324fb419e5ffc86`; the PR base/head branch is **6 commits behind** and 5 PR commits ahead (`merge-base=35a89903...`, diverged).

- **WHAT IT CHANGES:**

  - `bunfig.toml:8` documents that file-level `--parallel` must be supplied by `scripts/test.ts`.
  - `scripts/test.ts:62-65` detects caller-supplied `--parallel` only before the `--` delimiter.
  - `scripts/test.ts:68-141` enumerates Bun 1.4.0 options whose separated values must not be mistaken for file filters.
  - `scripts/test.ts:143-156` distinguishes option-only full-suite calls from filtered calls.
  - `scripts/test.ts:168-173` resolves the default argv to:
    > `["--isolate", "--parallel", "./tests/"]`
  - `scripts/test.ts:257-259` changes the actual child invocation from the current-dev form `bun test --isolate ./tests/` (`scripts/test.ts:143-145` on `dev`) to:
    > `[process.execPath, "test", ...resolveBunTestArgs(requestedTests)]`
  - Therefore the exact changed default invocation is:
    > `bun test --isolate --parallel ./tests/`
    
    reached through `bun run test` (`package.json:41`).
  - `tests/test-runner.test.ts:79-163` covers filters, caller concurrency, separated option values, delimiters, exit status, `PARALLEL` output, and unique fixture execution.

- **CORRECTNESS:**

  - The actual spawn path—not merely a helper—is wired to `resolveBunTestArgs` at `scripts/test.ts:251-259`.
  - Explicit `--parallel`/`--parallel=N` is preserved without duplication at `scripts/test.ts:168-173`, covered by `tests/test-runner.test.ts:91-100`.
  - `--timings`, `-c`, and `--config` consume separated values at `scripts/test.ts:71-141`, covered at `tests/test-runner.test.ts:102-127`.
  - Arguments after `--` do not suppress the wrapper’s own parallel flag, covered at `tests/test-runner.test.ts:130-133`.
  - The subprocess regression requires exit `0`, `PARALLEL`, and a unique marker at `tests/test-runner.test.ts:135-163`.
  - Thus it correctly changes the runner from serial isolated file execution to file-parallel isolated execution. It has **not** established a green full-suite outcome.

- **GAPS/RISKS:**

  - The PR body is internally contradictory. It says:
    > “`./node_modules/.bin/bun run test` — 14,484 passed, 11 skipped, **7 failed** across 902 files on the exact head.”
    
    and:
    > “Because the exact-head full-suite invocation itself was not green, the PR remains Draft and the local-CI readiness box remains unchecked.”
    
    Yet the same current body has all four boxes ticked, including:
    > “- [x] All CI tests are green on my local testing.”
    
    and:
    > “- [x] My PR is ready for review.”
    
    These are PR-body lines 13-15 versus 28-32.
  - The PR is no longer Draft, contradicting its own verification statement.
  - The branch is 6 commits behind current `origin/dev`, so the reported suite was neither green nor run on the current integration base.
  - Default parallel execution increases shared external-state contention. The seven exact-head failures may be pre-existing/load-sensitive, but the acceptance invocation changed by this PR must still prove exit `0` on the rebased exact head.

- **UNRESOLVED REVIEW BLOCKERS:**

  - No unresolved inline review threads; GraphQL `reviewThreads` returned `[]`. Earlier argv/test-quality threads were resolved.
  - The remaining maintainer blocker is:
    > “This should remain draft and must not merge until the author completes the readiness checklist, marks it ready, and required cross-platform CI is green on this exact head. A final approval can follow then.”

    [Ingwannu review follow-up](https://github.com/lidge-jun/opencodex/pull/2427#issuecomment-5385679591). The checklist/ready conditions were later asserted, but required cross-platform exact-head CI is still absent, the documented full suite is red, and the branch is now stale.

- **EXISTING TESTS:**

  - Existing environment isolation and Windows profile coverage: `tests/test-runner.test.ts:1-71`.
  - New resolver cases: `tests/test-runner.test.ts:79-133`.
  - New real-wrapper fixture: `tests/test-runner.test.ts:135-163`.
  - Current runner’s isolation, queue, and child-spawn surroundings: `scripts/test.ts:1-60,176-277`.

- **MISSING TESTS:**

  - `test("default runner invocation completes the repository suite under parallel isolation")` — this is best implemented as an exact-head CI acceptance gate, not a recursively spawned unit test; run `bun run test` and require exit `0`.
  - `test("known shared-state-sensitive suites remain green when executed together through the parallel wrapper")` — invoke the previously failing affected files together through `scripts/test.ts` and assert exit `0`, proving parallelism does not expose cross-file state leakage.
  - Cross-platform acceptance is missing entirely: the same exact rebased SHA must run the focused runner test and default `bun run test` on Linux, Windows, and macOS.

- **MERGE VERDICT:** **NEEDS-FIX** — rebase onto `c44e43f00`, restore truthful Draft/readiness state, then obtain a green exact-head `bun run test` plus required cross-platform CI before reticking the checklist.

LANE COMPLETE


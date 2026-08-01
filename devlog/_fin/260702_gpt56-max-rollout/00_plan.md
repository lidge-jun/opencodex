# GPT-5.6 Sol/Terra/Luna + global `max` rollout plan

Date: 2026-07-02
Branch: `codex/gpt-56-max-rollout`
Base: `origin/dev` = `024a929adb9cdad75213e47e1b431a2de8770871`

## Goal

Prepare opencodex so a later rollout can expose GPT-5.6 Sol/Terra/Luna and the
`max` reasoning level with a small switch/default change, while preserving existing
provider routing behavior.

User policy from Interview: expose `max` broadly. The previous blocker was Codex
catalog/parser acceptance, and upstream Codex now accepts `max`.

## Source evidence

- Local OpenAI Codex `main` is fast-forwarded to `origin/main`
  (`129ea2aaf5fb426d8ba683ee53f290742f41dd31`) in
  `/Users/jun/Developer/codex/120_codex-cli`.
- Local source proof:
  `/Users/jun/Developer/codex/120_codex-cli/codex-rs/protocol/src/openai_models.rs`
  now treats `max` as a first-class enum value: `ReasoningEffort::Max` is declared at
  `openai_models.rs:48`, serializes as `"max"` at `openai_models.rs:64`, and parses
  `"max"` at `openai_models.rs:130`. The same enum keeps `ReasoningEffort::Ultra` at
  `openai_models.rs:49` and `Custom(String)` fallback at `openai_models.rs:50` and
  `openai_models.rs:133`.
- Commit boundary from the local Codex history: `8ac304c29` introduced model-defined
  custom efforts, and `80f54d126` made `max` first-class. Current `main` contains both.
  This is the local source-proof that new Codex can parse catalog entries advertising
  `max`.
- The referenced OpenClaw commit `c52583a02270fa61073e9149a3d530bcc6cff227` adds GPT-5.6
  Sol/Terra/Luna, preserves `max` for GPT-5.6, treats `ultra` as orchestration
  metadata rather than a normal OpenAI reasoning effort, and maps
  `input_tokens_details.cache_write_tokens`.
  Source: <https://github.com/openclaw/openclaw/commit/c52583a02270fa61073e9149a3d530bcc6cff227>

## Initial local gaps found during planning

- Native OpenAI/Codex slugs are hard-allowlisted in
  `src/codex-catalog.ts:45` and filtered in `src/codex-catalog.ts:526`.
  Current list lacks `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
- `src/reasoning-effort.ts:4` initially only exposed `low`, `medium`, `high`, `xhigh`.
  `src/reasoning-effort.ts:29` dropped unknown catalog labels, and
  `src/reasoning-effort.ts:53` mapped requested `max` back down to `xhigh`.
- The Responses request parser already accepts `max` at
  `src/responses/parser.ts:207`, so parser support is ahead of catalog support.
- Routed Codex catalog generation currently says provider wire values such as `max`
  must not be advertised (`src/codex-catalog.ts:397`) and applies the sanitized
  levels in `src/codex-catalog.ts:414`.
- Initial provider maps used upstream `max` aliases that need to be replaced by direct
  `max` support:
  `src/providers/registry.ts:54`, `src/providers/registry.ts:58`,
  `src/providers/registry.ts:85`, and `src/providers/registry.ts:320`.
- Kiro initially exposed only `xhigh` in `src/providers/kiro-models.ts:41`, while
  the Kiro adapter already accepted direct `max` in `src/adapters/kiro.ts:163`.
- Anthropic already maps `max` to a larger thinking budget in
  `src/adapters/anthropic.ts:64`.
- OpenAI Responses usage currently reads cache hits but not cache writes in
  `src/server.ts:718`.
- Bare `gpt-*` docs and code disagree: docs say `openai`
  (`docs-site/src/content/docs/guides/model-routing.md:29`), while the router uses
  `chatgpt` (`src/router.ts:15`) and startup auto-creates that provider
  (`src/server.ts:1876`).
- Cursor has no supported surface: docs exclude Cursor at
  `docs-site/src/content/docs/guides/providers.md:91`, and stale Cursor OAuth
  credentials fail as unsupported in `tests/oauth-status-privacy.test.ts:99`.
- `devlog/` is ignored by `.gitignore:6`; track these notes with `git add -f`.

## Scope

IN:

1. Add GPT-5.6 native slug support for:
   - `gpt-5.6-sol`
   - `gpt-5.6-terra`
   - `gpt-5.6-luna`
2. Expose `max` as a Codex-visible reasoning level for reasoning-capable catalog
   entries.
3. Keep `xhigh` working as a compatibility alias and provider-map input.
4. Preserve `max` when a caller explicitly requests it and the selected model/provider
   advertises it.
5. Clamp `max` down only when the model/provider explicitly advertises a smaller
   reasoning set.
6. Keep `ultra` out of the normal reasoning ladder.
7. Update third-party OpenAI-compatible gateway metadata/model surfaces where the repo
   has a supported adapter or generated catalog path.
8. Add GPT-5.6 cache-write accounting from Responses usage payloads.
9. Update docs/tests that still describe the old `low`/`medium`/`high`/`xhigh`-only
   contract.

OUT:

1. Do not add a Cursor adapter in this rollout. Cursor remains a documented unsupported
   proprietary surface until a separate adapter/protocol task exists.
2. Do not default all users to GPT-5.6 yet. Keep the default model policy explicit so
   rollout is a later one-line/small-config switch.
3. Do not expose `ultra` as a normal user-selectable OpenAI reasoning effort.
4. Do not bypass upstream allowlist/access errors. If a user selects GPT-5.6 without
   access, surface the upstream error.

## Diff-level plan

### Phase 1 - reasoning ladder

Modify:

- `src/reasoning-effort.ts`
  - Add `{ effort: "max", description: ... }` after `xhigh`.
  - Include `max` in `CODEX_REASONING_ORDER` via the existing array.
  - Change `requestToCodexEffort("max")` from `"xhigh"` to `"max"`.
  - Keep clamping behavior so a supported list without `max` still falls back to
    `xhigh` or the highest supported lower tier.
  - Update comments that say Codex only accepts `low`/`medium`/`high`/`xhigh`.

- `src/types.ts`
  - Update config docs for `reasoningEfforts` to include `max` as a Codex-supported
    label.

Tests:

- `tests/reasoning-effort.test.ts`
  - Replace the old "strips max" assertion with "keeps max".
  - Add direct `mapReasoningEffort(..., "max")` cases.
  - Keep regression cases proving `xhigh` stays `xhigh` and `max` stays `max`.

### Phase 2 - native GPT-5.6 catalog support

Modify:

- `src/codex-catalog.ts`
  - Add `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` to the supported native slug
    path.
  - Prefer live catalog metadata when present; static fallback should only supply the
    slugs and conservative metadata required for no-catalog environments.
  - Add context/default metadata only if confirmed from the Codex catalog or source
    evidence. Otherwise do not invent context windows.
  - Ensure `filterSupportedNativeSlugs` keeps the three GPT-5.6 slugs and continues to
    drop legacy/internal slugs.

- `src/config.ts`
  - Keep `DEFAULT_SUBAGENT_MODELS` unchanged for now unless rollout explicitly flips it.
  - Record the eventual rollout switch: replace/add GPT-5.6 slugs in
    `DEFAULT_SUBAGENT_MODELS` when access is broadly available.

Tests:

- `tests/codex-catalog.test.ts`
  - Add GPT-5.6 slugs to the native allowlist regression.
  - Add catalog entry coverage showing GPT-5.6 entries can carry `max`.

- `tests/codex-catalog-sync-hardening.test.ts`
  - Ensure sync keeps GPT-5.6 native entries but still drops old internal native slugs.

### Phase 3 - broad provider `max` exposure

Modify:

- `src/providers/registry.ts`
  - Add `max` to reasoning-capable static fallback sets:
    - `ZAI_GLM_52_REASONING_EFFORTS`
    - `UMANS_REASONING_EFFORTS`
    - `UMANS_GLM_REASONING_EFFORTS`
    - other explicit reasoning arrays that currently end at `xhigh` and are not marked
      `noReasoningModels`
  - Remove registry-provided `xhigh: "max"` alias maps now that Codex accepts `max`
    directly.
  - Preserve identity routing: `xhigh` stays `xhigh`, `max` stays `max`.

- `src/providers/kiro-models.ts`
  - Add `max` to `KIRO_REASONING_EFFORTS`.
  - Update the stale comment that says Codex rejects raw `max`.

- `src/codex-catalog.ts`
  - When live OpenAI-compatible model metadata only reports a boolean
    `reasoning_effort`, default to `["low", "medium", "high", "xhigh", "max"]`.
  - Keep `noReasoningModels` and explicit empty arrays as hard opt-outs.

- `src/providers/derive.ts`, `src/oauth/key-providers.ts`, `src/oauth/login-cli.ts`
  - No structural change expected; verify they preserve copied reasoning arrays and maps.

Tests:

- `tests/router.test.ts`
  - Prove registry maps now merge `max` while user overrides still win.

- `tests/kiro-adapter.test.ts`
  - Update expected Kiro efforts to include `max`.
  - Keep the direct `max` request budget behavior.

- `tests/provider-registry-parity.test.ts`
  - Update explicit expected provider arrays that currently stop at `xhigh`.

### Phase 4 - OpenAI-compatible gateway model names

Modify:

- `src/generated/jawcode-model-metadata.ts`
  - Regenerate from the upstream metadata generator, not by hand, if the generator
    source now includes GPT-5.6 Sol/Terra/Luna or updated OpenAI rows.
  - If upstream metadata has not caught up, add a short documented fallback only if this
    project already has a hand-maintained fallback path. Do not edit the generated blob
    manually without updating generator inputs.

- `src/providers/registry.ts`
  - Add GPT-5.6 names to static fallback surfaces that this repo directly owns:
    `openai-apikey` and OpenRouter.
  - Leave LiteLLM/Vercel/self-hosted gateway names to live `/models` discovery unless a
    local static list exists.
  - Do not hand-edit `src/generated/jawcode-model-metadata.ts`; the generator source
    `../jawcode/packages/ai/src/models.json` was not present in this checkout.

- Docs:
  - Fix the `gpt-*` route docs to say the actual built-in route is the ChatGPT/OpenAI
    forward provider path, not a separate `openai` API-key path.
  - Keep Cursor listed as unsupported until adapter work exists.

Tests:

- `tests/provider-registry-parity.test.ts`
  - Update snapshots/metadata expectations after regeneration.

### Phase 5 - sidecars and rollout defaults

Modify:

- `src/web-search/index.ts`
- `src/vision/index.ts`
- `src/server.ts`
- `docs-site/src/content/docs/reference/configuration.md`
- `docs-site/src/content/docs/guides/sidecars.md`
- localized docs that repeat sidecar defaults

Decision:

- Do not automatically switch sidecars from `gpt-5.4-mini` to GPT-5.6 in this patch unless
  GPT-5.6 preview metadata confirms equivalent hosted `web_search` and vision behavior.
- Record the one-line rollout switch as either:
  - update `DEFAULT_SIDECAR_MODEL` / `DEFAULT_VISION_MODEL`, or
  - leave defaults unchanged and document user-overridable sidecar model names.

Tests:

- `tests/web-search.test.ts`
  - Update only if defaults change.

### Phase 6 - cache write accounting

Modify:

- `src/server.ts`
  - Extend `usageFromResponsesPayload` input token details type with
    `cache_write_tokens`.
  - Map it into `cacheCreationInputTokens` or the existing usage field that represents
    cache writes.
  - Keep payloads that omit the field at zero/undefined.

- `src/bridge.ts`, `src/usage-totals.ts`, `src/usage-summary.ts`
  - Verify existing cache-write fields flow through summaries. Modify only if
    `OcxUsage` already distinguishes read/write and the path currently drops writes.

Tests:

- `tests/usage-shape-extraction.test.ts`
- `tests/bridge.test.ts`
- `tests/request-log.test.ts`
  - Add payloads with `input_tokens_details.cache_write_tokens`.

## Rollout switch

After implementation, the rollout should be limited to one of these small changes:

1. Default model switch:
   - update `src/config.ts:146` `DEFAULT_SUBAGENT_MODELS`.
2. Sidecar switch, only if verified:
   - update `src/web-search/index.ts:9`
   - update `src/vision/index.ts:9`
3. Docs/examples switch:
   - update README/docs examples from GPT-5.4/5.5 to GPT-5.6 where appropriate.

The support code should be present before these switches are flipped.

## Verification plan

Targeted:

```bash
bun test tests/reasoning-effort.test.ts \
  tests/codex-catalog.test.ts \
  tests/codex-catalog-sync-hardening.test.ts \
  tests/router.test.ts \
  tests/kiro-adapter.test.ts \
  tests/provider-registry-parity.test.ts \
  tests/usage-shape-extraction.test.ts \
  tests/bridge.test.ts \
  tests/request-log.test.ts
```

Static:

```bash
bun run typecheck
```

Full:

```bash
bun test ./tests/
```

Manual smoke after build:

```bash
ocx /v1/models
ocx /v1/models?client_version=dev
```

Check that:

- GPT-5.6 Sol/Terra/Luna are present when enabled.
- Reasoning-capable routed models expose `max`.
- Explicit no-reasoning models still expose no reasoning control.
- `xhigh` requests still work.
- Direct `max` requests reach upstream as `max` where supported or are clamped only by
  explicit smaller support metadata.

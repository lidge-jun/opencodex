# GPT-5.6 + `max` rollout audit

Date: 2026-07-02
Branch: `codex/gpt-56-max-rollout`

## Audit verdict

Plan is implementation-ready after Interview clarification. The chosen policy is broad
`max` exposure, with `ultra` kept out of the normal reasoning ladder.

This is a C3 cross-module feature with C5 ambiguity resolved by Interview. Build should
not start until this plan has been reviewed once more against the final diff.

## Findings folded into the plan

### 1. Do not skip PABCD Audit

Risk: writing a plan and immediately implementing would skip the PABCD A gate.

Mitigation:

- This file records the first read-only audit pass.
- Before source changes, run one more focused A-gate review of the final intended diff.

Evidence:

- `pabcd/SKILL.md` requires `P -> A -> B -> C -> D`.

### 2. `devlog/` is ignored

Risk: plan files will not be committed unless force-added.

Mitigation:

- Use `git add -f devlog/_fin/260702_gpt56-max-rollout/00_plan.md`
- Use `git add -f devlog/_fin/260702_gpt56-max-rollout/01_audit.md`

Evidence:

- `.gitignore:6`
- `devlog/_chase/README.md:45`

### 3. Legacy `xhigh -> max` compatibility must be removed from new registry defaults

Risk: preserving old registry alias maps would keep silently escalating `xhigh` requests
to upstream `max` even though current Codex can send `max` directly.

Mitigation:

- Remove registry-provided `xhigh: "max"` maps.
- Let the default identity path send `xhigh` as `xhigh` and `max` as `max`.
- Keep tests proving direct `xhigh` and direct `max` do not alias each other.

Evidence:

- `src/providers/registry.ts:54`
- `src/providers/registry.ts:58`
- `src/providers/registry.ts:85`
- `tests/reasoning-effort.test.ts:54`
- `tests/router.test.ts:23`

### 4. Catalog and request parsing are different surfaces

Risk: current released/forked Codex checkouts can still reject `max`, while local
Codex `main`/`origin/main` now parses `"max"` through first-class
`ReasoningEffort::Max` and still keeps `ReasoningEffort::Custom(String)` for future
model-defined effort values. opencodex still strips `max` from catalog metadata.

Mitigation:

- Update both catalog-visible sanitization and request mapping.
- Update tests that currently assert `max` is stripped.

Evidence:

- `src/reasoning-effort.ts:29`
- `src/reasoning-effort.ts:53`
- `src/codex-catalog.ts:397`
- `tests/reasoning-effort.test.ts:274`
- `src/responses/parser.ts:207`
- `/Users/jun/Developer/codex/120_codex-cli/codex-rs/protocol/src/openai_models.rs:48`
- `/Users/jun/Developer/codex/120_codex-cli/codex-rs/protocol/src/openai_models.rs:64`
- `/Users/jun/Developer/codex/120_codex-cli/codex-rs/protocol/src/openai_models.rs:130`
- `/Users/jun/Developer/codex/120_codex-cli/codex-rs/protocol/src/openai_models.rs:133`

### 5. Kiro is now an exposure-policy question, not an adapter blocker

Risk: Kiro previously avoided catalog `max` because Codex rejected it. That reason is
stale, but the adapter does not send a raw upstream reasoning enum.

Mitigation:

- Expose `max` for Kiro as a Codex-visible maximum fake-thinking budget.
- Keep `xhigh` and `max` as distinct labels in the fake-thinking budget map unless a
  future Kiro protocol exposes a real upstream effort enum.

Evidence:

- `src/providers/kiro-models.ts:41`
- `src/providers/kiro-models.ts:43`
- `src/adapters/kiro.ts:163`
- `tests/kiro-adapter.test.ts:479`

### 6. Cursor is not a model-list update surface

Risk: adding Cursor model names without a Cursor adapter creates dead inventory.

Mitigation:

- Keep Cursor as OUT for this rollout.
- Handle OpenAI-compatible gateways that opencodex already supports, such as OpenRouter
  and LiteLLM-compatible endpoints.

Evidence:

- `docs-site/src/content/docs/guides/providers.md:91`
- `tests/oauth-status-privacy.test.ts:99`

### 7. Route docs mismatch actual `gpt-*` routing

Risk: updating only an `openai` API-key story would miss the real bare `gpt-*` passthrough
path.

Mitigation:

- Implement native GPT-5.6 support in the ChatGPT forward/native catalog path.
- Fix docs to align with `chatgpt`/forward behavior.

Evidence:

- `docs-site/src/content/docs/guides/model-routing.md:29`
- `src/router.ts:15`
- `src/server.ts:1876`

### 8. `cache_write_tokens` should be included with GPT-5.6 support

Risk: GPT-5.6 Responses payloads can report cache writes that opencodex currently drops.

Mitigation:

- Extend usage extraction and summaries for `input_tokens_details.cache_write_tokens`.

Evidence:

- `src/server.ts:718`
- OpenClaw commit `c52583a02270fa61073e9149a3d530bcc6cff227`

## Build gate checklist

Before source edits:

- Confirm no unrelated worktree changes.
- Re-open the target source files in the final build turn.
- Run one read-only A-gate review against this plan.

During build:

- Keep source changes grouped by phase.
- Do not edit generated metadata by hand unless the generator inputs are also updated or
  the generated file is the repo's accepted source of truth.
- Keep `ultra` excluded.
- Preserve `xhigh` behavior.

Check:

- Run the targeted Bun tests in `00_plan.md`.
- Run `bun run typecheck`.
- Run full `bun test ./tests/` if targeted tests and typecheck pass.

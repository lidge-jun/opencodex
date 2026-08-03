# wt3 — Provider wire correctness (research)

Executing worktree: `/Users/jun/.codex/worktrees/8e2b/opencodex` (branch `codex/wt3-exec`, off dev@478354ee8). A spare prepared worktree also exists at `/Users/jun/.codex/worktrees/260802-wt3-provider-wire`.
Provider-adapter/wire bugs; all must-fix regardless of PR quality.

## Roadmap map (work-phase → decade doc)

| Work-phase | Bug | Decade doc |
|------------|-----|------------|
| wp-a | A — Copilot mixed-wire (#746/#748) | `010_bug_a_copilot_mixed_wire.md` |
| wp-b | B — DeepSeek service_tier (#860) + #875 triage | `020_bug_b_deepseek_service_tier.md` |
| wp-c | C — Claude 1M windows (#839+#854) | `030_bug_c_claude_1m_windows.md` |
| (follow-up, not this goal) | D — hosted image tools (#616/#837) | to be written when picked up |

## Scope

### Bug A — PR #746 / issue #748: Copilot Responses-only models routed to chat completions

- Root cause: the `github-copilot` preset configures a provider-wide `openai-chat` adapter, but Copilot fronts a mixed-wire catalog; several newer OpenAI models are served only by the Responses API (`model "gpt-5.6-sol" is not accessible via the /chat/completions endpoint`). `gpt-5.4` hides it behind a passing text-only smoke test; a real Codex request (function tools + reasoning effort) fails.
- Grounding: `src/providers/registry.ts`, `src/providers/github-copilot-transport.ts`.
- Severity: high — hard data-plane failure for Copilot users on current models.

### Bug B — PR #860 (+ issue #875): DeepSeek `service_tier` must be capability-gated

- Root cause: `fastMode` injects `service_tier` unconditionally on Responses routes; DeepSeek does not support the field. PR #860 adds a provider-level `supportsServiceTier` capability: canonical OpenAI Responses providers support it, DeepSeek explicitly rejects it (strip the field), unclassified custom providers FAIL CLOSED (strip) unless explicitly configured with `supportsServiceTier: true` — the reviewed final-head semantics, which supersede the PR body's original "preserve caller-supplied values" wording.
- Fresh corroboration: issue #875 (2026-08-02) "DeepSeek V4 Flash Responses route stalls after tool calls" — same wire family; executing session must check whether #875 is the same root cause or a second defect before closing either.
- Grounding: `src/adapters/openai-responses.ts`, `src/server/responses/core.ts`, `src/types.ts`.

### Bug C — PRs #839 / #854: Claude 4.6/4.7 1M context windows missing

- Root cause: `ANTHROPIC_MODEL_CONTEXT_WINDOWS` omits `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, so they advertise `max_input_tokens: null`, `shouldMarkOneMillion()` rejects them, and the `[1m]` picker row is never emitted — Claude Code accounts them at its 200k default. #854 additionally fixes generated profiles writing `[1m]` on sub-1M routes (372K route marked `[1m]`).
- Grounding: `src/claude/context-windows.ts`, `src/claude/model-info.ts`, `src/providers/registry.ts`.
- Note: #839 and #854 overlap; land ONE consolidated fix, credit both PRs.

### Optional — PRs #616 / #837: hosted image tool preferences

- Some gateways reserve the image tool namespace server-side; generic normalization collides with client `image_gen` declarations. #837 already integrates #616 onto current dev preserving authorship. Include if capacity allows.

## Claim ledger

| # | Claim | Source | Status |
|---|-------|--------|--------|
| 1 | Copilot serves some models Responses-only | gpt-5.4 verified (BerriAI/litellm#23332, exact `unsupported_api_for_model` error); gpt-5.6-sol verified to the same standard (JetBrains LLM-29711: function tools + reasoning_effort rejected on `/chat/completions` + pi.dev Responses declaration + #748 field run); same pattern for gpt-5-codex (opencode #2758). Full per-model table below | verified (7 models built-in; nano lead-only, excluded) |
| 2 | DeepSeek rejects/mishandles `service_tier` | Official Responses docs: field unsupported but unsupported params are SILENTLY IGNORED (api-docs.deepseek.com/guides/responses_api/, opened 2026-08-02 by researcher) | resolved — strip as compatibility policy; NOT a 400 and NOT #875's cause |
| 3 | DeepSeek Responses route stalls after tool calls (hosted api.deepseek.com) | Local root cause found: `sanitizeReasoningInputContent()` (`src/adapters/openai-responses.ts:35`, called :1027 for every Responses provider) blanks plaintext reasoning content on continuations; schema supports `reasoning_text` (`src/responses/schema.ts:23`); DeepSeek native contract accepts it. Residual: "no follow-up request sent" piece unexplained locally | verified local defect (separate from #860) + open external residual — fixed in wp-b, #875 commented not closed |
| 4 | Claude Opus 4.6/4.7 + Sonnet 4.6 are documented at 1M context | Anthropic official: Opus 4.6 (1M beta, 2026-02-05), Opus 4.7 (1M, 2026-04-16, migration guide), Sonnet 4.6 (1M beta, 2026-02-17); model overview cross-check | verified |

## Bug A model evidence (consumed by `010_bug_a_copilot_mixed_wire.md`)

Selection rule: built-in = field report in issue #748 AND independent corroboration. Resolver lookup is exact normalized-ID (`trim().toLowerCase()`), so dated/bracket-suffixed IDs intentionally miss.

| Model | #748 field report | Independent corroboration | Status | Built-in |
|---|---|---|---|---|
| `gpt-5.3-codex` | yes (live run) | pi.dev/models/github-copilot/gpt-5-3-codex declares `openai-responses` | field-verified, corroborated | yes |
| `gpt-5.4` | yes (exact tools+reasoning chat failure + successful Responses run) | BerriAI/litellm#23332 (`unsupported_api_for_model`); pi.dev/models/github-copilot/gpt-5-4 | verified Responses-required | yes |
| `gpt-5.4-mini` | yes | pi.dev/models/github-copilot/gpt-5-4-mini | field-verified, corroborated | yes |
| `gpt-5.5` | yes | pi.dev/models/github-copilot/gpt-5-5 | field-verified, corroborated | yes |
| `gpt-5.6-luna` | yes | pi.dev/models/github-copilot/gpt-5-6-luna | field-verified, corroborated | yes |
| `gpt-5.6-sol` | yes (chat rejection + successful Responses run) | pi.dev/models/github-copilot/gpt-5-6-sol declares `openai-responses`; JetBrains LLM-29711 independently shows chat rejects sol under function tools + reasoning_effort (the Codex-agent request shape) | field-verified, corroborated (audit round-2: same evidence class as luna/terra — excluding it applied the rule inconsistently) | yes |
| `gpt-5.6-terra` | yes | pi.dev/models/github-copilot/gpt-5-6-terra | field-verified, corroborated | yes |
| `gpt-5.4-nano` | NO — absent from the 2026-07-30 captured catalog, never field-run | GitHub supported-models list + pi.dev/models/github-copilot/gpt-5-4-nano | lead-only | NO (`modelAdapters` documented) |

Why nano is the only exclusion, given #748 reports seven models: the two-leg rule (field report AND independent corroboration) is applied uniformly — sol meets both legs exactly as luna/terra do, so it is in; nano has no field report (never present in the captured catalog), so it stays out regardless of catalog/metadata labels. Sol's demonstrated chat failure is request-shape-conditional (tools + reasoning), which is precisely the Codex-agent traffic this bug is about; its bare-string default is safe for text-only chat clients because inbound chat is translated to the verified-working Responses wire rather than dropped.

## Bug B research findings (consumed by `020_bug_b_deepseek_service_tier.md`)

2026-08-02, sol-medium researcher; sources inline.

- PR #860's capability design fits this tree and applies cleanly (`git apply --check` passed on the dev lineage). Its file map is adopted with two corrections from its open review threads: the canonical-`openai` test must prove REGISTRY BACKFILL (not hardcode the field), and localized docs must not keep contradictory blanket wording.
- Official DeepSeek Responses docs list `service_tier` as unsupported but say unsupported Responses parameters are SILENTLY IGNORED (api-docs.deepseek.com/guides/responses_api/). Stripping remains sensible compatibility policy, but `service_tier` cannot explain #875's stall.
- #875 root cause (local, separate from #860): the continuation store preserves reasoning items (`src/responses/state.ts:699`, `:806`, `:837`; recorder installed at `src/server/responses/core.ts:1554`), DeepSeek stateless cleanup (`src/adapters/openai-responses.ts:1003`) does not remove them, but then `sanitizeReasoningInputContent()` (`src/adapters/openai-responses.ts:35`, blanks every non-empty reasoning item's `content` to `[]` at :45-56) is invoked at `:1027` for EVERY Responses provider. The function is OpenAI/ChatGPT-backend-motivated but unscoped. The local schema explicitly supports plaintext `{type:"reasoning_text"}` (`src/responses/schema.ts:23`, `:52`), and DeepSeek's native Responses contract accepts plaintext reasoning content — so current ocx deterministically sends DeepSeek an emptied reasoning item on every continuation. DeepSeek's registry `preserveReasoningContentModels` protects only Chat-Completions serialization, not native passthrough.
- Evidence calibration (audit round-1): DeepSeek's Responses docs confirm plaintext reasoning items are accepted and merged into adjacent assistant messages; the must-replay-on-tool-call-continuation rule is explicit only in the CHAT Thinking-Mode docs — mapping it to native Responses is an inference and is labeled as such in code comments.
- Caveat recorded: the reasoning defect only fires once a follow-up request REACHES ocx; it cannot by itself explain #875's "no follow-up HTTP request sent at all" observation, which may be a separate client/SSE handoff issue. #875 stays open with a comment; the reasoning replay defect is fixed here as the local half.

## Out of scope

- New provider presets (covered by separate enhancement PRs).
- Changing the conservative relay capability policy for unknown providers beyond what #860 states.

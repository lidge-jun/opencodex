# 010 — Bug A: Copilot mixed-wire routing (#746 / #748)

Consumed by work-phase wp-a. Verified against dev@478354ee8. Model-by-model evidence and source URLs live in `000_plan.md` (claim ledger + evidence table) — this doc carries only the decision and its implementation consequences.

## Mechanism (decided)

The tree ALREADY owns the correct mechanism; this fix declares data, not new routing:

```text
hard wire pin
→ explicit user modelAdapters
→ registry modelWireDefaults      ← the fix adds entries here
→ provider-wide adapter
```

- `src/providers/registry.ts:101` — registry metadata owns mixed-wire defaults (`modelWireDefaults`).
- `src/providers/registry.ts:140` — registry defaults stay separate from persisted user overrides.
- `src/server/adapter-resolve.ts:14` — resolver implements the precedence above, preserving credentials/base URL through a copy.
- `src/providers/registry.ts:1552` — registry defaults constrained to recognized destinations + the two OpenAI wires.
- `src/server/responses/core.ts:1434` — final route resolves transport, then the effective model adapter.
- `src/providers/github-copilot-transport.ts:29` — transport has no model argument; do NOT branch here.

Rejected alternatives (with reasons): provider-wide `openai-responses` (breaks Copilot's Claude/Gemini/GPT-4/gpt-5-mini chat models); transport-level switch (wrong owner, no model arg); runtime endpoint probing (quota-cost + nondeterminism; live discovery hints are not routing metadata); new config flag (`modelAdapters` is already the operator escape hatch).

## File map

- MODIFY `src/providers/registry.ts` (github-copilot entry at :1470) — add `modelWireDefaults` with the conservative verified set:
  `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` → `"openai-responses"` (bare strings, every inbound — these models are Responses-required for agent traffic; translation keeps text-only chat clients working).
- MODIFY the same entry's cold-start seed. Policy: ADDITIVE update, no removals (the seed is a cold-start fallback under `liveModels: true`; removals buy nothing and risk stale saved-config surprises). Exact before/after:
  - before: `models: ["gpt-4o", "gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4", "gemini-2.5-pro"]`
  - after: `models: ["gpt-4o", "gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4", "gemini-2.5-pro", "gpt-5-mini", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]`
  - `defaultModel: "gpt-4o"` unchanged. `gpt-5-mini` is added as a verified CHAT model (present in #748's captured catalog, chat-served) — it keeps the chat regression fixture honest. `gpt-5.4-nano` is the ONLY lead-only model left out (no field run, absent from the captured catalog); it ships as a documented `modelAdapters` example. `providerConfigSeed()` copies this list into saved config (`src/providers/derive.ts:105`), so every added id has named evidence in `000_plan.md`.
- NEW `tests/github-copilot-wire-defaults.test.ts` — focused suite (cases below).
- DOCS `docs-site/src/content/docs/reference/configuration/providers.md` (the authoritative `modelAdapters` contract lives at its :79) + maintained locale equivalents (ko, ja, zh-cn, ru) — the table currently carries DeepSeek-only wording and would contradict the new Copilot behavior. `docs-site/src/content/docs/guides/providers.md` gets a short routing-precedence note naming the built-in Copilot defaults and the `modelAdapters` escape hatch for lead-only models.
- NO CHANGES: `github-copilot-transport.ts`, `adapter-resolve.ts`, `types.ts`, `derive.ts`. The sampling/credential-replay parts of PR #746 are a separate parity/security unit — out of scope here.

## Selection rule (decision reference; full evidence in `000_plan.md`)

Built-in = field report in issue #748 AND independent corroboration. All seven Responses-required models meet it, including `gpt-5.6-sol`; `gpt-5.4-nano` alone fails it (no field-report leg) and stays out as a documented `modelAdapters` example. Lookup is exact normalized-ID (`trim().toLowerCase()`, `registry.ts:1568`) — no family/snapshot prefix matching.

## Acceptance + activation scenarios

1. `gpt-5.4` via the github-copilot preset resolves to the Responses wire and the upstream request goes to the Responses endpoint, never `/chat/completions`. Activation: captured-upstream-URL test (runtime-wire proof, not just resolver proof).
2. All seven built-in models resolve Responses on all three inbound wires (Responses, Chat Completions, Anthropic inbound). Activation: parametrized resolver + URL tests.
3. Explicit user `modelAdapters` override beats the registry default in BOTH directions: a listed Responses-default model (e.g. `gpt-5.4`) pinned back to chat proves the opt-out direction; an unlisted chat model (e.g. `gpt-5.4-nano`, or seeded `gpt-5-mini`) mapped to Responses proves the opt-in direction. Activation: precedence tests — note `gpt-5.6-sol` cannot serve as the opt-in case because it is itself a default.
4. Chat-served Copilot models (`gpt-4o`, `gpt-4.1`, `gpt-4.1-mini`, `claude-sonnet-4`, `gemini-2.5-pro`, `gpt-5-mini`) still use chat completions. Activation: regression assertions on the seed's chat set (`gpt-5-mini` is newly seeded, not pre-existing — its assertion guards against accidental inclusion in `modelWireDefaults`).
5. Unrelated providers are isolated (no wire change for non-copilot providers with same-named models). Activation: isolation test.
6. Credentials/base URL preserved through the resolved copy. Activation: adapter-resolve test shape per `adapter-resolve.ts:14`.

## Verification gate

`bun test tests/github-copilot-wire-defaults.test.ts` + `bun run typecheck` + `bun run test` (registry is shared) + `bun run privacy:scan`.

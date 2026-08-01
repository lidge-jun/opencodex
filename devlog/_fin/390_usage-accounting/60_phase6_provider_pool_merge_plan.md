# Phase 6 — Provider pool merging in usage summary

## Slice map update (Phase 6 onward)

The Phase 1-5 work shipped the persistence layer, API, GUI, and visual smoke tests. The user
flagged two production bugs after running real `gpt-5.5` traffic through the proxy:

1. Provider rows split per pool account (`chatgpt`, `chatgpt-p104398`, ...) when they should
   collapse to a single pool entry.
2. `Tokens` column is always 0 even for successful gpt-5.5 calls — `usageStatus` ends up
   `unreported` for every entry in `~/.opencodex/usage.jsonl`.

Bug 1 is a clean summary-layer fix. Bug 2 needs diagnostic data first because the chatgpt
internal Responses backend returns a non-standard JSON shape that `applyResponseLogMetadata`
does not recognise.

| Phase | Title | Goal |
|-------|-------|------|
| 60    | Provider pool merge (this doc) | Strip the `-pXXXXXX` log-label suffix in summary aggregation so chatgpt pool accounts collapse to one provider/model row. |
| 70    | Usage capture diagnostic + extraction hardening | Persist a small upstream-shape debug log (gated by env) and broaden `usageFromResponsesPayload` to handle additional shapes (e.g. ChatCompletions-style `prompt_tokens`/`completion_tokens`). |
| 80    | Codex non-streaming fix | Apply the format-specific fix based on Phase 70 evidence, with regression coverage. |

## Phase 6 detail

### Goal

In the Usage tab, both the per-provider table and per-model table currently render one row per
account log-label. Persisted entries should keep the raw `provider` string (it's audit
evidence) but the aggregated summary should normalise `chatgpt-pXXXXXX` to `chatgpt`.

Out of scope: token capture (Phase 7+), CSV export, log rotation.

### Files

#### NEW

- `src/provider-label.ts` (~20 lines)
  - Import `CODEX_ACCOUNT_LOG_LABEL_RE` from `./codex-account-label` (single source of truth
    for the pool suffix shape — `p` + 6 lowercase hex).
  - `export function baseProviderLabel(provider: string): string` — splits on the LAST `-`;
    if the tail matches `CODEX_ACCOUNT_LOG_LABEL_RE`, return the head; else return the
    original. No duplicated regex.

#### MODIFY

- `src/usage-summary.ts`
  - Import `baseProviderLabel`.
  - In `buildModels`, derive `const providerKey = baseProviderLabel(entry.provider);` and use
    `providerKey` for both the map key and the stored `provider` field on the `UsageModel`.
  - In `buildProviders`, same change: use the base label as key and stored provider.
  - Day grid and totals don't surface provider, so they're untouched.

#### TEST (NEW)

- `tests/usage-provider-label.test.ts` (~15 lines)
  - `baseProviderLabel("chatgpt")` → `"chatgpt"`
  - `baseProviderLabel("chatgpt-p104398")` → `"chatgpt"`
  - `baseProviderLabel("chatgpt-pabc123")` → `"chatgpt"` (lowercase hex — matches the
    `CODEX_ACCOUNT_LOG_LABEL_RE` production shape)
  - `baseProviderLabel("chatgpt-pABC123")` → `"chatgpt-pABC123"` (uppercase does NOT match;
    suffix kept verbatim)
  - `baseProviderLabel("openai")` → `"openai"`
  - `baseProviderLabel("anthropic-claude")` → `"anthropic-claude"` (no strip — not the pool
    pattern)

- `tests/usage-summary.test.ts` (MODIFY)
  - Add a `summarizeUsage merges pool accounts` test: feed two entries with providers
    `"chatgpt"` and `"chatgpt-p104398"` (same model `gpt-5.5`), assert resulting `models` has
    ONE row with `provider: "chatgpt"` and `requests: 2`; `providers` has ONE row with
    `provider: "chatgpt"` and `requests: 2`.

### Verification

- `npm test -- tests/usage-provider-label.test.ts tests/usage-summary.test.ts`
- `npx tsc --noEmit -p tsconfig.json`
- Manual: after restart, GUI Usage tab shows a single `chatgpt` row aggregating both
  `chatgpt` (147) and `chatgpt-p104398` (2) — visual smoke via browser snapshot.

### Atomic commits

1. `feat(usage): merge codex pool log-label suffix in summary aggregation`
   - `src/provider-label.ts` (new)
   - `src/usage-summary.ts` (modified)
   - `tests/usage-provider-label.test.ts` (new)
   - `tests/usage-summary.test.ts` (modified)

2. `docs(usage): Phase 6 plan for provider pool merging`
   - This file.

### Risks

- Stripping the suffix in summary loses per-account visibility there. Acceptable for v1 —
  per-account view can come back as a sub-filter later. The raw `provider` in
  `usage.jsonl` keeps audit fidelity.
- Regex is imported directly from `codex-account-label.ts` so there is no duplicated
  pattern to drift. If the production label shape ever changes, `provider-label.ts`
  follows automatically. The lowercase-only test plus the uppercase-not-stripped negative
  test guard against accidental regex broadening.

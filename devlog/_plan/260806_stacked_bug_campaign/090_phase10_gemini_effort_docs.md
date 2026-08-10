# 090 — Phase 10: Gemini/CCA reasoning-effort docs and coverage (PR #978)

Credit: **Pranav Yerramaneni** (`devmello <email from PR head>`), PR #978.
Adoption: **adapted** — runtime kept, documentation and coverage corrected.

## Defect

`thinkingLevel` was sent only for a narrow model set, so any Google model with a
declared effort ladder silently ignored the selected reasoning effort.

## Why adapted

The runtime gate at `src/adapters/google.ts:343-360` is sound and stays. What
lags is the contract: the docs do not say that **both** `reasoningEfforts` and
`modelReasoningEfforts` assert capability, nor that CCA uses its own
envelope-specific path — and the test suite has no provider-wide positive case,
only the image-adjacent one.

## Change

| Path | Op | Content |
|------|----|---------|
| `src/adapters/google.ts` | KEEP | `:343-360` as authored |
| `docs-site/src/content/docs/reference/configuration/providers.md` | MODIFY | `:83-84` — both ladder sources assert capability; CCA uses the envelope-specific path |
| `tests/google-hardening.test.ts` | MODIFY | Add the provider-wide non-image positive case beside the existing direct-AI-Studio `thinkingLevel` test at `:284` (the file ends at `:346`) |

## Verification

- `bun test tests/google-hardening.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

## PR

Stack 09, base = stack 08 head. Credits Pranav Yerramaneni.

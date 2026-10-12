# 000 — Release train 5, lane rt5-reasoning-zen

Routed providers that stream raw chain of thought (openai-chat `reasoning_content`, kiro tags,
direct Gemini thought parts) reach Responses clients as `response.reasoning_text.*` frames and
`reasoning_text` content parts. The ChatGPT iOS app in Remote Mode renders those inline (#6122).
This unit lands an opt-in provider option, `hideRawReasoning`, that suppresses the raw channel
while provider-authored summaries keep streaming, carried from #6123 with a corrected contract.
The second assigned item, keyless OpenCode Zen (#5995), is dropped for this train; the reason is
recorded in [020](020_zen_keyless_disposition.md).

## Loop spec

- Loop archetype: satisfy-spec, two work-phases after this docs-first roadmap cycle.
- Trigger: coordinator lane packet for release train 5 (items #6123, #5995).
- Goal: #6123 in an open PR against `dev` with green Ubuntu CI; #5995 landed or dropped with a reason.
- Non-goals: GUI changes, changing the default reasoning display, server-only replay redesign,
  pushing to or commenting on contributor PRs, merging.
- Verifier: `bun run typecheck`; focused files listed in 010; `bun run test:changed`;
  `bun run structure:check`; `bun run privacy:scan`; exact-head Ubuntu PR CI.
- Stop condition: 010 PR open with green Ubuntu CI and 020 disposition recorded.
- Memory artifact: this unit; goalplan `.codexclaw/goalplans/rt5-reasoning-zen-land-6123-narrow-hiderawreason/`.
- Expected terminal outcomes: DONE (PR green, drop recorded); BLOCKED if CI fails for reasons
  outside the lane after two repairs.
- Escalation: coordinator review for the `src/server/auth-cors.ts` field-policy line (security
  surface by path) and for the #5995 drop.

## Work-phase map (dependency order)

| Phase | Doc | Outcome |
|---|---|---|
| wp0 | this file | roadmap locked |
| wp1 | [010](010_hide_raw_reasoning.md) | carry #6123 onto fresh `dev`, fix the envelope wording, PR + CI |
| wp2 | [020](020_zen_keyless_disposition.md) | #5995 disposition recorded (drop), no code |

## Evidence

- Discovery packets from two read-only explorers (session-local), summarised in 010 and 020.
- #6123 head `61f8400b58`; #5995 head `25ccb594a3`; base `origin/dev` `cbe0d40daf`.

## Architect consultation

Architect handles: explorer `01a0e6e9-f7aa-76a2-b5ac-56b249c9723e` (reasoning wire) and
`01a0e6e9-fa65-7e20-8192-b9ef9da3831c` (Zen). Decisions and dispositions are listed in 010/020.

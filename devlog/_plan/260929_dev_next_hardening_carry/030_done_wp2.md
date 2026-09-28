# 030 Done (wp2): Claude request-contract hardening

`src/adapters/anthropic-model-contract.ts` now encodes the family table measured live on 2026-09-29
(010 plan, plus a follow-up probe of the 4.5/4.6 families):

| Rule | Families | Before | After |
|---|---|---|---|
| Drop `temperature`/`top_p` | Opus 4.7+, Sonnet 5+, every Fable | kept unless thinking was sent; 400 "temperature is deprecated" | dropped; 200 |
| Keep one sampling field | Haiku 4.5, Sonnet 4.5/4.6, Opus 4.5/4.6 | both sent; 400 "cannot both be specified" | `top_p` dropped when both present; 200 |
| Forced `tool_choice` -> `auto` | adds Fable 5.1 (with Opus 5.5, Sonnet 5.5+) | `any`; 400 | `auto`; 200 |
| Sidecar thinking-off | Opus 5.5, Fable | `thinking: disabled`; 400 | `output_config.effort: low`, no `thinking`; 200 end_turn at 1,024 tokens |

Adapter-built requests re-probed after the change: temperature+top_p, required tool choice and the
sidecar off switch return 200 on Opus 5.5, Fable 5.1, Fable 5, Opus 5, Sonnet 5, Sonnet 5.5, Opus 4.8;
Haiku 4.5 needed the combined-sampling rule and returns 200 with it. Unmeasured older ids
(`claude-3-7-sonnet`, `claude-opus-4-20250514`, Opus 4.1 which 404s on this account) keep both fields.

Tests: `tests/adapters/anthropic/anthropic-sonnet-5-5-contract.test.ts` pins the table;
`anthropic-reasoning.test.ts` updated where it asserted the rejected wire shapes (Fable 5 temperature,
Sonnet 4.5 temperature+top_p).

# 060 Plan (wp3): preemptive Opus 5.5 rows

050 closed with Kiro, opencode-zen/go and three fast tiers "not added" because the providers had
not published Opus 5.5. On 2026-09-23 the user asked to add them ahead of the providers
("우리가 선으로"). Direction changes from evidence-gated to preemptive for these rows only, each
labelled as such.

| Site | Entry | Numbers | Note |
|---|---|---|---|
| `src/providers/kiro-models.ts` | `claude-opus-5.5` in `KIRO_MODELS` and context map | 1_000_000 | Kiro spelling (dot), mirrors claude-opus-5; visible in the static Kiro list, so a call can fail until Kiro ships it |
| `src/adapters/kiro/reasoning.ts` | `KIRO_NATIVE_EFFORT_FIELDS["claude-opus-5.5"] = "output_config"` | low..max | same native field as Opus 5 |
| snapshot `opencode-zen` | `claude-opus-5-5` from its claude-opus-5 row | 4 / 20 / 0.2 / 5, 1M / 128K | Zen roster is live, row inert until listed |
| snapshot `openrouter` | `anthropic/claude-opus-5.5-fast` from its opus-5-fast row | 8 / 40 / 0.4 / 10 | Anthropic fast price |
| snapshot `kilo` | `anthropic/claude-opus-5.5-fast` | 8 / 40 / 0.4 / 10, 1M / 128K | Kilo's 5.5 row carries list price |
| snapshot `venice` | `claude-opus-5-5-fast` | 9.6 / 48 / 0.48 / 12, 1M / 128K | Venice 1.2x markup derived from its 5.5 row |

opencode-go is excluded: it carries no Claude model at all, so there is no Opus row to follow.
Kiro price: no overlay; `claude-opus-5.5` resolves through the vendor fallback's dot-to-dash step.

Tests: kiro-adapter.test.ts is at its 2050-line cap, so `claude-opus-5.5` joins the existing
native-effort and 1M-context id lists in place. usage-cost asserts kiro, opencode-zen and the
OpenRouter fast row. Verify: kiro dir, usage-cost, metadata sync, registry parity, ratchet,
layout, typecheck, structure:check, privacy:scan. Then PR to dev and merge.


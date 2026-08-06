# 001 — Upstream evidence gathered before writing any patch

Two `gpt-5.6-luna` search lanes ran against primary vendor sources. Both changed
the plan, and one of them stopped a layer outright.

## DeepSeek reasoning ladder (#1057) — CONFIRMED, and worse than reported

Source: [api-docs.deepseek.com/guides/thinking_mode](https://api-docs.deepseek.com/guides/thinking_mode/),
observed 2026-08-06. The Chinese mirror agrees verbatim.

| requested | `deepseek-v4-flash` | `deepseek-v4-pro` |
|---|---|---|
| `low` | `low` | `high` |
| `high` | `high` | `high` |
| `xhigh` | `high` | `max` |
| `max` | `max` | `max` |

The page carries a footnote: *"We will update the actual mapped effort of
deepseek-v4-pro in early August 2026."* The Chinese page says the same.

Three things follow, none of which were visible from the issue alone.

**The two models do not share a mapping.** `xhigh` resolves to `high` on Flash and
`max` on Pro; `low` resolves to `low` on Flash and `high` on Pro. Our code applies
one shared `DEEPSEEK_THINKING_REASONING_MAP` to both
(`src/providers/registry.ts:353-360`). A single corrected constant would fix Pro
and break Flash, or the reverse. The fix has to split the map per model.

**The reporter's requested mapping is right for Pro and wrong for Flash.** #1057
asks for `low -> low`. That is Flash's documented behavior. On Pro, DeepSeek
itself maps `low -> high`, so advertising `low` as a native Pro tier would promise
a level the vendor does not honor.

**The vendor is about to change it.** The footnote says Pro's mapping updates in
early August 2026 — which is now. Pinning Pro's map today means pinning a value
the vendor has announced it will move. That is a reason to be conservative about
Pro, not a reason to wait: the advertised *ladder* (`low/high/max`) is stable in
both columns; only Pro's internal resolution of `low` and `xhigh` is in flux.

`medium` has no row in either table. Our map currently sends `medium -> high`
for both models. That is a local compatibility choice, not a documented vendor
behavior, and the decade doc must say so rather than implying the vendor blessed it.

## OpenCode Zen free models (#1043) — NOT verifiable, layer blocked

Source: [opencode.ai/docs/zen](https://opencode.ai/docs/zen), observed 2026-08-06.

The official page lists eight free model IDs:

```
big-pickle              mimo-v2.5-free          laguna-s-2.1-free
ling-3.0-flash-free     longcat-2.0-free        north-mini-code-free
nemotron-3-ultra-free   deepseek-v4-flash-free
```

It does **not** publish input modality for any of them. The lane checked the live
`/v1/models` endpoint, a community lesson page, and a third-party catalog; none
produced an authoritative per-ID modality. Its verdict was `unknown` for all
eight, with one community report that the free MiMo model refuses images —
suggestive, not sufficient.

This blocks the narrow fix as designed. The narrow fix means adding zen model IDs
to `noVisionModels`, and a model on that list gets its images replaced with a
caption or an omission marker before the request goes upstream
(`src/vision/index.ts:447-471`). Guessing wrong in the text-only direction
silently degrades a working vision model — the exact failure the registry comments
warn about at `src/providers/registry.ts:542-554`.

What is *not* blocked: `deepseek-v4-flash-free` is already classified text-only
through `OPENCODE_FREE_DEEPSEEK_MODELS`, and the sibling `opencode-free` provider
at `src/providers/registry.ts:1655-1671` already carries a `noVisionModels` list
against the same base URL. The registry's own DeepSeek modality table also states
`"deepseek-v4-flash": ["text"]` at `src/providers/registry.ts:470`.

**Resolved by measurement.** Rather than ship the narrow-but-partial version, the
eight models were probed directly against the live endpoint. See `002` — six are
text-only, two accept images, and the reporter's exact error was reproduced on
`big-pickle`. The layer is no longer blocked and no ID is guessed.

## What this changes in the layer map

| Layer | Before this research | After |
|-------|---------------------|-------|
| #1057 | one-line constant change | per-model map split + config migration |
| #1043 | add zen IDs to `noVisionModels` | 6 measured text-only IDs; 2 measured vision-capable and deliberately excluded (`002`) |
| #1061 | unchanged | unchanged |
| #1046 | call the existing handler | warning-only variant; the `restart` branch is not startup-safe |

The #1043 downgrade is the one worth stating plainly. The triage called it a real
open defect and it is; what the search lane established is that we cannot close it
correctly today without evidence nobody has published. Shipping a guess would
trade a loud 400 for a silent capability loss.

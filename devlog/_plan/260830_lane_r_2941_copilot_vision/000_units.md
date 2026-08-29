# Lane R / #2941 — Copilot vision models are cataloged text-only

## The report

Every `github-copilot` model arrives in the catalog with `inputModalities: ["text"]`, so Codex refuses image attachments with "This model does not support image inputs" on 32+ models that do accept them (Claude Opus/Sonnet, GPT-4o/4.1/5.x, Gemini, Grok). The same model reached through `openrouter` accepts images, which is what makes this clearly a metadata defect rather than an upstream limitation.

## Why every path returns nothing

Copilot's `/models` endpoint nests the flag one level deeper than the flat form the parser reads. No other checked-in fixture uses this shape, which is all a repository search can establish — it says nothing about what other live catalogs return:

```json
{
  "id": "claude-opus-4.6",
  "capabilities": {
    "supports": { "vision": true },
    "limits": { "vision": { "max_prompt_images": 20 } }
  }
}
```

`modelInputModalities()` in `src/codex/catalog/provider-fetch.ts` tries three signals and all three miss:

- `item.input_modalities` / `item.modalities` — Copilot emits neither.
- `capabilityRecord?.vision` — `capabilityRecord` is the `capabilities` object itself, so its keys are `supports` and `limits`. `.vision` is `undefined`.
- the `capabilities` string array — `supports` is an object, not the literal `true` that scan looks for.

The fallback chain then lands on `["text"]`.

Note the shape carries a second `vision` key under `limits`. Any fix that searches loosely for "a vision key somewhere in capabilities" would find `limits.vision`, which is an object describing image count — truthy, and meaningless as a capability signal.

## Outcome: #2943 shipped the fix, this unit adds the missing coverage

@Ingwannu opened #2943 for the same defect 17 minutes before my #2944. Their implementation landed as `370052648`, and it is better than mine on one case that matters — see the precedence section below. My unit reduced to the tests and the explanatory comment.

## Fix

Read the nested boolean, positioned after the explicit-modality and architecture signals, with precedence **by specificity**: a flat `capabilities.vision` boolean is authoritative whenever present, the nested `supports.vision` boolean is consulted only otherwise, and a non-boolean at either level decides nothing so the remaining signals still apply.

**The read is not scoped to `github-copilot`, and that is deliberate rather than overlooked.** `modelInputModalities` never receives a provider name, and the nested field is the same kind of evidence wherever it appears — a boolean statement about one model. Scoping it would mean a provider reporting the identical shape gets a worse answer for no reason. What the choice does mean is that any provider emitting `capabilities.supports.vision` as a boolean now has it honoured, so the nested field must behave **exactly** like the flat field it stands in for. That equivalence is pinned by a test comparing both shapes against the same loose capability-array claim.

Strictness matters in both directions. A truthy test would let the string `"yes"` advertise image support, and coercing a non-record `supports` into a denial would suppress a `features: ["vision"]` signal that is still valid.

## The precedence mistake, recorded because it nearly shipped

I first wrote the denial as `flat === false || nested === false` — deny-wins across both sources. It reads as the safe direction and is not.

On a provider reporting flat `vision: true` with nested `supports: { vision: false }`, deny-wins returns `["text"]` where the old code returned `["text", "image"]`. That is a silent behaviour change in a parser shared by **every** provider, shipped by a patch whose entire purpose was to stop models being wrongly marked text-only. Eleven of twelve capability shapes agree between the two resolutions; that one does not, and it is the one that would have caused a regression.

A differential probe over both resolutions is what surfaced it — not review, and not green tests, since neither suite covered a disagreeing pair. The case is now pinned: reintroducing deny-wins turns `a flat vision boolean outranks a disagreeing nested one` red.

## Rejected: a registry seed

The issue offers "just add `modelInputModalities` to the `github-copilot` registry entry" as the easier route.

An audit pushed back on my first reason for rejecting it, correctly. `modelInputModalities` is a **per-model** map, not a provider-wide boolean, and other providers do seed selectively — xAI lists specific verified vision ids. So "Copilot serves both vision and text-only models" does not by itself rule out a seed, and a selective one would even help during first start or degraded `/models` discovery, since the registry model list is explicitly a cold-start fallback.

The real reason to omit it here is narrower: **a seed is only as good as the audited list behind it, and no verified model-by-model Copilot vision list exists.** Writing one from the 32 models named in the issue would be guesswork duplicating a remote catalog that changes without us. A selective seed remains a legitimate follow-up for whoever can audit the list.

One qualifier on "parse what upstream reports": it is the best per-model evidence available, not an oracle. When two upstream forms disagree the output can still be internally contradictory — a model can end up with `inputModalities: ["text"]` next to `capabilities: ["vision"]`. That contradiction predates this work (flat `false` has always beaten a capability-array `"vision"` string) and is left alone here rather than fixed silently under a Copilot ticket. Resolving how a boolean denial and a loose capability list should reconcile is its own unit.

## Tests

`tests/provider-model-discovery-contract.test.ts`, using the reporter's exact payload including the `limits.vision` sibling.

| Mutation | Expected |
|---|---|
| remove the nested read entirely (pre-fix state) | tri-state test red — reproduces the report |
| drop `nestedVision === false` | tri-state test red |
| `Boolean(nestedVision)` instead of `=== true` | malformed-hint test red |
| move the nested read above the explicit-modality return | precedence test red |

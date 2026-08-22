# 000 — 260811-gpt56-cyber-model: Plan

## Objective

Register OpenAI's two Daybreak models on the keyed OpenAI provider under their
**alias** slugs, `daybreak-red-latest` and `daybreak-blue-latest`.

### Why the alias, not the snapshot

The request evolved across three turns: first "Daybreak Red and Blue", then
"just add cyber for now", then — decisively — *put the alias slugs in, don't
pin `gpt-5.6-sol`, because the alias is the name OpenAI keeps swapping the model
behind.*

That last instruction is the correct read of the source, and it reverses an
earlier decision in this unit. The `-latest` aliases are the stable contract:

- `daybreak-red-latest` → default snapshot `gpt-5.6-cyber` today.
- `daybreak-blue-latest` → default snapshot `gpt-5.6-sol` today.

"Today" is the whole point. Both pages carry a Snapshots section whose stated
purpose is that a snapshot "lock[s] in a specific version of the model so that
performance and behavior remain consistent" — which is precisely what we do
**not** want here. Registering `gpt-5.6-cyber` would freeze the row at the
current snapshot and go stale the moment OpenAI repoints the alias; registering
`daybreak-red-latest` inherits every future swap for free.

It also settles the earlier objection to Blue. Adding `gpt-5.6-sol` a second
time would have been redundant, so Blue was dropped. `daybreak-blue-latest` is
*not* redundant: it is a distinct, separately-provisioned endpoint whose
safeguards are "calibrated for defensive cybersecurity work", and whose target
model will drift away from `gpt-5.6-sol` over time. Both aliases go in.

Snapshot ids (`gpt-5.6-cyber`) stay out of the registry entirely — no value in
carrying a name that ages badly when the alias covers it.

### Evidence base (primary sources, opened 2026-08-11)

| Fact | `daybreak-red-latest` | `daybreak-blue-latest` |
|------|----------------------|------------------------|
| Default snapshot | `gpt-5.6-cyber` | `gpt-5.6-sol` |
| Context window | 400,000 | 1,050,000 |
| Max input tokens | 272,000 | 922,000 |
| Max output tokens | 128,000 | 128,000 |
| Input modalities | text, image | text, image |
| Reasoning tokens | supported | supported |
| Effort ladder | not published | not published |
| Chat Completions | **Not supported** | **Not supported** |
| Responses | Supported | Supported |
| Access | separate Daybreak approval/provisioning | same |

Sources, all opened 2026-08-11:
`developers.openai.com/api/docs/models/daybreak-red-latest.md`,
`.../daybreak-blue-latest.md`, `.../models.md` (catalog lines 30-31),
`.../pricing.md` (Cyber models table, lines ~200-208).

Two constraints do real work here:

1. **Responses-only.** Both endpoint tables mark `v1/chat/completions` as
   Not supported. This decides which provider may carry the rows.
2. **Blue's metadata equals `gpt-5.6-sol`'s** (1,050,000 / 922,000), while Red
   matches the cyber snapshot (400,000 / 272,000). The alias inherits its
   current snapshot's numbers, so these values are themselves snapshot-dated
   and will need a refresh when OpenAI repoints an alias.

### Pricing correction

An earlier draft of this unit put `gpt-5.6-cyber` in
`OPENAI_GPT56_CONTEXT_MODELS`, inheriting the family's ">272K = 2× input /
1.5× output" long-context tier. Re-reading the grouped pricing table disproves
that: the cyber row's four long-context columns are all `-`, i.e. **no published
long-context tier**. `gpt-5.6-sol` by contrast publishes the full long row
($10/$1/$12.50/$45). So Red gets no tier row, and the earlier defensive-tier
rationale is withdrawn rather than carried forward.

## Loop-spec

- Loop archetype: verifier-defined (`bun run typecheck` + `bun run test`).
- Write scope: `src/providers/registry.ts`, `src/usage/expected-prices.ts`,
  `tests/provider-registry-parity.test.ts`, `tests/codex-catalog.test.ts`,
  `tests/usage-cost.test.ts`, this devlog unit.
- Out of scope, with reasons:
  - **`grok-4.6` — disproved, do not add.** The user asked for it, and it does
    not exist. `docs.x.ai/developers/models/grok-4.6.md` returns 404, the
    non-`.md` page 307-redirects to the model index instead of resolving,
    `docs.x.ai/llms.txt` contains zero `grok-4.6` occurrences (it tops out at
    `grok-4.5`), and `x.ai/news/grok-4-6` returns 403 with no such announcement.
    Four independent research lanes (official docs, GitHub, aggregators,
    LiteLLM/OpenRouter/Cursor registries) each reported the same absence.
    Inventing the slug would seed a fabricated model id into the catalog, which
    is exactly what the registry's docs-backed-refresh convention forbids.
  - **Snapshot ids (`gpt-5.6-cyber`, `gpt-5.5-cyber`, `gpt-5.4-cyber`).** The
    aliases cover them and keep covering them after a repoint; a pinned snapshot
    row would go stale silently. `gpt-5.4-cyber` additionally publishes no
    pricing at all (all cells `-`).
  - **The Codex-login native catalog** (`src/codex/catalog/native-models.ts`).
    Daybreak needs separate API provisioning and is absent from the ChatGPT
    Codex-login upstream snapshot; a bare slug there would advertise a model the
    login path cannot route.
- Budget: single work-phase, single cycle.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp-cyber-model | `010_phase1.md` | Register both Daybreak alias slugs on `openai-apikey` + pricing | — |

## Accept criteria

- `daybreak-red-latest` (400,000 context / 272,000 max input) and
  `daybreak-blue-latest` (1,050,000 / 922,000) are both selectable on the
  `openai-apikey` provider with text+image modalities.
- No snapshot id (`gpt-5.6-cyber` and the older `-cyber` rows) enters the
  registry: the aliases are the only names carried.
- Neither alias advertises a reasoning-effort ladder: no published ladder exists
  on either page, so `modelReasoningEfforts` carries an explicit `[]` for both
  ids. Omitting the key would fall back to the full routed ladder
  (`src/reasoning-effort.ts:76-78`, `src/codex/catalog/effort.ts:143-149`), so
  the catalog rows must assert `reasoningEfforts: []`.
- Pricing is pinned by value, not just by presence: Red's exact
  `12.5 / 75 / 1.25 / 15.625` tuple and Blue's `5 / 30 / 0.5 / 6.25`, both with
  `status: "verified-derived"` — an alias price is its snapshot's price, and that
  status is what keeps the `estimated` marker on (`src/usage/cost.ts:314-315`).
- Long-context tiers follow the published table, not the family default: Blue
  gets the 272,000 exclusive tier (it publishes a full long row), Red gets
  **none** (its long columns are all `-`).
- The Blue tier is scoped to `openai-apikey` only. It must not join the shared
  `OPENAI_GPT56_CONTEXT_MODELS` list, which expands across both `openai` and
  `openai-apikey` and would mint a tier for a Codex-login row that cannot exist.
- The model is **not** added to any chat-completions provider (Responses-only).
- `bun run typecheck` clean; `bun run test` green.
- No `grok-4.6` string in `src/`, `gui/src/`, `scripts/`, or `tests/`. This
  devlog unit is exempt — it documents the rejection, so it names the slug.

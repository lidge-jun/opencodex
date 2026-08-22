# 003 — Audit synthesis, round 1 (REVIEW-SYNTHESIS-01)

Reviewer: independent `explorer` on `gpt-5.6-sol` (medium effort).
Verdict: **FAIL**, 9 blockers (3 High, 4 Medium, 2 Low).

The reviewer confirmed the baseline defect — 17 catalog rows, 0 surviving the
current filter — and then found that the proposed repair would have shipped two
regressions. Every High blocker was re-verified independently against the code
before acceptance; none are taken on the reviewer's word.

## B1 (High) — ACCEPTED. Matching a catalog row silently removes `tools:true`

`src/routing/capability.ts:178`:

```ts
    || (catalogRow === undefined && provider !== undefined && TOOL_CAPABLE_ADAPTERS.has(provider.adapter))
```

The adapter fallback is gated on the catalog row being **absent**. That gate is
harmless today only because the lookup never matches anything. Repairing the
lookup arms it: every routed model would suddenly find its row, lose the adapter
fallback, and — because generated rows do not serialize `capabilities` — end up
with `tools: undefined`.

Root cause: the condition encodes "no catalog row" as a proxy for "no catalog
opinion about tools". Those are different statements, and the difference was
invisible while the branch was dead.

**Amendment:** drop the `catalogRow === undefined` guard. The adapter signal is
positive evidence about the protocol and does not become false when a row
exists. The catalog's `capabilities` list stays a positive-only signal exactly
as its comment already states.

## B2 (High) — ACCEPTED. Synthesized catalog defaults are not evidence

`ensureStrictCatalogFields()` manufactures values for Codex's strict parser:

- `src/codex/catalog/parsing.ts:315-317` — absent modalities become `["text"]`.
- `src/codex/catalog/parsing.ts:328` — absent context becomes `128000`.

```ts
  const contextWindow = typeof entry.context_window === "number" && entry.context_window > 0 ? entry.context_window : 128000;
```

Reading those back as routing evidence converts *unknown* into a confident
negative (`image: false`) and a fabricated `128000`. That is a direct violation
of the module's own header contract at `src/routing/capability.ts:8-10`, and it
would change eligibility decisions in `src/routing/evaluator.ts`.

This is the most valuable finding of the round: the naive fix would have
produced *wrong* evidence, which is worse than the current *missing* evidence.

**Amendment:** do not infer from the compatibility-shaped fields. Serialize
explicit provenance when the catalog is written and read only that. The
repository already carries `opencodex_*` extension keys through the same
writer (`opencodex_catalog_kind`, `src/codex/catalog/sync.ts:371`), so this
follows an established pattern rather than inventing one.

## B3 (High) — ACCEPTED. Phase 020 could not ingest the real payload

`extractProviderModelItems()` reads only `data` envelopes or top-level arrays
(`src/providers/model-discovery.ts:337-343`), and the comment is explicit that a
stray `models` key must not be trusted. The observed llama.cpp body splits the
evidence: `capabilities:["completion","multimodal"]` lives in `models[]`, while
`meta.n_ctx` lives in `data[]`. So the surviving item carries context but no
modality, and my proposed test invented a merged item the parser never builds.

**Amendment:** Phase 020 is re-scoped. Ingesting `meta.n_ctx` from the `data[]`
item is kept — it is correct and independently useful. Cross-envelope merging of
`models[]` into `data[]` is NOT adopted in this unit: it changes a deliberately
conservative discovery boundary, and the existing comment shows that
conservatism is intentional. It becomes a filed issue with the verbatim payload
instead.

## B4 (Medium) — ACCEPTED with a narrower fix

`routedSlug("p","a/b")` and `routedSlug("p","a-b")` both yield `p/a-b`, so a
`find()` on slug equivalence can attach one model's evidence to another. Rare,
but silent and wrong when it happens.

**Amendment (final form):** the provenance block from B2 carries the exact
native `provider`/`model_id`, so the existing equality lookup is KEPT and no
slug fallback exists at all. The collision path is removed structurally
rather than mitigated, and no `slug-codec` import is added. See
`010_catalog_row_shape.md` section 2c.

## B5 (Medium) — ACCEPTED

My precedence tests passed unchanged today, so they proved nothing about the
patch. **Amendment (final form):** because B3 removed multimodal ingestion
from this unit, the rewritten tests are context-only. The contested case is
now `context_length: 32768` against `meta.n_ctx: 8192`, and audit round 2
measured the real before/after matrix into `020_live_capability_ingestion.md`.

## B6 (Medium) — ACCEPTED

The canonical suite command is `bun run test` (`package.json:41`); bare
`bun test` fails `tests/test-home-guard.test.ts` because it bypasses the
wrapper's `OPENCODEX_HOME`. The reviewer also verified no `lidge` checkout holds
this head. **Amendment:** the C phase pushes the branch first and verifies the
remote `HEAD` matches before running `bun run test` there.

## B7 (Medium) — ACCEPTED

`cat` proves bytes, not instruction loading. **Amendment:** Phase 030's
acceptance is qualified to the default Codex home, notes `AGENTS.override.md`
precedence and `$CODEX_HOME`, and is honestly labeled human-verified.

## B8 (Low) — ACCEPTED

`ProviderModelsApiItem = Record<string, unknown> & { id: string }`
(`src/providers/model-discovery.ts:33`) already permits `item.meta`. The
proposed type edit is removed from the change map.

## B9 (Low) — ACCEPTED

The live `lidge` provider now carries `modelContextWindows` and
`modelInputModalities` (added by hand while diagnosing), so the earlier
branches win and the original one-line reproduction no longer reproduces. The
17-to-0 catalog proof is independent and stands. **Amendment:** `001` states
that the reproduction requires a catalog-only fixture.

## Nothing rebutted

All nine findings are accepted. Two — B1 and B2 — would have shipped a
regression affecting every provider, not just the local model that started this
investigation.

## Round 2 outcome

VERDICT: GO-WITH-FIXES (blockers=4), all Medium/Low plan-precision items,
folded above and into the phase docs. The three High blockers are cleared. The
strict-parser risk flagged as the largest remaining unknown was cleared
empirically: an object-valued unknown key returned EXIT=0 on both Codex CLI
0.146.0 and the plugin app-server 0.148.0-alpha.9, while an invalid known
modality returned EXIT=1 — so the parser rejects bad enum values, not unknown
keys.

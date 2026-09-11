# 030 — wp3: peripheral surfaces and docs

The surfaces that *reference* the model rather than define it. Each one below is either
changed with its evidence, or explicitly not changed with its reason — no blanks
(c-5 requires exactly this).

## CHANGE — `src/providers/registry.ts`, direct `google` provider (L1739)

Google publishes `gemini-3.8-flash` on the Developer API (`001`), so the API-key surface gets it:

```ts
models: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"],
modelContextWindows: { ..., "gemini-3.8-flash": 1_048_576 },
modelInputModalities: { ..., "gemini-3.8-flash": ["text", "image"] },
modelReasoningEfforts: { ..., "gemini-3.8-flash": ["low", "medium", "high"] },
```

Note the ladder here is `["low","medium","high"]` with NO `minimal`, unlike the neighbouring
3.5/3.6/3.7 rows which all list `minimal`. `001` proves `minimal` returns a validation error on
3.8. (The 3.7 row listing `minimal` is a pre-existing inconsistency with its own model page;
correcting it is out of scope for this unit and is recorded here as a follow-up observation.)

**`defaultModel` stays `gemini-3.5-flash`.** Adding a model elsewhere must not silently change
an existing API-key user's default — the same rule the 3.6 rollout fixed as decision 5.

**Activation test required (round-2 blocker 3).** Adding 3.8 to `modelReasoningEfforts` newly
arms the configured-ladder branch at `src/adapters/google.ts:782-790` for this model, and
`resolveDirectGeminiWireModelId` newly sees an id absent from `GEMINI_DIRECT_WIRE_RENAMES`.
Neither is covered by a registry-metadata assertion. Add a direct AI Studio request test:
the wire id is bare `gemini-3.8-flash` with no synthetic `-tiered` rename, and the selected
effort arrives as `generationConfig.thinkingConfig.thinkingLevel`.

## CHANGE — `src/providers/free-directory.ts` (L85)

Prepend `gemini-3.8-flash` to the `gemini` entry's `models` array. It is a directory listing of
what the provider serves; `001` proves 3.8 is served.

**Also give that row its own `lastVerified: "2026-09-03"`** (audit blocker 6). The shared
`LAST_VERIFIED = "2026-07-23"` constant at L56 documents when each endpoint was checked; adding
2026-09-03 evidence under a July date makes the field lie. Do NOT bump the shared constant —
that would stamp a verification date on unrelated providers nobody re-checked.

## CHANGE — `src/web-search/index.ts` (L26)

```ts
const DEFAULT_GEMINI_SIDECAR_MODEL = "gemini-3.8-flash";
```

The sidecar runs `google_search` grounding over the Antigravity transport, so its default should
track the Antigravity default. Verified safe by `002`: all three 3.8 tiers accept inference, and
wp1 gives the id a real effort ladder, so `reasoning` still maps to a tier.

`tests/gemini-web-search.test.ts` asserts the resolved wire id. For 3.7 that was
`gemini-3.7-flash-tiered`; for 3.8 the low-effort call must resolve to `gemini-3.8-flash-low`.
That assertion difference is itself the proof the suffix-wire shape reached the sidecar path.

## CHANGE — `src/adapters/cursor/effort-map.ts` and `catalog.ts`

Cursor has NOT announced 3.8 (`001`). The repository has a documented precedent for exactly
this: `glm-5.3` at `effort-map.ts:60` is commented `260814 preemptive: glm-5.3 seeded ahead of
Cursor's lineup update`. Follow it exactly, including the comment style:

```ts
// 260903 preemptive: gemini-3.8-flash seeded ahead of Cursor's lineup update. Google documents
// low/medium/high with no `minimal` for this generation, unlike 3.6.
"gemini-3.8-flash": ["low", "medium", "high"],
```

And in `catalog.ts` beside the 3.7 entry (L202):

```ts
"gemini-3.8-flash": {
  displayName: "Gemini 3.8 Flash",
  window: CONTEXT_GEMINI,
  defaultVariant: "regular",
  variants: { regular: { levels: ["low", "medium", "high"] } },
},
```

This is a static seed, not a claim that Cursor serves it: the Cursor catalog is intersected with
the live `GetUsableModels` roster, so an unseeded model stays invisible until Cursor lists it.
If the reviewer judges the seed speculative, dropping it is an acceptable amendment — the
precedent makes it defensible, not mandatory.

## CHANGE — `docs-site/`

- `src/content/docs/guides/sidecars.md:30` — default model becomes `gemini-3.8-flash`.
- `src/content/docs/reference/configuration/providers.md` — the `directGeminiWireRenames`
  description at L139 keeps its 3.7 example verbatim, because that IS the model with the
  `-tiered` rename. Do not rewrite the example to 3.8; it would document a rename that does
  not exist.
- Check translated locales for the same two strings and keep them from contradicting English.

## NO CHANGE — with reasons

| Surface | Reason |
|---|---|
| `src/adapters/google.ts` `GEMINI_DIRECT_WIRE_RENAMES` | Adding `gemini-3.8-flash -> gemini-3.8-flash-tiered` would invent a wire id no source proves. `002` shows CCA has no `-tiered` row for 3.8, and no AI Studio deployment is known to. |
| `src/adapters/client-fingerprint.ts` | Its 3.7 mention is a comment about UA-gated 404s, not a model list. |
| `src/providers/command-code-efforts.ts` | Keyed by what Command Code's live roster returns; no 3.8 row observed. |
| `src/providers/model-rename-migration.ts` | Nothing retired — see `020`. |
| `google-vertex` `defaultModel` | Frozen pending Vertex-specific evidence. `001` does prove the Agent Platform id, but this provider's default was deliberately frozen and moving it is a separate decision. |
| OrcaRouter / OpenRouter seeds | OpenRouter DOES publish `google/gemini-3.8-flash` (`001`), but seeding router catalogs is out of this unit's scope; recorded as a follow-up. |
| `tests/fixtures/commandcode-models.json` | A recorded upstream fixture; editing it would falsify a capture. |

## Focused verification for this phase

Stale exact assertions this phase must update (audit blocker 3):

- `tests/google-hardening.test.ts:777` — exact `google?.models` array gains `gemini-3.8-flash`,
  plus context-window/modality/effort assertions mirroring the 3.7 rows. Note its ladder
  assertion must be `["low","medium","high"]` with no `minimal`.
- `tests/google-models-listing.test.ts:360` — exact discovered-id array.

```bash
bun test tests/gemini-web-search.test.ts tests/cursor-effort-table.test.ts \
  tests/cursor-effort-suffix.test.ts tests/cursor-catalog.test.ts \
  tests/codex-catalog.test.ts tests/provider-registry-parity.test.ts \
  tests/google-hardening.test.ts tests/google-models-listing.test.ts \
  tests/sidecar-settings-web-search-gate.test.ts
bun run typecheck
```

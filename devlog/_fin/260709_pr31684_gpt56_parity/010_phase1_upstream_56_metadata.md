# 010 — WP1: upstream 5.6 metadata parity (PR #31684 bundle port)

## Diff plan

### 1. `src/codex/data/upstream-models.json` (NEW)
Verbatim snapshot of PR #31684's `codex-rs/models-manager/models.json` (all 8 entries,
pretty-printed). Provenance: PR #31684 head `bot/update-models-json`, fetched
2026-07-09. Lives under `src/` so the published package ships it (package.json
`files: ["src", ...]`). Refresh procedure documented in
`docs/codex-app-model-catalog.md`.

### 2. `tsconfig.json` (MODIFY)
Add `"resolveJsonModule": true` to compilerOptions (Bun supports JSON imports at
runtime; tsc needs the flag).

### 3. `src/codex/catalog.ts` (MODIFY)
- Import the snapshot: `import upstreamModels from "./data/upstream-models.json"`.
- NEW `const UPSTREAM_NATIVE_ENTRIES = new Map<string, RawEntry>` built once from
  `upstreamModels.models`, keyed by slug, RESTRICTED to `SUPPORTED_NATIVE_OPENAI_SLUGS`
  (gpt-5.2 / codex-auto-review etc. stay excluded).
- NEW `function upstreamNativeEntry(slug: string): RawEntry | null` — deep-clone of the
  map entry with adaptations:
  - `delete e.minimal_client_version` (a pinned client-version gate would HIDE the
    model on older installed clients; ocx targets whatever client is installed —
    matches current synthesis, which never emits the field).
  - `delete e.prefer_websockets` unless `wsEnabled` is passed true by the caller
    (deletion mirrors the existing supports_websockets central override; a
    prefer_websockets=true leak while ocx WS is off would make the client prefer an
    endpoint ocx has disabled).
  - keep `auto_compact_token_limit: null` as-is; `ensureStrictCatalogFields` ->
    `ensureAutoCompactTokenLimit` fills 334800 (0.9 * 372k), consistent with every
    other native entry ocx emits (stated deviation from upstream null).
- `deriveEntry` native path (else-branch, ~L555): when `!slug.includes("/")` and
  `upstreamNativeEntry(slug)` exists, use IT as the base entry (desc/priority args
  still apply: priority from caller only when featured; otherwise KEEP the upstream
  entry's own priority 1/2/3; description keeps upstream's real description instead of
  the generic passthrough blurb). Existing template-clone path stays the fallback for
  supported slugs not in the snapshot. `ensureGpt56ReasoningLevels` is DELETED —
  ladders now come from the snapshot (fixes luna-ultra G1 and sol-default G2).
  The no-template fallback path (~L567) also prefers `upstreamNativeEntry`.
- `mergeCatalogEntriesForSync` native `.map` path: for slugs in
  `UPSTREAM_NATIVE_ENTRIES`, when the preserved entry LOOKS ocx-synthesized
  (`entry.display_name === entry.slug`) replace it with `upstreamNativeEntry(slug)`
  (priority logic unchanged). Genuine catalog entries (real display names, e.g. a
  future installed codex that already ships 5.6) are preserved untouched — the
  installed binary stays the source of truth once it catches up.
- Backfill loop (~L1020): pass template OR upstream entry via the same `deriveEntry`
  change (no separate edit needed beyond wsEnabled plumbing if required).
- `NATIVE_OPENAI_CONTEXT_OVERRIDES` for 5.6 stays (now redundant for snapshot-backed
  entries, still corrects stale real entries; harmless idempotent overlay).

### 4. `src/reasoning-effort.ts` (MODIFY)
`CODEX_REASONING_LEVELS` descriptions -> upstream canonical (G4): medium "Balances
speed and reasoning depth for everyday tasks", xhigh "Extra high reasoning depth for
complex problems", max "Maximum reasoning depth for the hardest problems", ultra
"Maximum reasoning with automatic task delegation". low/high already match.

### 5. Tests (MODIFY)
- `tests/codex-catalog.test.ts`:
  - `buildCatalogEntries(template, ["gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna"], [])`:
    sol/terra ladders end `[...,"max","ultra"]`, luna ends `[...,"max"]` with NO ultra;
    sol `default_reasoning_level === "low"`, terra/luna `"medium"`; display_names
    "GPT-5.6-Sol/Terra/Luna"; sol has `availability_nux`; luna `multi_agent_version`
    "v1", sol/terra "v2"; no `minimal_client_version` on any emitted entry;
    `context_window === 372000`.
  - merge-sync correction case: an on-disk synthesized luna (display_name ===
    "gpt-5.6-luna", ladder with ultra) is replaced by the snapshot entry; a fake
    "genuine" luna (display_name "GPT-5.6-Luna", marker field) is preserved.
  - ws gating: `prefer_websockets` absent when wsEnabled=false, present when true.
- `tests/codex-catalog-golden.test.ts` / others: re-record only if 5.6 fixtures are
  covered; goldens for routed models must NOT change except effort descriptions
  (medium/xhigh/max wording) — expected, assert deliberately.
- `tests/reasoning-effort.test.ts`: update any description-string assertions.

### 6. SoT docs (MODIFY)
`docs/codex-app-model-catalog.md` (snapshot provenance + refresh procedure + ladder
table incl. luna no-ultra), `structure/03_catalog-and-subagents.md` (5.6 synthesis
description), README trio + docs-site only where 5.6 ladder/context lines exist.

## Scope boundary
- IN: files above + goldens if touched + this unit.
- OUT: adapters, providers/registry.ts, GUI, gpt-5.4 overrides, codex-rs.

## Accept criteria (activation-grounded)
1. New ladder/default/identity cases green (drives G1/G2/G3 paths); luna-no-ultra is
   the explicit activation scenario for the snapshot branch of deriveEntry.
2. Merge-sync replace-vs-preserve case green (activation for the discriminator branch).
3. `bun x tsc --noEmit` exit 0; full `bun test` exit 0 (fresh outputs).
4. Docs synced in the same cycle.
## A-phase fold-back (reviewer: gpt-5.5, VERDICT GO-WITH-FIXES blockers=4)

REVIEW-SYNTHESIS-01 record:
- **B1 (High, ACCEPTED — plan amended):** `deriveEntry` has no `wsEnabled` param, so a
  per-entry prefer_websockets gate was unreachable. Amendment: handle
  `prefer_websockets` in the CENTRAL ws overrides (buildCatalogEntries tail
  ~catalog.ts:617-619 and mergeCatalogEntriesForSync tail ~:1049-1050): wsEnabled
  false -> `delete entry.prefer_websockets` alongside supports_websockets; wsEnabled
  true -> leave the entry's own value. `upstreamNativeEntry` does NOT strip it.
- **B2 (High, ACCEPTED):** `NATIVE_OPENAI_CONTEXT_OVERRIDES` is private. Amendment:
  export `nativeOpenAiContextWindow(slug): number | undefined` from catalog.ts; WP2
  management-api uses that helper.
- **B3 (Medium, ACCEPTED with rationale):** `display_name === slug` also matches
  codex-rs fallback-metadata entries and hand-made fixtures. Recorded intent: any 5.6
  entry whose display_name equals its slug is at best fallback-quality (codex-rs
  model_info fallback or ocx synthesis) and SHOULD be upgraded to the pinned upstream
  snapshot; genuine catalog entries always carry marketing display names. Documented
  here + code comment; discriminator kept.
- **B4 (Low, ACCEPTED):** line refs drifted (ensureGpt56ReasoningLevels is
  catalog.ts:528; filterCatalogVisibleModels :883). Refs refreshed mentally at B;
  docs keep approximate refs with this note.
- Confirmed-good (reviewer): /v1/models client_version branch reaches deriveEntry
  substitution; minimal_client_version strip has no models-manager side effect;
  visibility "hide" lowercase serde verified; hidden default/featured natives safe
  (picker skips hidden for default selection); packaging ships src JSON; description
  string assertions bounded to tests/reasoning-effort.test.ts:462-471.

# 100 — Issue #992: routed models must not inherit template context_window

Independent lane. Research: explorer batch G.

## Verified current state

- `deriveEntry()` deep-clones the native template
  (`src/codex/catalog/sync.ts:205-213`); routed entries apply optional
  metadata (`:216-228`) without clearing template context fields first.
- `applyCatalogModelMetadata()` overwrites only when the window is known
  (`src/codex/catalog/effort.ts:125-132`).
- `ensureStrictCatalogFields()` supplies the conservative fallback
  `128000 / 128000 / 115200` (`src/codex/catalog/parsing.ts:290-301`) — the
  desired owner of last resort; no `parsing.ts` change.
- Provider caps deliberately don't invent unknown context
  (`src/providers/context-cap.ts:24`; pinned at
  `tests/codex-catalog.test.ts:2479-2545`). Decision: explicit 128k
  conservative default — not omission (codex-rs yields `None`, no
  auto-compaction) and never cap-as-fallback.

## Diff-level plan

MODIFY `src/codex/catalog/sync.ts` — at the start of the `if (isRouted)`
branch (`:216`), before `applyJawcodeCatalogMetadata()` /
`applyCatalogModelMetadata()`:

```ts
delete e.context_window;
delete e.max_context_window;
delete e.auto_compact_token_limit;
```

Known live/configured/Jawcode metadata then restores exact values; otherwise
the strict-fields fallback supplies the conservative triple.

MODIFY `tests/codex-catalog.test.ts` — regression beside `unknown routed
entries receive conservative strict catalog defaults` (`:2290`).

## Tests / activation

`/models` returns `{data:[{id:"relay-model"}]}` with a 372000 native
template → routed entry becomes `128000/128000/115200`, never `372000`.
Matrix: ID-only routed model → conservative triple; + provider cap 950000 →
still 128k (cap doesn't invent capacity); configured
`contextWindow`/`modelContextWindows` → configured value + 90% compaction;
discovered 500k + 350k cap → 350k; discovered 64k + 350k cap → 64k; known
Jawcode metadata → exact (optionally cap-lowered); native entries unchanged;
null-template fallback → 128k.

## Risks

- 128k can still overstate an undocumented smaller model — users set
  explicit `contextWindow`.
- Clearing only `context_window` leaves max/compaction inconsistent — all
  three must go together.

## Accept criteria

- Activation + matrix green; gates as 030.

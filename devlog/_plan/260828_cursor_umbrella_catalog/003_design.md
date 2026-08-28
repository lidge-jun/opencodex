# 003 — umbrella design (locks the shape both implementation phases build)

## Principles (beats senpi where it is weak)

1. ONE source of truth: a single capability module owns the variant grammar,
  per-base levels, thinking/fast/1M dimensions, and wire encoding. No second
  generated alias JSON (senpi weakness 3): aliases are DERIVED by the grammar,
  not enumerated.
2. Thinking MERGES into the base identity for every family (no Claude-only
  split — senpi weakness 2). A base with thinking variants routes efforts
  through its thinking wire ids; bare non-thinking ids remain aliases.
3. Fast is a dimension INSIDE the umbrella (senpi weakness 1): no fast picker
  rows; cursor/<base>-fast stays routable as an alias that sets fast mode on
  the same umbrella identity.
4. 1M/Max-Mode generalized: every base whose capability declares bigContext
  (statically: claude/gemini/kimi/gpt-5.6 families per senpi windows; live:
  maxModeModels from GetUsableModels — currently decoded but DISCARDED)
  exposes the ultra effort -> maxMode=true wire flag. kimi-k3-1m stops being
  the lone synthetic and becomes an alias.
5. Back-compat absolute: every one of today's 69 ids (and live suffix ids)
  resolves through the grammar to (base, level?, thinking?, fast?, ultra?).

## Picker shape (after)

- Rows: 4 router + ~30 base umbrellas (from 69). Efforts per row from the
  capability ladder; ultra appended only for bigContext-capable rows.
- Codex effort -> wire: suffix-id-first (Cursor rejects bare capability ids,
  senpi #1008 confirmed + our own request-builder already suffix-first).
  Thinking-capable base + effort E -> thinking wire id at E (family wire
  order preserved from CURSOR_THINKING_FAMILIES). ultra -> base ladder top +
  maxMode=true. Fast alias -> {stem}-{E}-fast.

## Module plan

- NEW src/adapters/cursor/catalog.ts: capability table (schema:
  { levels: readonly string[], thinking?: { wireOrder }, fast?: true,
  bigContext?: true, window, quarantined?: true }), parseCursorVariantId
  (senpi grammar: strip -fast; -thinking-<lvl> | -<lvl>-thinking | -thinking
  | -<lvl> | -1m), resolveCursorSelection(baseOrAlias, codexEffort) ->
  { wireId | wireBase+params, maxMode, fast }, umbrellaCatalog() ->
  picker rows. effort-map.ts becomes a thin re-export shim during wp2 and is
  DELETED in wp3 once consumers move.

## NEEDS_HUMAN boundary

Picker row ids stay cursor/<base> (already true for bases). Removing separate
thinking/fast/1m ROWS changes what the picker lists but not what routes —
within the user's explicit instruction, so not escalated.

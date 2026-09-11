# 003 — umbrella design (locks the shape both implementation phases build)

## Principles (beats senpi where it is weak)

1. ONE source of truth: a single capability module owns the variant grammar,
  per-base levels, thinking/fast/1M dimensions, and wire encoding. No second
  generated alias JSON (senpi weakness 3): aliases are DERIVED by the grammar,
  not enumerated.
2. Thinking MERGES into the base identity for every family (no Claude-only
  split — senpi weakness 2) AS A DIMENSION, not by discarding identities
  (A-gate blocker 1): the capability schema carries per-variant ladders
  ({ regular?, thinking?, fast?, thinkingFast? } each with its own effort
  list + wire order), because live ladders differ (claude-opus-5-fast
  low/med/high vs thinking-fast low..max). The UMBRELLA ROW defaults to the
  thinking variant when one exists (user decision: "thinking 하나로 합치고");
  regular/fast/thinking-fast remain reachable via aliases that select the
  variant dimension explicitly. resolveCursorSelection takes the PICKED id
  (which encodes the variant via the alias) — never guesses.
3. Fast is a dimension INSIDE the umbrella (senpi weakness 1): no fast picker
  rows; cursor/<base>-fast stays routable as an alias that sets fast mode on
  the same umbrella identity.
4. 1M split into TWO separate capabilities (A-gate blocker 4 — window size
  does NOT imply maxMode; prior probes found maxMode only on opus-fast
  variants, 260822_senpi_cursor_transfer/210+310):
  - window: context-window METADATA generalized per senpi's table (1M for
    claude/gemini/kimi/gpt-5.6 families) — display/routing metadata only.
  - maxMode (ultra rung): gated on EVIDENCE — the union of live
    maxModeModels (decoded in live-models.ts:123-136, discarded by
    provider-fetch today) and an explicit verified static list (currently
    exactly kimi-k3, user-verified). Ultra generalizes automatically as live
    evidence arrives, never from window size.
5. Back-compat absolute (A-gate blockers 2/3):
  - Parser precedence: EXACT known identity/alias table first (covers
    gpt-5.1-codex-max-as-base, gpt-5.5-extra, claude-4-sonnet-1m real wire
    id), then cursor- prefix normalization (cursor-grok-4.5/4.6 wire forms),
    then suffix grammar. A frozen fixture table pins parse+resolve for all
    69 picker ids + observed prefixed/suffixed wire forms.
  - Alias retention contract: picker ROWS shrink, but the REQUEST path keeps
    resolving every legacy slug (router forwards provider-qualified ids to
    the adapter, router.ts:673-678; the adapter's resolver owns aliases).
    A pinned session/config naming a removed slug keeps routing identically;
    only fresh picker lists shrink. Tested explicitly (020).
  - Quarantine is VARIANT-specific: claude-opus-5 regular stays quarantined
    while thinking/fast siblings remain selectable.

## Picker shape (after)

- Rows: 4 router + ~30 base umbrellas (from 69). Efforts per row from the
  default-variant ladder. Synthetic max+ultra spawn-validation appendage
  (effort.ts:219-226) is a SEPARATE policy from wire ultra: effort.ts stays
  in the diff (blocker 5) — synthetic max/ultra continue to be appended for
  spawn validation on every reasoning row (no downstream break), while the
  WIRE maps ultra to maxMode only for evidence-gated bases and clamps to the
  ladder top elsewhere (exactly today's clamp behavior).
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

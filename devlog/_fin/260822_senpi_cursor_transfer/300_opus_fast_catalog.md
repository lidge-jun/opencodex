# 300 — opus-fast catalog repair (from live re-probe)

## Corrected evidence (supersedes 210's entitlement interpretation)

Live wire probes (this session, macmini):
- claude-opus-4-8-high-fast -> SUCCESS ("FP-OK"); both maxMode arms succeed.
- claude-opus-4-7-low-fast -> bare resource_exhausted (tier-specific; cause
  unknown — NOT account-wide entitlement).
- claude-opus-4-7-fast (bare) -> not_found: the wire only has suffixed forms.
- Proxy-side cursor/claude-opus-4-7-fast -> not_found today because the
  static catalog sends the bare id (discovery.ts:239-240 "tiers unverified").

GetUsableModels dump (204 entries) lists the -fast families as
{base}-{effort}-fast, matching effort-map.ts:130-131's existing suffix rule.
maxMode=true rides exactly these 28 opus -fast ids.

## Diff shape

- src/adapters/cursor/discovery.ts CURSOR_STATIC_MODELS:
  - claude-opus-4-7-fast: add supportsReasoningEffort: true (tiers now
    live-verified); keep CONTEXT_200K.
  - add claude-opus-4-8-fast and claude-opus-5-fast entries
    (supportsReasoningEffort: true, CONTEXT_200K) so the routed catalog
    exposes the working families.
- src/adapters/cursor/effort-map.ts CURSOR_EFFORT_TIERS:
  - "claude-opus-4-7-fast": from dump: low/medium/high (+ thinking variants
    are separate wire ids — out of scope; only non-thinking tiers).
  - "claude-opus-4-8-fast": low/medium/high/xhigh/max per dump.
  - "claude-opus-5-fast": tiers per dump (verify exact list from the
    transcript at implementation P).
  - The -fast suffix rule at :130-131 already produces
    {base-without-fast}-{effort}-fast — verify it yields e.g.
    claude-opus-4-8-high-fast (it did live).
- CURSOR_NO_VISION_MODELS: opus families are Claude-hosted (vision-capable);
  no curation change.
- Tests: tests/cursor-static-catalog.test.ts + effort-map tests — pin the
  new ids, tier ladders, and wire-id derivation for one example per family.
- Live smoke after merge: macmini proxy turn on cursor/claude-opus-4-8-fast
  (effort high) expecting text output.

## Risk

4-7-low-fast RE stays unexplained; the catalog change only ADDS working
families and upgrades 4-7-fast from bare (broken) to suffixed. Worst case a
tier 404s -> same not_found class as today, no regression.

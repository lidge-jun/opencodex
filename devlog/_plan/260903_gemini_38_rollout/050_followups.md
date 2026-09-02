# 050 — follow-ups deliberately out of this unit

Recorded rather than silently dropped, so a later unit can pick them up with the evidence
already attached.

1. **`ANTIGRAVITY_WIRE_MODELS` is dead data.** The audit confirmed no consumer outside its own
   declaration; discovery never reads it. It reads like a source of truth and is not one.
   Deleting it is a cleanup with its own review surface, not a line in a model rollout.

2. **The direct `google` 3.7 row advertises `minimal`.** `registry.ts:1745` lists
   `["minimal","low","medium","high"]` for `gemini-3.7-flash`, but Google's 3.7 model page
   documents `minimal` as an error for that generation — the same fact this unit relies on for
   3.8. The 3.8 row is added correctly without it; correcting 3.7 is a behavior change for
   existing users and belongs in its own unit.

3. **OpenRouter publishes `google/gemini-3.8-flash`** (`001`). Seeding router catalogs is out of
   scope here, but the id is proven whenever that unit happens.

4. **Vertex.** `001` proves the Agent Platform publisher id
   `publishers/google/models/gemini-3.8-flash`. `google-vertex.defaultModel` was deliberately
   frozen pending Vertex-specific evidence; unfreezing it is a separate decision.

5. **`ANTIGRAVITY_SUFFIX_TIER_MODELS` and `gemini-3.1-pro`.** 3.1 Pro keeps emitting
   `thinkingLevel` beside a suffix wire id for `low`. Its `high` rung (`gemini-pro-agent`) has
   no suffix, so the set cannot simply include it; sorting out that asymmetry is its own task.

# 030 — wp4: closure

1. Cleanliness comparison table: rows before/after (69 -> ~34), effort-map
  229 LOC deleted vs catalog.ts added, single-module truth vs senpi's
  3-surface split (static TS + 336-row JSON + regex) vs omo's absent map;
  thinking merged for ALL families (senpi: Claude split remains); fast as
  dimension (senpi: separate groups).
2. Picker proof: opencodex-catalog.json cursor section before/after row
  counts + one umbrella row excerpt showing efforts incl ultra.
3. Back-compat proof: legacy-id wire table test green (every 69 id routes
  to the same wire id as before, or documented intentional change).
4. Stack finalization: PR A -> dev, PR B stacked; retarget checks.

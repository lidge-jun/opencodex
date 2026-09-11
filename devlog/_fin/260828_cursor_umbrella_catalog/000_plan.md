# 260828 cursor umbrella catalog — unit plan (wp1 docs-only)

Goal: collapse the 69-row hand-maintained cursor picker into per-base umbrella
rows (thinking merged, fast inside, 1M/Max-Mode generalized), sourced from a
single capability module informed by senpi's architecture but cleaner.

## Loop-spec

- Archetype: spec-satisfaction. Verifiers per phase: bun test <file>, tsc,
  privacy scan, catalog sync output row counts. Repo-wide suite forbidden.
- References: senpi (scratch path in /tmp/senpi-scratch.txt) — capability
  table/grouping/selection cited in 001; omo-ai@beta has NO cursor model map
  (verified — provider-map.json is a provider-name alias list only).
- Non-goals: other providers, releases, protobuf schema changes.
- Bounds: ~10h wall; stacked PRs codex/* -> dev pre-approved, --no-verify ok,
  unlimited subagents (sol + xai/grok-4.6).
- Terminal: DONE per goalplan c1-c5; NEEDS_HUMAN for user-visible id renames
  beyond aliasing.

## Work-phase map

- wp1 docs (this cycle): 000-002 research + 010/020/030 decade docs.
- wp2 (010): capability core module + variant grammar + umbrella grouping.
- wp3 (020): catalog integration (discovery/registry/sync/request path).
- wp4 (030): closure — cleanliness comparison + picker proof + stack final.

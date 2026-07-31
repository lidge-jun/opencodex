# Split src/codex-catalog.ts (915 lines) by responsibility

Date: 2026-07-01
Surface: src/codex-catalog.ts (Codex catalog build + persistence + discovery).
Class: C4 (structural refactor touching catalog injection into Codex config).
Status: SCAFFOLD - measured from code, plan drafted, NOT started.
Source: gajae/architect repo review (gpt-5.5), risk item 2 / priority 4.

## Measured facts

- wc -l src/codex-catalog.ts -> 915 lines (review said 900+: confirmed).
- Mixes: read/write of the Codex catalog file, backup/restore, provider model
  fetch, caching, metadata inference, native-allowlist policy, routed-entry
  neutralization (the identity base_instructions replace lives here too,
  ~line 449), and strict-field normalization.

## Proposed target modules

1. src/codex-catalog/build.ts - PURE catalog entry construction: deriveEntry,
   routed vs native shaping, reasoning levels, strict-field normalization,
   identity base_instructions neutralization. No filesystem, no network.
2. src/codex-catalog/discovery.ts - provider model fetch + cache (network).
3. src/codex-catalog/persistence.ts - read/write the on-disk catalog,
   backup/restore, config injection paths.
4. src/codex-catalog.ts - thin orchestrator that composes the three.

The pure build module is the prize: it is the most logic-dense and the easiest
to unit-test in isolation once free of fs/network.

## Hard constraints

- ZERO behavior change to the injected catalog. The live artifact
  (~/.codex/opencodex-catalog.json) must be byte-identical before/after for the
  same inputs. Add a golden-snapshot test of a built catalog BEFORE refactoring,
  so the split is provably behavior-preserving.
- Identity neutralization (routed base_instructions replace) must keep working;
  it has shipped tests (tests/identity-neutralize.test.ts,
  tests/codex-catalog*.test.ts) - keep them green throughout.
- Small, independently-green commits.

## Sequencing

1. Add a golden-snapshot test of a representative built catalog (safety net).
2. Extract persistence (fs) -> 3. extract discovery (network) ->
4. extract pure build last (largest payoff, safest once IO is gone).

## Open questions

- Which symbols do tests import directly? Grep tests/ for codex-catalog exports
  first; add re-export shims from codex-catalog.ts to avoid churn.
- Is the catalog cache keyed/owned here or shared? If shared, coordinate with
  the runtime-state-consolidation plan rather than duplicating cache state.

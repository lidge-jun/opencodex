# 001 — Architect reflection record

Reflection round 1, both architects: **MISALIGNED**. Every gap was accepted and folded:

| Gap (architect) | Disposition |
| --- | --- |
| `restore()` deletes the Codex home even after a failed drain (r1, r3) | Folded: helper gains `restoreEnvironment()` / `removeAfterDrain()`; G3 removes a root only after its drains succeed |
| Codex-home config flights never flushed; order of history close vs reaps (r1) | Folded: both roots flushed first, then history close, then ACL drains |
| Env restore lacks a finally guarantee (r1) | Folded: restoration in `finally` |
| Structure doc hunks missing from the recipe and pointing at the absent Rust crate; test-sandbox-cleanup doc (r1, r3) | Folded into 010 file map and recipe |
| Regression list missing survivors, aliases, deleted ancestry, required-failure (r1, r3) | Folded: 010 tests 3, 5, 6, 8; fixture-order changes declared Windows-CI-only |
| "Fixtures never call history close" is false (r1) | Folded: 000 narrowed |
| "Crate only runs under the new workflow" overstated (r3) | Folded: 000 D2 reworded |
| `tests/lib/translator-budget*` path wrong; equivalence list incomplete (r3) | Folded: 040 uses `tests/adapters/translator-budget.test.ts` and the full list |
| Four vs three docs at 600 lines (r3) | Folded |
| `cargo fmt` needs `--manifest-path` (r3) | Folded |
| r3's minimal Rust crate in wp1 | Rejected per D2 |

Both architects confirmed the recipe paths, the 1999→1931 extraction and `core.ts` 210/210.

## A-phase audit round 1 (independent sol reviewer): FAIL, 5 blockers, all folded

| Blocker | Fold |
| --- | --- |
| wp1 applied the whole `structure/runtime.md` diff, including a wp4 catalog paragraph | 010: only the Support-table hunk |
| wp5 map vs "restore references" instruction | 050: Bun references stay; Rust sentences only in declared files |
| `cargo nextest` unavailable | 050: workflow's `cargo test --locked ... --test async_contracts` |
| Fixture-order contract had no deterministic verifier; management-auth env restore not in finally | 010: `tests/helpers/fixture-teardown.ts` + `tests/ci-workflows/fixture-teardown-helper.test.ts` (6 cases), finally restoration |
| Haiku carry skipped its owner doc and user docs | 060: `structure/providers-and-adapters.md` and `guides/providers.md` rows |

## A-phase audit round 2: FAIL, 3 blockers, all folded

| Blocker | Fold |
| --- | --- |
| Default `settleConfigFlights` = `flushConfigDirHardeningAndReaps` already drains ACL before history close | 010: default is `flushConfigDirHardening`; test 8 asserts it |
| Inline OAuth example disagreed with helper gating; producer failure did not block removal | 010: example replaced by the helper call; gating rules 1-6 written out; tests 6-7 |
| User-doc fold could do nothing (no Go wire list exists) | 060: required sentence in the OpenCode Go paragraph, locale disposition stated |

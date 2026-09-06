# 043 — Preserve changes already integrated before the source carry

The first UI verification at `1b90dba7` passed 23 API tests and 157 GUI tests,
with one GUI locator failure. Its build also exposed three missing Grok text keys.

The carry used the PR's target-tip snapshot `af50c6d3` as a diff base, but source
`ff4e5cd5` actually shares merge base `6585e6a7` with that target. This accidentally
reversed an already integrated change in nine locale files and one English
provider-reference row. The original contributor's feature did not make those
reversals; this was a carry-boundary error.

Restore only that established target delta, preserving the new management keys
and controls. Future carries use the actual Git merge base and review target
drift separately. The earlier B sources #3653, #3654 and #3571 were checked:
their recorded bases equal their actual merge bases, with no overlapping drift.

The GUI locator must use the displayed provider name rather than assuming its
capitalization; all inventory, search/cap and native-selection assertions remain.
The repaired head requires fresh GUI execution and build evidence. Initial
failures remain recorded and are not reported as passing checks.

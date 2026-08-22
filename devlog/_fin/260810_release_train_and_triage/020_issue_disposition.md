# 020 — WP2: issue disposition

Sweep of all open issues against the release candidate `dc4dd45b0`, run as a
dedicated read-only audit. Method: for each issue, look for a merged commit in
`121f1ad92..dc4dd45b0` that fixes the exact reported failure mode — the
`(#NNNN)` suffix convention in merge subjects is the primary signal, confirmed
by reading the changed code.

## Result

| Bucket | Count |
|--------|------:|
| CLOSE-NOW | **0** |
| CLOSE-AFTER-RELEASE | 1 |
| KEEP-OPEN-UNFIXED | 37 |
| KEEP-OPEN-NEEDS-JUDGMENT | 21 |
| Total open at sweep time | 59 |

**Live recount (audit blocker 7): 61 open.** New during this unit: #1400
(WSL service state records the wrong Codex home) and #1401 (history sync
ignores `CODEX_SQLITE_HOME` in a Windows/WSL split-home layout). Both are
fresh bug reports with no fix on the RC, so they land in KEEP-OPEN-UNFIXED and
do not change the zero-close conclusion. The reviewer's own falsification
sample (#1145, #1236, #938 already closed; #1302 and #1273 only partially
addressed) points the same way.

**Zero issues are closable on merge evidence alone.** That is the honest
outcome, not an incomplete sweep. Three of the issues explicitly named for
re-check (#1292, #1308, #1312) turned out to be **already closed** by earlier
campaigns, which is consistent: `260808_bug_campaign` and
`260806_disposition_sweep` drained the closable backlog, so what survives is
genuinely open work.

## Closable after this release

| Issue | Title | Fixing commit | Why |
|-------|-------|---------------|-----|
| [#1366](https://github.com/lidge-jun/opencodex/issues/1366) | Imported CLI credential with invalid `expires_at` is adopted and shown logged in | `831a120ea` (PR #1369, merged `e8ce2b93d`) | Non-finite expiries are now rejected at detection and adoption, reauthentication state drives login display, and malformed-expiry regressions were added. Fixed on `dev`, not yet published. |

Action after WP1 publishes: comment the fixing commit plus the released version
on #1366 and close it. Nothing else qualifies.

## Verified-already-closed (no action)

| Issue | Fixing commit | Note |
|-------|---------------|------|
| #1292 | `56cca2f3d` | DeepSeek tool-result adjacency normalization |
| #1308 | `e8a21dc2e` (PR #1331) | `ocx sync` retains configured combo members |
| #1312 | `e09fe6e2f` | Vertex replay scoped by client thread |

## Notable still-open items

- **#1302** (Linux CI shards hang, orphan Bun) — `183741b82` bounded one
  `cli-help` `spawnSync`, which removed that specific 15-minute cancellation,
  but the cross-file hang family reproduced afterwards on run 31349399276.
  Partially mitigated; stays open. Directly relevant to WP1's flake budget.
- **#1222** (Windows `0xC0000409` fast-fail) — still unaddressed, carried as a
  known issue since v2.11.0. No commit in the delta touches it.
- **#1273** (stale full-config writes resurrect deleted state) — the
  provider-removal half was fixed by `14e948525`/#1293; the issue explicitly
  remains open for whole-document stale writes.
- **#1296** (Windows ACL failure surfaced as `401 authentication_error`) — no
  commit in the delta reclassifies local ACL failures.
- **#1383**, **#1388**, **#1395**, **#1399** — filed recently, unfixed.

The 21 `NEEDS-JUDGMENT` issues split into three recurring shapes: feature
requests awaiting a product decision (#1107 authless Desktop mode, #1181
unknown-cost cap contract, #1209-adjacent policy questions), provider
integrations blocked on an upstream contract (#201 TRAE, #540 WordPress, #1148
Nous Portal), and bug reports needing a fresh reporter reproduction on v2.11+
(#417, #904, #1128, #1162, #1176). None can be settled from the tree.

## Rule applied

A false close costs more than a missed one: it buries a real defect and tells a
reporter their bug was handled when it was not. Anything short of a cited
fixing commit stayed open.

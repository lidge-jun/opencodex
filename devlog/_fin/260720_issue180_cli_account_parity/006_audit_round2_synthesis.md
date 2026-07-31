# 006 — Audit round 2 synthesis (REVIEW-SYNTHESIS-01)

Reviewer: sol agent "Boyle" (A-gate round 2, dispatched by the main session after
round 1 by "Anscombe" — see 005). Verdict: **GO-WITH-FIXES (blockers=1)** + 4
non-blocking. This doc records per-blocker RCA and accept/rebut decisions; the
main session judges the round **near-pass** after folding every item below.

Round-2 verified-true (independent re-verification, fresh anchors): all
codex-auth / oauth / providers-keys endpoint contracts, the CLI import surface
(`providerCodexAccountMode` registry.ts:848, `getProviderRegistryEntry` :839,
`runningProxyUpdateHeaders` login-cli.ts:9, `findLiveProxy`/`probeHostname`/
`LiveProxy` proxy-liveness.ts:93/:46/:35), the dispatch + dual help-registry
convention, secret safety of every planned output path, and DTO/enum shapes.

## Blocker 1 [High] — `remove openai main --yes` would be a false-success destructive op

- RCA: `DELETE /api/codex-auth/accounts?id=__main__` returns 200 unconditionally
  (src/codex/auth-api.ts:436-443) while only tombstoning a synthetic ledger row
  (src/codex/account-store.ts:203-210) and clearing the pin
  (src/codex/account-lifecycle.ts:15-21) — the main App-login credential is
  untouched and reappears on next list. The GUI deliberately exposes no remove
  on the main card (gui/src/components/CodexAccountPool.tsx:274-296). The
  planned existence pre-check cannot catch it: main IS in the list.
- Decision: **ACCEPT**. 020 amended: `remove` rejects `main`/`__main__` with
  re-login guidance (exit 1), plus a test row asserting no DELETE is sent.

## Non-blocking — dispositions (all ACCEPTED and folded)

| # | Finding | Fold |
|---|---|---|
| 2 | 020 said the pre-check "fixes the codex/keys DELETE 200-on-unknown asymmetry" — but keys DELETE 404s (management-api.ts:1516-1517); only codex-auth DELETE (:436-443) and `/api/keys` are 200-on-unknown | 020 rationale reworded to codex-only |
| 3 | 003 stale anchors after tree moves: delegation :1610-1613 → actual :1622-1623; Family B :1429-1457 → :1440-1471; Family C :1460-1516 → :1473-1526 | 003 anchors refreshed |
| 4 | kiro mis-citation: `SINGLE_SLOT_PROVIDERS` (store.ts:28) is `{"chatgpt"}` only; kiro's replace-slot comes from the no-identity branch (store.ts:13-15,247-256) | 010 + 003 citations corrected; design (hardcoded kiro note) unchanged |
| 5 | 010 cited debug.ts:7-14 for the URL/header pattern; the actual pattern is :19-21 | 010 cite corrected |

## Judgment

All High/Critical findings are folded as concrete amendments; only corrected
citations remain as residuals (folded, none open). Round outcome: **near-pass**
→ A exits to B for implementation planning (WP2 consumes 010 next cycle).

# 020 — open issues: 21 audited for quick-win feasibility

A quick win means: small diff (roughly under 150 lines), no new subsystem, no schema migration,
clear correct behaviour, testable with a focused `bun test`. Estimates include tests and any
directly required UI or docs.

## Shipped in this loop

| Issue | Verdict | Where |
|---|---|---|
| #2406 CommandCode image capabilities | QUICK-WIN | wp3 — static modality maps in `registry.ts` |
| #1215 OpenCodex-scoped noProxy | QUICK-WIN | wp4 — the existing NO_PROXY merge in `config.ts:3116` |
| #1060 billing-period end | QUICK-WIN (grew) | wp5 — the GUI drops the whole `creditsUsd` object, not just one field |

## Closed with evidence

| Issue | Verdict | Evidence |
|---|---|---|
| #2442 | ALREADY-DONE | `openai-responses.ts:1587`, `muse-spark-web-search-compat.test.ts:38` |
| #2423 | ALREADY-DONE | `empty-completion-guard.ts:309`, `empty-completion-guard.test.ts:326` |
| #2060 | DECLINED WITH REASON | `key-failover.ts:82` — 429 failover is the intended default; eager round-robin is a pool policy |

## Medium (140-300 lines)

| Issue | Why it is not a quick win |
|---|---|
| #2539 Anthropic weekly quota routing | selection scores only `fiveHour` today; adding a weekly policy crosses routing, management API, GUI persistence |
| #2279 suppress synthetic max | catalog synthesis adds `max` and `ultra` together; config has an exact override, not an independent suppression policy |
| #2201 display names for discovered models | `displayName` exists only on custom models; needs schema, precedence, API, GUI, catalog propagation |
| #1820 cost and cache metrics in Usage | **most attractive of this tier** — the backend already computes both ([summary.ts:67](../../../src/usage/summary.ts)); only the GUI row types and tables omit the columns |
| #1690 config-level retainModels | retention comes from hardcoded/Vertex/combo inputs, not provider config; the retained-but-404 diagnostic adds runtime behaviour |
| #1533 explain V2 compatibility state | API exposes mode and preferred model independently; no joined state for the GUI to explain |

## Not quick (250-700 lines)

#2511 request byte budget · #2455 queue latency and granted tier · #2399 delete ZCode snapshots ·
#2275 durable reset-credit identity · #2221 native-main token refresh · #2046 K12 denial and
cross-account threads · #1711 grey out zero-credit models · #1525 Windows proxy auto-detect ·
#1213 additive Claude Desktop catalog

Two of these deserve a note:

- **#2221** touches authentication-critical paths: native-main injects a read-only `auth.json`
  token without refresh ([auth-context.ts:550](../../../src/codex/auth-context.ts)), while only
  pool credentials pass through `getValidCodexToken`. Fixing ownership and replay is not a
  small change, and it is the one on this list most likely to bite users.
- **#2046** is half done: nested `detail.code` K12 detection already exists
  ([quota-rejection.ts:81](../../../src/codex/quota-rejection.ts)). What remains conflicts with
  current credential-affinity preservation and needs upstream thread-contract evidence.

No issue was classified INVALID. Several are partially implemented; their remaining acceptance
criteria are too broad to call quick wins.


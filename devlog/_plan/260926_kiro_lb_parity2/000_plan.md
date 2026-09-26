# 000 — Kiro auth and usage: second head-to-head with kiro-lb

Kiro accounts in opencodex already get safer quota readings than kiro-lb, but kiro-lb has moved
141 commits since our last comparison and now leads on several things an operator feels
directly: Kiro traffic ignores the configured egress proxy, a Kiro 503 or a suspended account is
not failed over, quota evidence is forgotten on restart, every login goes through `kiro-cli`,
and there is no per-account concurrency, model catalogue, or measured credit. This unit closes
each of those as one stacked PR, keeps every place where we are already stricter, and ends with
a head-to-head written from the landed tree. Research: `001_research_gap_inventory.md`.

## Loop spec

- **Archetype:** satisfy-spec, multi-cycle (one PABCD cycle per layer), HOTL under the session goal.
- **Trigger:** user request 2026-09-26: land #5937, re-pull kiro-lb into `/tmp`, adopt everything
  worth adopting as a stacked PR chain, run it through cxc-loop, merge to dev; the Kiro auth and
  usage approach must end up better than kiro-lb's.
- **Goal:** every "Adopt" row of 001 implemented with a regression test and merged to dev; every
  "Reject" row keeps its written reason in the final head-to-head.
- **Non-goals:** non-Kiro providers (shared seams are touched only through Kiro-scoped options),
  release or promotion, the IDE wire fingerprint (W1/W2), new endpoint dialects (E1), paid
  endpoint probes (E4), MCP web search (S2), multiplier estimates (U1), any credential or account
  data in the repository.
- **Verifier per layer:** `bun run typecheck`; the layer's focused test files; `bun run
  test:changed`; `bun run privacy:scan`; `bun run structure:check`; exact-head hosted
  Cross-platform CI (test shards, gates). Each decade doc names its focused files and the
  activation scenario for every conditional path it adds.
- **Stop condition:** 070 merged, dev CI after the last merge green, `080_head_to_head_result.md`
  written from the landed tree.
- **Memory artifact:** this unit; goalplan `.codexclaw/goalplans/opencodex-kiro-auth-usage-parity-and-surpass-loo/`.
- **Terminal outcomes:** DONE as above; BLOCKED if hosted CI or merge rights fail three times in a
  row; UNSAFE if a layer would need AGPL code or weaker credential isolation; NEEDS_HUMAN for a
  behaviour that only a live account can prove *and* that changes auth semantics (recorded, not guessed).
- **Escalation:** a layer whose live-evidence assumption cannot be made safe by the
  "unknown stays harmless" rule below goes back to P, not forward to B.
- **Resource bounds:** no token or time budget was set by the user. Tools: local shell, gh on
  `lidge-jun/opencodex`, read-only clone at `/tmp/kiro-lb`. Writes: the paths each decade doc
  names, this unit, and `.tmp/`.

## Safety rule shared by every layer

kiro-lb's source tells us what upstream strings and endpoints look like; nothing here was
observed live from opencodex. So every new branch that reacts to an upstream signal must be
harmless when the signal is absent or shaped differently: unknown quota stays usable, an
unrecognised refusal is an ordinary failure and never a quarantine, an unrecognised model list
falls back to the static catalogue, a failed login persists nothing, an unrecognised metering
frame is omitted. Tests pin both the recognised and the unrecognised shape.

## Layer map (manual stacked chain, merge bottom-up)

| # | Layer | Branch | Depends on | Adopted rows |
|---|---|---|---|---|
| 010 | Usage probe and restart continuity | `codex/kiro-lb2-010-usage-persist` | dev (#5937 landed) | S1b, B/P7 |
| 020 | Transport: egress, 5xx rotation, timeouts, public 5xx text | `codex/kiro-lb2-020-transport` | 010 | E5, E2/H, E6, E7 |
| 030 | Account-level refusal classes and failover | `codex/kiro-lb2-030-refusal-failover` | 020, 010 verdict store | P4/I, P5/E3, A5, P9 |
| 040 | Per-account load: concurrency cap and least-loaded choice | `codex/kiro-lb2-040-account-load` | 030 eligibility | P3, P1/P2 |
| 050 | Per-account model catalogue | `codex/kiro-lb2-050-model-catalog` | 040 selection seam | C1/N, C2, C3 |
| 060 | Native device login (Builder ID, Google, GitHub) | `codex/kiro-lb2-060-device-login` | 010 profile contract | A1/A2/A9 |
| 070 | Measured credits, quota metrics, routable reason | `codex/kiro-lb2-070-credits-ops` | 010 cache, 030 eligibility | P8/J, K, L |
| 080 | Head-to-head method (080, rides in 010) and result (081, final docs PR after 070 merges) | `codex/kiro-lb2-081-head-to-head` from dev | all | — |

Order follows build dependency: persisted evidence (010) → a transport whose failure classes are
clear (020) → account decisions made from those classes (030) → load and model evidence feeding
the same selection seam (040, 050) → onboarding that relies only on the 010 profile contract
(060) → observability of all of the above (070). 060 does not depend on 040/050; it sits above
them because the user asked for one chain, and one chain keeps rebases mechanical.

This document and 001 ride in the 010 PR; each decade doc rides in its own layer's PR.

## Architect consultation

Handle `01a0dddd-7a7b-7be1-9079-675c27b552d8` (gpt-6-sol, read-only), proposal 2026-09-26 on
001 plus the draft layer map. Dispositions:

| Decision | Disposition |
|---|---|
| D010-1 resolver + `builderIdFallback` for the probe, CREDIT-only fixture | **Already landed** in #5937's final head (`7c77efb`), which reworked itself after review. 010 keeps only a regression that the probe and runtime share one resolver |
| D010-2 no request without a formable ARN; keep last good row | Accept |
| D010-3 persist verdict beside the quota row, same key and generation guard, expire at min(reset, TTL), clear on removal; `quota.ts` is at 558/558 so mechanics live in siblings | Accept |
| D020-1 executor on every physical send incl. reset and alternate | Accept |
| D020-2 502/503/504 before output → existing `q.*` alternate, once, inside the send budget | Accept |
| D020-3 deadline expiry ≠ caller abort; fixed public 5xx text | Accept |
| D030-1 Kiro refusal classifier (`rate`, `monthly_quota`, `suspended`, `other`) outside `adapter-dispatch.ts` | Accept |
| D030-2 class passed to the generic rotation seam; rotate only before output and within budget | Accept |
| D030-3 terminal refresh rejection → reauth + try another; served success supersedes older verdict, fenced by identity and order | Accept |
| D040-1 process-local lease ledger, bounded wait, falls through to another account | Accept |
| D040-2 opt-in least-loaded strategy after eligibility filter, stable tie-break | Accept |
| D050-1/2 per-account ListAvailableModels, last-good on failure, static before first read; membership is preference only | Accept |
| D060-1/2/3 server-owned device-flow state, commit only on approval, Builder ID profile never persisted | Accept |
| D060 split into Builder ID and social PRs | Reject: one layer, two separable commits; the user asked for one chain, and the social half is gated by the same "failed login persists nothing" rule |
| D070-1/2/3 measured credits from usage frames, bounded opaque quota gauges, routable + closed-set skip reason from the routing projection | Accept |
| Two stack branches after 030 | Reject: see order paragraph above |
| Drop 050 until a live capture exists | Reject: the static fallback makes an unrecognised reply harmless, which the safety rule already requires |

Reflection: see the section appended after the same architect's check.


## Constraints folded from the architect's reflection (MISALIGNED → resolved)

**File-size ratchet.** At capture time: `src/providers/quota.ts` 558/558, `src/server/index.ts`
891/893, `src/server/responses/core.ts` 198/210, `tests/providers/kiro/kiro-adapter.test.ts`
2050/2050, `tests/providers/kiro/kiro-stream.test.ts` 2258/2258, `tests/cli/cli-account.test.ts`
2313/2313, `tests/responses/openai-responses-passthrough.test.ts` 4809/4809. No layer adds a
line to a capped file; new logic lives in sibling modules and new cases in sibling test files,
each registered in both `scripts/test-layout/layout.json` (`explicit`) and
`tests/fixtures/test-layout-expected.json`. Each decade doc re-reads the baseline at its own P.

**Structure ownership.** Each decade doc names the `structure/` documents that own its source
areas (from `structure/INDEX.md`) and states which contract sentences change; C runs
`bun run structure:check` and diffs those docs.

**Lab boundary.** No layer adds an import that lets `src/router.ts`,
`src/server/lifecycle.ts`, or `src/server/responses/core.ts` reach `src/lab/`; every layer
that adds a shared import runs `bun test tests/lab/core-lab-boundary.test.ts` in C.

**060 acceptance gates (one PR, two commits, separate gates).** A device flow is bound to the
account slot it was started for; completing it under a different identity than a reauth target
refuses to replace that credential; a flow cannot be completed by another flow's id or after
expiry; Builder ID client registration is stored only in the protected credential store and
never appears in a management response, log, or request snapshot; social and Builder ID paths
each have their own positive and negative tests. The earlier "failed login persists nothing"
reason alone was insufficient and is superseded by these gates.

Reflection result after folding: all D-IDs mapped (table in the reflection record,
`.tmp/kiro-lb-research/reflection.md`, scratch only); no reversed dependency; the one unsafe
disposition (060) now carries its gates.


## Round-1 audit synthesis (A loop, 2026-09-26)

Three independent reviewers (gpt-6-sol, fresh contexts) failed round 1 with 22 verified
blockers; reports are in scratch (`.tmp/kiro-lb-research/audit-r*-round1.md`). They reduce to
eight root causes, each fixed once as a shared decision that every affected decade doc applies:

| SD | Root cause | Decision | Changes decision |
|---|---|---|---|
| SD1 (superseded by SD1' below) | Evidence keyed by account id alone survives a credential replacement in the same slot (010, 030, 050) | `kiroEvidenceIdentity(cred)` = sha256 of the stable non-secret identity tuple; every cached or persisted Kiro evidence row carries it and is unknown on mismatch. The store's `credentialGeneration` is unusable here because it hashes tokens and changes on every refresh (`src/oauth/store.ts:340-342`) | D010-3, D030-3, D050-1 |
| SD2 (superseded by SD2' below) | Routing reads raw caches, so hydration and TTL/reset bounds never reach the first routing decision (010, 030, 070) | `kiroAccountEvidence(accountId, now)` in `kiro-usage.ts` is the only routing read: hydrates once, bounds quota and verdict by TTL and reset, applies SD1 | D010-3, D030-2, D070-3 |
| SD3 | Refusal body cancelled before a replacement is admitted; two competing retry loops (030, 040) | The original refusal survives until admission; one bounded loop owned by 030, which 040 plugs into | D030-2, D040-1 |
| SD4 | Proactive choice ran with the pool switch off; a known-dead active account still got the first send (030, 040) | Proactive ranking only under effective enablement; cap and refusal exclusion apply at initial admission; a singleton still sends | D030-2, D040-2 |
| SD5 | `routable` promised more than dispatch does (070) | Renamed `autoSelectable` + `skipReason`, documented as automatic-selection eligibility | D070-3 |
| SD6 | Catalogue request re-derived region from the Builder ID service ARN (050) | Reuse `kiroUsageContextForAccount` and an exported `kiroManagementHost` | D050-1 |
| SD7 | A diagnostic logged upstream message text that redaction cannot recognise (020, 060) | Logs carry closed-set codes and statuses only | D020-3, D060-1 |
| SD8 | Verifier results were recorded before dependencies were installed | Re-run; `tests/server/account-pool-management-api.test.ts` fails only because this worktree lives under `~/.codex` (test-home guard, verified 2026-09-26); hosted CI is its evidence | — |

Other folds: 020's timeout normalisation moves into Kiro's retry layer with a Google regression
(non-Kiro scope); 060 fixes first-account rollback, rejects unbound `--reauth`, validates client
registration sizes; 070 makes credit parsing header-independent with an unexpected-header test and
refuses future-dated gauge rows; 001's #5937 row is corrected; `080_head_to_head_method.md` added.


### Architect recheck (same architect, 2026-09-26): MISALIGNED → folded

Four gaps, all accepted: SD1 hashed `authType`, which is never stored, and could not tell two
identity-less logins in one slot apart → SD1' adds an opaque `loginId` written on every login
and kept across refresh, and drops `authType`. SD2 re-read `auth.json` per account per
filter → SD2' takes the roster account from the caller. SD3 left Kiro on the run-turn 429 arm
(`src/server/responses/run-turn-execution.ts:371`) and reordered accounting for every provider →
SD3' covers every Kiro arm and scopes the reorder to Kiro, with non-Kiro regressions. SD4 moved
accounts under an explicit `enabled: false` → SD4' keeps explicit off authoritative; a
configured `maxConcurrentPerAccount` that cannot move fails after its bounded wait with a
retryable 503 `account_capacity`. Record: `.tmp/kiro-lb-research/arch-recheck.md` (scratch).


## Audit result (A loop closed after round 3)

Round 1: 3 × FAIL (22 blockers) plus architect recheck MISALIGNED (4 gaps). Round 2: 3 × FAIL
(all 22 closed; 10 new). Round 3 (same round-2 reviewers, resumed): PASS, GO-WITH-FIXES
(blockers=0), PASS. Reports: `.tmp/kiro-lb-research/audit-r{1,2,3}-round{1,2,3}.md` (scratch).
Round 2 used fresh reviewer contexts that were handed the full round-1 reports rather than the
round-1 reviewers themselves; round 3 resumed the round-2 reviewers.

Carry-forward residuals (non-blocking; each is resolved at the named layer's P, which re-verifies
its doc against the landed lower layer anyway):

| Layer | Residual | Resolution at that P |
|---|---|---|
| 030/040 | The run-turn Kiro branch tries one candidate, so 040's "full first alternate, free second" run-turn test has no code | Add a bounded candidate/exclusion loop to 030's run-turn Kiro branch mirroring the adapter loop, or drop that run-turn test with the reason |
| 040 | `maxCandidates` may count the refused account | Compute after recording the refusal |
| 050 | A fallback sweep that finds every fallback unresolvable returns `stale` (409) before the bounded wait | Return `stale` only after a real selection change |
| 050 | `requestedModelId` parameter name assumed on `rotateGenericOAuthAccountOnRefusal` | Match 030's landed signature |
| 070 | Note at 070:390 names `tests/oauth/kiro-refusal-transport.test.ts` and `tests/oauth/kiro-account-capacity.test.ts`, which no layer registers | Point at the landed 030/040 test names instead |
| 070 | Health projection omits the `family` argument to `isCooled` | Pass it for future-proofing |
| 030/040/050/020 | 010 renamed the in-memory verdict timestamp to `observedAt`, dropped `overageEnabled`, and moved `kiroManagementHost` to 050 (wp2 P) | Correct 030:4,257,271-272; 040:510; 020:9; 030:583; 050 references at each layer's P |

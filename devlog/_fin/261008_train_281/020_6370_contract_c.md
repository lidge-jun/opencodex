# 020 wp3: #6370 canonical spend pool under downgrade contract C

## Decision (owner-delegated design, 2026-10-08)

Contract C: every journal record the new version writes is interpreted by the shipped 2.80.0 reader exactly
as 2.80.0 interprets records it wrote itself. Downgrade restores 2.80.0 per-label interpretation. It does not
retain new-version canonical aggregation and does not promise the allowance 2.80.0 would have computed for
the same traffic. No restore/launch fence, no wrapper enrollment, no reconciliation CLI.

Basis: architect proposal D1-D7 and its reflection on C (scratch: `.tmp/lanes/s-6370/.tmp/6370-arch/`
proposal.md, reflection-c.md, candidate-proof.json, reflection-c-proof.json). The fence design (D2) was
rejected for scope: recovery launchers, installed Windows wrapper enrollment and a reconciliation CLI
(600-1,200 production lines) to protect an aggregate guarantee no released version had.

## Changes on `codex/carry-6370-spend-pool` (from PR head 7f75339fde, merged with dev)

- E1 Canonical attribution kept (spendPoolId, canonical tracker selection, final-route normalization, Messages
  route setup, combo parent update, exact permit/report integration). Bookings use only `h("pool", P)` in
  the existing label domain. Remove the `pool-current` domain and persisted `checkpoint.poolContinuity`
  identity bindings from writer, parser, apply and checkpoint. Alias aggregation (spendPoolAliases plus the
  conservative unbound overlay) is read-time only and counts each original bucket once.
- E2 Salted collision validation: reject `spendPoolAliases[h("pool",P)] = Q` with Q != P, computed with the
  home salt at the ledger/config boundary on load, write, reconfigure and provider-set changes (adding P later
  turns an existing `h("pool",P) -> Q` mapping into a conflict and must be rejected then).
- E3 Corruption: restore dev behaviour (compaction continues; configured reservations refuse only while
  corruption is in memory); keep the PR's complete-final-JSON (`null`) rejection.
- E4 Dormant unbound history expires at the existing retention cutoff (strictly before), never earlier under
  capacity pressure; its ordinary `drop` is durable before admission uses the reduced total.
- E5 (ENFORCED requests only: at least one applicable root/identity/pool reference has a configured ceiling;
  unconfigured traffic keeps dev behaviour, including omitted bookings at capacity). Already-sent usage is never
  dropped. Each concrete target/key gets a pre-send seed reservation at NORMAL capacity before its first physical
  send (adding the missing anchor on the passthrough and generic-adapter initial dispatch paths); a request
  that cannot seed is refused before the wire. Later already-sent bookings for that target reuse the seed's
  exact scope refs, so reported overflow allocates zero new scopes; over-cap send entries are admitted only
  against a live seed and are forgotten after final settlement, behind a reporter completion barrier so no
  settlement arrives after forget. The per-request physical send limit L (frozen at actual start) is enforced on
  every reporting path. Bound: remembered sends <= Msend x Lmax, zero overflow scope allocations. Callers and
  proof obligations: 021.
- E6 Zero-config: no continuity checkpoints; record kinds, counts and bytes equal dev for equal pool inputs.
- E7 Experimental journals: journals written by unpublished #6370 builds (`pool-current` scopes or send
  targets, `poolContinuity` checkpoints) are excluded from contract C. The new reader keeps those balances as
  conservative unbound history (counted against every candidate, expiring under E4); it does not convert or
  delete them. No released version wrote this format.

Implementation map, callers and bound proof: 021_6370_diff_map.md (E5 uses per-target pre-send anchors).

## Regression tests (red before, green after)

- Frozen 2.80.0 reader fixture: every new-version record kind parses and sums identically (E1, C).
- Responses account labels A/B and native Messages share one ceiling; combo charges actual providers (E1).
- Salted collision rejected on load, write, reconfigure, and when the conflicting provider is added later (E2).
- Read-time partition: P's own canonical bucket that is also unbound counts once; absent, partial and complete
  alias maps; restart without automatic canonical self-binding keeps unmapped history conservative (E1).
- One corrupt middle line: compaction runs, ceilings enforce while corrupt, behaviour equals dev (E3).
- 30 settled + 10 unresolved unbound, retention 10: kept before cutoff and under pressure, expired after,
  restart does not resurrect (E4).
- Pool-only rootless enforced request at maxTrackedScopes=1: 40 retained + 70 delayed terminal usage gives
  110, and old replay refuses the next token (E5).
- Root + identity + pool enforced request with maxTrackedScopes=3: seeded normally, delayed already-sent usage
  books all three scopes, no fourth scope is allocated (E5).
- Seeds: an enforced request that cannot seed at normal capacity refuses before the wire (passthrough and
  generic adapter initial paths, rootless included); concurrent delayed reports and sequential distinct-scope
  requests keep remembered sends <= Msend x Lmax and allocate no overflow scopes; no settlement after forget;
  unconfigured traffic at capacity behaves as dev (E5, T5/T9 in 021).
- Experimental `pool-current` journal: balances kept as unbound overlay, not deleted (E7).
- Three settled sends without spend config: record shapes and counts identical to dev (E6).

## Verification and merge

Focused spend, ledger, continuity, wiring and capacity tests; typecheck, structure:check, privacy:scan,
layout and file-size ratchet; independent sol security review on the exact head; exact-head CI; squash merge
with `Co-authored-by` credit for luvs01; close #6370 summarising contract C and each resolved blocker.
Docs: `structure/transports/responses-spend.md` and the configuration reference state C's downgrade limit.

# 030 — WP3: pull-request disposition

Sweep of all open pull requests against `dc4dd45b0`, run as a dedicated
read-only audit. Method: read each PR's description and diff, then check
whether an equivalent change already landed on `dev`, and measure how far
behind the head is.

## Result

| Bucket | Count |
|--------|------:|
| SUPERSEDED-CLOSE | **0** |
| STALE-NO-ACTIVITY | 3 |
| VIABLE-KEEP-OPEN | 9 |
| NEEDS-MAINTAINER-DECISION | 8 |
| Total open | 20 |

**No pull request is closable.** Not one open PR has been superseded by a
merged change — every one proposes something the tree still lacks.

The count moved throughout this unit: 19 at the start, 20 during the sweep
(#1397 Nous Portal opened), and **17 live at re-check** — #1396 and #1010 both
merged to `dev` while the audit ran, and #1394's CL-06 work continued. The
zero-close conclusion is unaffected: PRs left the open set by *merging*, which
is the opposite of the "close as superseded" action this sweep was looking for.

Draft status was deliberately not used as evidence against a PR: per
`AGENTS.md` and `MAINTAINERS.md`, contributor PRs *open* as drafts and stay
there until the four-box readiness checklist is complete, so "still a draft"
describes the gate, not the contribution.

## Stale but not superseded (nudge, do not close)

| PR | Author | Behind | State | Why it stays open |
|----|--------|-------:|-------|-------------------|
| #1161 | waw4303 | 822 | conflicting | #1327 published vision describers; it did **not** implement the proposed chat/Google description executor |
| #1008 | lidge-jun | 990 | conflicting | The 500k read cap and `c8fddb847` hydration bound defer reads; neither creates the durable daily rollup |
| #581 | letr1n1ty | 2,008 | conflicting | `zh-TW` is still absent from the locale tree — and the Turkish locale that just landed proves the slot is live |

These need a rebase from their authors. Closing them would discard real
unshipped work.

## Viable, keep open

#1396 (bound reset-credit lookup responses, 0 behind, ready), #1394 (CL-06
routing compatibility policy — correctly stacked on the CL-05 merge
`1072b9c39`, 12 behind), #1380, #1357, #1345, #1165, #1164, #1155, #1010.

Two are worth naming. **#1394** is the next phase of the Compatibility Lab
stack whose CL-03/04/05 just merged; its merge base is the CL-05 merge commit
itself, so the stack discipline held. **#1010** has merged current `dev` into
its branch, sits 0 behind, and has all four readiness boxes ticked — it is the
closest to landing of any open PR.

## Needs a maintainer decision

| PR | Decision required |
|----|-------------------|
| #1315 Chutes, #1317 Featherless, #1318 Novita | Whether each service's terms establish **aggregator routing authorization** under the `MAINTAINERS.md` provider-evidence bar. All three supply endpoint, entity, owner, and dated probe evidence; the gap is authorization to resell/route third-party models. Fallback if unproven: an inert `src/providers/free-directory.ts` row instead of a canonical preset. |
| #1397 Nous Portal | Same bar, weaker evidence: mocked-only verification, no complete ToS/entity/owner record. |
| #1367 | Whether custom providers may control a registry-only streaming policy, and whether the unrelated WebSocket tightening must be split out. |
| #1361 | Whether DeepSeek stream repair and routed code-mode/`exec` enablement may land as one change, given the expanded tool boundary. |
| #1209 | Whether to expose an override making proactive delegation universal, overriding codex-rs effort-derived semantics. |
| #811 | Whether the signed cross-platform agent architecture is still wanted at all — 112 files touching release workflows and signing authority, 2,344 behind, inactive since 2026-07-31. If yes, request a narrowly audited rebuild rather than a rebase. |

All six provider/credential PRs additionally require the explicit security
review that `MAINTAINERS.md` mandates for credential-destination changes.

## Action taken in this loop

None. WP3's honest output is the disposition itself: zero closes, with the
maintainer decisions above surfaced for the owner. Closing a contributor's PR
that is neither superseded nor obsolete is a social cost with no benefit, and
the goal forbids merging contributor PRs in this loop.

# 000 — quota_window_and_backlog: Plan

## Objective

Codex removed the 5-hour rate-limit window some time ago and has now re-introduced it for
**Plus and Team**, while **Pro stays weekly-only**. OpenCodex has two quota parsers and only one
of them learned the lesson. Display and pool routing are both wrong for the affected plans.

Additionally: hide the Codex Spark window by default behind an operator switch, land three
quick wins, and close the backlog items that are already terminal.

## The observed failure (proven live, not inferred)

Running both parsers against the SAME upstream data on `dev` at `0a0a8821b`:

```
headers {primary 97% / 300 min, secondary 12% / 10080 min}
  parseUpstreamQuotaHeaders -> {"weeklyPercent":97,"weeklyResetAt":...}
  parseUsageQuota (WHAM)    -> {"shortPercent":97,"shortWindowSeconds":18000,"weeklyPercent":12}
```

The header parser has only a monthly-vs-else branch
([quota.ts:344](../../../src/codex/quota.ts)), so **anything that is not explicitly monthly
becomes weekly** — including a 5-hour burst window. The WHAM parser classifies by duration
([quota.ts:205](../../../src/codex/quota.ts), `isExplicitShortWindow`) and gets it right.

Three consequences, in increasing order of damage:

1. The genuine weekly reading (12%) is **discarded** — `weeklyPercent` is overwritten by the
   burst value before the secondary is ever consulted.
2. A 5h-exhausted account records `weeklyPercent: 100`. `isCodexQuotaExhausted` returns true,
   which is the right answer for the wrong reason — and it **stays** true after the 5-hour
   window resets, because nothing re-derives it until a WHAM refresh lands. Pool routing keeps
   avoiding a healthy account.
3. The GUI shows a weekly bar at 100% and **no 5h bar at all**, so the operator cannot tell
   which limit they actually hit.

The comment directly above the call site records the now-stale premise:
*"primary was the 5h window; it now carries weekly data for GPT plans"*
([core.ts:3777](../../../src/server/responses/core.ts)). That was true while the 5h window was
gone. It is not true now.

Corroborating evidence that this is a parser gap rather than a missing feature:
`tests/ws-endpoint.test.ts:287` already carries a `"x-codex-primary-window-minutes": "15"`
fixture — a 15-minute window — and nothing in the suite classifies it as short.

## Loop-spec

- **Loop archetype:** verifier-defined repair (wp1, wp3-wp5), judged design (wp2), evidence
  closure (wp6-wp7).
- **Trigger:** owner report that Codex restored the 5h limit for Plus and Team.
- **Write scope:** `src/codex/quota.ts`, `src/providers/registry.ts`,
  `src/providers/quota.ts`, `src/config.ts`, `src/types/`, `gui/`, `docs-site/`, `tests/`,
  `devlog/`.
- **Out of scope:** npm publish, tag push, main/preview promotion, security pre-disclosure
  notes in devlog, rewriting the WHAM parser (it is correct — the header parser converges on
  it, not the other way round).
- **Verifier:** focused `bun test` per phase; `bun run typecheck` + `bun run test` before each
  merge; `cd gui && bun test` for GUI phases.
- **Stop condition:** seven work-phases merged to dev, every named issue/PR terminal, dev HEAD
  green.
- **Bounds:** commits are `--no-verify`; CI is fixed at the end; admin squash-merge per phase.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010 | Header parser learns the duration rule; Plus/Team get a 5h bar, Pro unchanged | — |
| wp2 | 020 | Spark hidden by default + Codex Auth switch | — |
| wp3 | 030 | #2406 CommandCode image capabilities | — |
| wp4 | 040 | #1215 OpenCodex-scoped noProxy | — |
| wp5 | 050 | #1060 subscription billing-period date | — |
| wp6 | 060 | Evidence-backed closures (#2442 #2423 #2060, PR #1769 #2215) | — |
| wp7 | 070 | Backlog triage devlog | wp6 (records what wp6 closed) |

wp1 is sequenced before wp2 for review clarity, not as a data dependency (audit finding 7):
both touch the quota display contract, and hiding one row is easier to review once the
neighbouring 5h/weekly rows are correct. Neither consumes the other's output. wp3-wp5 are independent and could run in any
order; they are sequenced by ascending blast radius. wp7 is last because it records wp6's
outcome.

## Accept criteria

Mirrored into the goalplan `criteria[]` — see `.codexclaw/goalplans/opencodex-quota-window-backlog-cleanup-loop-2608/goalplan.json`.

The load-bearing one is wp1's: **given identical upstream data, the two parsers must agree**.
That is a property, not an example, and it is the assertion that would have caught this defect
when the 5h window first disappeared.


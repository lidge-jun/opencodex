# 004 — Audit rounds 2-8: verdict ledger

Eight audit rounds ran against this plan. `003_audit_synthesis_round1.md` covers
round 1 in detail; this file records the rest and the mechanical caveat about
how the verdicts were captured.

## Round ledger

| Round | Reviewer | Verdict | Outcome |
|-------|----------|---------|---------|
| 1 | explorer A (gpt-5.6-sol, medium) | FAIL, 9 blockers (3 High) | Design pivoted to a provenance channel |
| 2 | explorer A | GO-WITH-FIXES, 4 (Medium/Low) | Strict-parser risk cleared empirically |
| 3 | explorer A | NEAR-PASS, 1 Medium | Remote verifier rewritten as a scratch clone |
| 4 | explorer B (fresh, gpt-5.6-sol, medium) | FAIL, 1 High + 2 Medium | Combo synthesizer + missing issues found |
| 5 | explorer B | FAIL, 2 High | Antigravity synthesizer found; remote steps not fail-closed |
| 6 | explorer B | NEAR-PASS, 1 Medium + 1 Low | Step self-containment; scope boundary |

Every finding across all eight rounds was ACCEPTED and folded. None were rebutted.

## What the audit actually prevented

Three defects would have shipped without it, each invisible to the test suite:

1. **Tool support silently revoked** (round 1). Repairing the catalog lookup
   would have armed the `catalogRow === undefined` guard at
   `src/routing/capability.ts:178`, removing `tools: true` from every
   openai-chat and anthropic candidate.
2. **Synthesized defaults presented as fact** (round 1). Reading
   `context_window`/`input_modalities` directly would have converted unknown
   into `image: false` and a fabricated `128000`.
3. **Two synthesizers labeled as provenance** (rounds 4-5). The combo path
   (`provider-fetch.ts:697/793` -> `aggregation.ts:164`) and the Antigravity
   producer (`antigravity-models.ts:334`) both manufacture values from
   defaults. The second carries a real provider name, so the first guard alone
   was insufficient.

Round 6 traced eight CatalogModel-producing paths and found no third
synthesizer: configured metadata (`provider-fetch.ts:1100`), Antigravity (1338),
live discovery (1372), native combo injection (1698), custom models (1786),
trusted OpenAI rows (1904), jawcode metadata (1963), and combo derivation
(`aggregation.ts:164`). Cursor's defaults stay inside its static catalog
(`src/adapters/cursor/discovery.ts:172`, `src/providers/registry.ts:961`).

## Pre-existing remote failures (round 6)

A full `bun run test` at this unit's head on the remote host produced:

    12299 pass, 11 skip, 7 fail, 7 errors

All seven are missing `react` / `react/jsx-dev-runtime` in the scratch clone,
and the same seven files reproduce on a fresh `dev` checkout. No failing file
touches this unit's catalog, routing, or Antigravity surfaces. C must still
reach its own verified run rather than inheriting this one.

## Verdict-capture caveat (honest record)

`cxc review-round` records a verdict through a `SubagentStop` hook matching
`^explorer$`, which fires for plugin thread-spawned children. The reviewers here
were dispatched through the host's `multi_agent_v1` surface, so the hook never
observed their exit and rounds r1-r4 stayed `in_flight` despite real reviewer
exits carrying the required `LAUNCH:`/`VERDICT:` lines.

This is a transport mismatch, not a missing audit. The verbatim verdict lines,
the blockers, and the path:line evidence are recorded in this file and in `003`,
and the A->B attestation carries the pasted reviewer tail. Anyone re-verifying
should read the reviewer output quoted here rather than the round status.
## Rounds 7-8 (fresh reviewer C)

| Round | Verdict | Finding |
|-------|---------|---------|
| 7 | FAIL, 1 High + 1 Medium | `applyCatalogMetadata` is a SECOND writer of real values that the provenance stamp could not see |
| 8 | NEAR-PASS, 2 Medium + 1 Low | Extraction scope, missing context-cap regression, malformed table row |

Round 7 is the most important finding of the whole audit after round 1's B2.
Rounds 4-6 audited **producers** — paths that manufacture a `CatalogModel` — and
correctly concluded there were exactly two synthesizers. Reviewer C inverted the
lens and audited **writers** — anything that writes `context_window` or
`input_modalities` onto an entry — and immediately found
`applyCatalogMetadata` (`src/codex/catalog/parsing.ts:458`), which writes REAL
values from the generated jawcode metadata table without ever touching a
`CatalogModel`. A stamp reading `model.*` alone would have carried identity only
for every provider that depends on that table:

    catalogModel: { "provider": "opencode-go", "id": "grok-4.6" }
    serialized:   { "context_window": 500000, "input_modalities": ["text","image"] }

Auditing one direction exhaustively is not the same as auditing the other. That
is the transferable lesson from this unit.

Round 8's writer sweep then closed the question: the complete set of assignments
is `effort.ts:126,134` (CatalogModel), `parsing.ts:466,471` (generated metadata),
`parsing.ts:277,290` (native-only overrides), and `parsing.ts:316,326,329`
(strict-parser defaults). No third real-value writer exists. An independent
sweep from the main agent reproduced exactly that list.

Round 8 also caught that the two new regressions omitted `contextCap`, so an
implementation stamping an uncapped `500000` against a capped `350000` entry
would have passed. A capped-metadata regression was added, carried through
`candidateCapabilityEvidence` so the value is asserted end to end.

## Final tally

Eight rounds, three independent reviewers, 22 findings. Every one accepted and
folded; none rebutted. Four would have shipped real defects:

1. Tool support silently revoked for openai-chat and anthropic (round 1).
2. Synthesized strict-parser defaults read as routing evidence (round 1).
3. Two synthesizers stamped as provenance — combo and Antigravity (rounds 4-5).
4. Real generated metadata invisible to provenance (round 7).

## Verdict-capture caveat, updated

The `SubagentStop` review observer requires `payload.agent_type === "explorer"`
(`components/pabcd-state/dist/review-observer.js:32`). Two things were checked
here:

- `cxc doctor` reported the observer hook UNTRUSTED, so it could not have run at
  all. `cxc hooks retrust` fixed that — 22 hooks now trusted.
- Even after retrust, the rounds stayed `in_flight`. The session rollout shows
  `SubagentStop` events firing (15 occurrences) but carries no `agent_type`
  field, so the observer's first guard returns early.

The audit itself is unaffected: the reviewers really ran, really produced
`LAUNCH:`/`VERDICT:` lines bound to the issued launch ids, and their verbatim
output is recorded here and in the A->B attestation. What is missing is the
machine-recorded verdict, not the audit. This is worth reporting upstream as a
host-surface gap in the observer's payload contract.

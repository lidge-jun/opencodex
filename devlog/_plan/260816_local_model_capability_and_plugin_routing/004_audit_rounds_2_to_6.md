# 004 — Audit rounds 2-6: verdict ledger

Six audit rounds ran against this plan. `003_audit_synthesis_round1.md` covers
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

Every finding across all six rounds was ACCEPTED and folded. None were rebutted.

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

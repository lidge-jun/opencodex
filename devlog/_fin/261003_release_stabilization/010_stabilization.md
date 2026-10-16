# Scoped stabilization and progressive integration

Depends on the roadmap. The change is from open/unverified source PRs to reviewed,
tested PRs landed on dev with traceable authorship and issue dispositions.

## Dispatch change map

NEW ignored `.tmp/release-stabilization/lanes.json`: per lane id, canonical task/host,
worktree, branch, base SHA, scope, PR/head, status and evidence. Creation receipts
retain provisional IDs separately until host evidence establishes canonical identity.
MODIFY this unit with source PR dispositions and integration proof as each lands.
No runtime edits are authorized by the roadmap cycle itself.

Five ordinary worktree tasks start on freshly fetched dev, use inherited model settings,
and may commit, push their own branches, create/revise PRs and run relevant CI. Only the
coordinator merges, closes superseded sources, promotes or publishes. Existing PRs are
preferred when writable and coherent; carries preserve Co-authored-by trailers.

Creation during the coordinator roadmap is planning-only: P/A/docs are allowed,
but runtime edits, pushes and CI dispatch wait for the coordinator's explicit
`ROADMAP LOCKED` message after the roadmap D receipt. Record its commit/receipt
and per-lane delivery result in the manifest. Pending creation is not permission
to recreate a lane; verify the canonical task identity before delivering the gate.

| Lane | Scope | Primary runtime owners | Required activated evidence |
| --- | --- | --- | --- |
| A | #6504, #6508 | `src/server/responses/fetch-helpers.ts`, Messages/Responses error translation | oversized input yields actionable non-retrying error; large native UTF-8 upload preserves bytes and completes; small/non-native paths unchanged |
| B | #6496, #6507, #6505 | `src/codex/auth-api/`, `src/codex/main-account.ts`, account runtime/store, `src/combos/failover.ts`, Responses auth/combo files | revoked credential refresh/refusal; caller-owned bearer separation; plan-ineligible target hops while unrelated 400 remains terminal |
| C | #6502/#6497, #6509 | `src/providers/antigravity-models.ts`, `src/usage/expected-prices.ts`, `src/adapters/ollama-native.ts` | actual discovered wire IDs/effort routes including saved selection; live 404 comparison if accessible; tool batch/commentary/results replay with orphan and duplicate negatives |
| D | #6076 | `src/cli/gui.ts`, `src/lib/gui-pair-capability.ts`, `src/server/gui-session.ts`, management link routes/registry | independent security review; legitimate enrollment and join remain usable; unpaired attempts rejected; real bounded enrollment/join/restart acceptance |
| E | #6370, #6378 | spend ledger/continuity/budget, request accounting, `src/oauth/anthropic-routing.ts`, `src/oauth/index.ts`, token detection/store | historical upgrade admission and budget conservation; unresolved/corrupt history preserves guard; account rotation cannot adopt unrelated identity |

Each lane owns adjacent tests and its structure/user docs. Test inventory edits are
additive and the coordinator reconciles both inventories. B owns auth changes in
`core-options.ts`/`core-combo.ts`; E owns spending changes and rebases after B before
claiming merged-tree proof. A must coordinate any auth/combo overlap before writing.
A also lands before E's final composition checks; C and D prepare independently.
No concurrent checkout has authority over another lane's branch.

## Integration procedure

1. Refresh live dev, source PR head/base, membership and current reviews. Capture exact
   diff/commit provenance in scratch; do not replay stale patches unreviewed.
2. Each lane plans and audits its exact changes, performs activated focused tests,
   typecheck, privacy/structure and applicable GUI/docs checks, then independent review.
   Findings are fixed or rebutted against source evidence, never cleared by fiat.
3. PR readiness requires successful exact-head required CI with actual expected tests;
   absent, skipped, cancelled or old-head tests do not pass. Record security approval
   for auth/pairing/accounting boundaries. No lane runs final lane=all CI.
4. Coordinator verifies the returned diff, attribution, live head/base and review state,
   records authorized maintainer integration, and merges one PR at a time. A failed
   validation prevents the merge command. Refresh the next lane against landed dev.
5. Resolve post-merge review threads, close actually superseded source PRs with carry
   links, and close resolved issues with truthful acceptance limits.

Coordinator additionally owns #6220 launcher replay and #6473 Windows autostart acceptance.
Use available isolated environments, preserve production state and redact observations.
An absent launcher/account/Windows session is an explicit unmet native acceptance row,
not a passing fixture test. Classify its actual release consequence before candidate GO.

Security-sensitive findings or draft repair reasoning remain in ignored scratch.
Public plan text records only already-public scopes. A source PR with unresolved
adoption defects may be excluded only with an explicit evidence-backed disposition;
an unresolved existing release blocker cannot be hidden by excluding its proposed fix.

## Completion evidence

For every named item: current state, source and landed SHA or precise exclusion,
test commands/results, CI event/run/attempt/SHA, review/security disposition and
remaining native limits. Preserve failures. Do not run five full local suites in
parallel; focused local coverage plus required hosted coverage is the declared strategy.

# Preserve large native turns and terminal input-limit errors

Lane A will carry the native upload representation fix from PR #6508 and repair the loss of terminal context errors when Responses output becomes Claude Messages. The transport fix prevents a known large-string upload failure mode; the error fix lets a client distinguish input rejection from a retryable transport failure. Neither increases upstream context capacity or guarantees recovery of the issue reporter's private session.

Reader: the release coordinator and reviewers decide whether this lane is safe to integrate; they already know the release scope.

## Loop contract

- Archetype/trigger: satisfy-spec HOTL release stabilization, issue #6504 and PR #6508.
- Goal: byte-correct single native HTTP sends and classified non-retryable Messages context errors, published on this lane's attributed PR with exact-head checks.
- Non-goals: credential/account changes, model capacity changes, silent payload pruning, retries, merging, releasing, installed app changes, source-PR closure. Lane B owns core-auth/core-options/core-combo; coordinate through main for any needed overlap.
- Verifiers: focused transport and Messages regression files plus typecheck/privacy/structure/docs build; each conditional scenario below asserts observable output and send counts. Tests are named directly and observe changed source through imports. Full local suite exception is concurrent worktree contention; hosted applicable PR CI remains mandatory. Initial baseline failure was missing zod/v4; locked dependency installation subsequently succeeded and transport baseline passed 27/27.
- Stop: all scoped changes reviewed/published with required applicable exact-head CI successful and report complete. This lane does not merge.
- Artifacts: this numbered unit, ignored `.tmp/release-stabilization/` receipts and security notes, bound `.codexclaw` goalplan/FSM.
- Outcomes: DONE requires evidence; NOOP only if current dev contains the behavior; blocked/unsafe/needs-human means a named unresolved condition without weakened criteria. No user token/time budget; bounded commands, existing credentials only, no new paid resources.
- Escalation: conflicting ownership, upstream capacity ambiguity, absent CI capability or unresolved review; continue independent work. User scope remains authoritative.
- Coordinator gate: ROADMAP LOCKED received; coordinator docs-only commit 2152fdfeb8 with architect/reviewer PASS. Lane's own roadmap P/A remains required.

## Dependency map and file map

1. Roadmap: this master, 001 evidence, and 010/020/030 executable plans. Independent architect reflection and independent A audit before implementation.
2. Transport foundation: 010 carries source commit into our branch with its history/credit, then strengthens threshold/destination/cancellation tests; source and docs paths are listed in its exact diff.
3. Messages projection: 020 changes only Claude/encoder/ingress error projection, adjacent tests and owning docs. Tests reuse the now verified transport substrate; no credential code edits.
4. Final review/publication: 030 independently challenges both paths in parallel, resolves findings, verifies docs/gates, publishes ordinary dev PR and records successful applicable exact-head CI.

The repository is Bun-native TypeScript. Existing owners: src/server/responses transport; src/claude translation; src/protocols/encoders direct Messages encoding; tests/{responses,claude-integration}; structure current contracts; docs-site user workflows. Reuse these, with no new architecture or dependency.

## Architect consultation and main decisions

V1 subagent transport is available (send_input/close_agent); inherited model/effort, independent prompt context. Architect handle: 01a1020f-456a-7bf1-bde1-6e2edd721258. Proposal D1–D5 received against b82b39018b48ad489110b4165ee2cd9ba30433d5.

- D1 accepted, narrowed to the existing exact `context_length_exceeded` identity rather than new message heuristics or aliases; preserve that code through both encoders.
- D2 accepted: both non-stream collectors, defensive failed JSON and non-2xx reshaping must preserve the recognized context semantics. Unknown failures retain prior 502/529 behavior.
- D3 accepted: existing Responses 413 normalization owns safe generic copy. No new retry, account switch, tool stripping or compaction execution.
- D4 accepted: final destination, UTF-8 threshold, metadata and single-send invariants. Source carry is independent from error translation.
- D5 accepted with reachable-path refinement: native Responses passthrough does not enter direct encoders, so real native ingress tests cover legacy path and direct AdapterEvent tests separately activate direct encoding. Toggle parity alone is insufficient proof of direct execution.

Same-handle reflection ALIGNED on this concrete revision; three evidence clarifications incorporated (001). Independent A review GO-WITH-FIXES (blockers=0); all nonblocking clarifications incorporated. Roadmap approved for implementation after document receipt.

## Source-of-truth sync and scope

Update structure/transports/responses.md and byte-accounting.md for physical upload representation, structure/data-planes/inbound-compat.md for error projection, and docs-site server/Claude guide for behavior and recovery limits. Review affected map owners; do not copy unchanged contracts. Source fixes are not proof of the reporter's actual Claude retry/compaction behavior; synthetic wire proof and any actual client observation must be labeled separately.

## Roadmap cycle conclusion

Docs-only roadmap approved, source comparison and baseline evidence recorded. Next cycle carries PR6508 and verifies final-send invariants, followed by Messages projection. No runtime fixes are claimed by this cycle. Source-author live success and private-session issue causality remain unverified here.

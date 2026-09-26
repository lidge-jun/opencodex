# Design debt

## Scope

This audit covers the changes on `codex/grok-preflight-429` relative to
`08fd8a628`. It is not a repository-wide audit. Unchanged modules outside the
dependencies below are excluded because the requested scope is this branch.

| Module | Files | Role |
| --- | --- | --- |
| Responses turn execution | `src/server/responses/run-turn-execution.ts` | Runs adapter turns and chooses streamed or JSON responses. |
| Grok rate-limit regression | `tests/responses/responses-grok-devin-preflight.test.ts` | Checks streamed and buffered HTTP boundaries, event replay, exclusions, and cancellation. |
| Event preflight and replay | `src/adapters/run-turn-queue.ts`, `tests/adapters/run-turn-queue.test.ts` | Bounds the initial wait and transfers a pending iterator read to replay. |
| Management fixtures | `tests/server/management-provider-validation.test.ts` | Isolates DNS validation and model discovery from external networking. |
| Service fixtures | `tests/service/service-claim.test.ts`, `tests/service/service-wsl-home-ownership.test.ts` | Isolates both configured and legacy service-state paths. |
| Supporting registrations and docs | `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json`, both Grok Build guides, `structure/transports/responses-failover.md`, `structure/providers-and-adapters.md` | Registers the regression and describes the client behavior. |

The dependency review covered event preflight, adapter error mapping,
`resolveClientRetryAfter`, abort cleanup, and owned temporary test homes.
Generated code, dependencies, and unrelated directories are outside this audit.

## Findings

| ID | Severity | Flag | Location | Evidence | Smallest redesign | Status |
| --- | --- | --- | --- | --- | --- | --- |
| DD-001 | S2 | Repetition | `src/server/responses/run-turn-execution.ts:571`, `src/server/responses/run-turn-execution.ts:700` | The streaming and collected-response paths repeat the same web-search options. Both copies exist in the base revision. | Use one local wrapper that builds the options at each invocation, preserving the current `selectedForwardHeaders`. | Open, pre-existing; recorded 2026-09-26. |

DD-001 was checked against the local-coupling exception. Both calls accept an
`AsyncIterable<AdapterEvent>`, so the wrapper needs one argument and can preserve
the timing of option reads. It is separate from the Grok fix and was not changed.

## Duplication evidence

Nose 0.21.0 compared all changed TypeScript files with `--mode syntax`. The base
snapshot contained six files and 66 families. The candidate contains seven files
and 68 families. No source was skipped. The comparison retained 57 observations
and marked 13 for review, including ambiguous matches and unmatched observations.

The newly matched regions are provider PATCH test flows, OAuth test fixture setup,
and short SSE frame parsing expressions in the Grok tests. They remain separate because the cases
assert different contracts and the parsing is a short expression. A shared test
scenario abstraction would hide those assertions. DD-001 remains the only
confirmed design-debt finding; no new production duplication family was found.

This scan checks syntax duplication among changed files. It does not establish
the absence of semantic duplication or copies elsewhere in the repository.

## Audit record

- Date: 2026-09-26.
- Swept seven code files and their changed registrations and documentation against all APOSD red flags.
- Newly recorded findings: S1 0, S2 1, S3 0. Findings introduced by the branch: 0.
- Inconclusive modules within this scope: none. Repository-wide coverage is not claimed.
- Findings refuted in verification: 0. One repetition finding passed independent refutation review.
- Thermos review found two issues that were corrected: unconditional documentation promises about retry handling, and test cleanup that could skip environment restoration after lease-release failure.

The follow-up review covered bounded preflight, pending-read ownership, OAuth
retry permits, buffered response parity, replay-unsafe marker retention, and fixture isolation. No fixture review finding remained open.

# Design debt

## Scope

This audit covers the changes on `codex/grok-preflight-429` relative to
`08fd8a628`. It is not a repository-wide audit. Unchanged modules outside the
dependencies below are excluded because the requested scope is this branch.

| Module | Files | Role |
| --- | --- | --- |
| Responses turn execution | `src/server/responses/run-turn-execution.ts` | Runs adapter turns and chooses streamed or JSON responses. |
| Grok rate-limit regression | `tests/responses/responses-grok-devin-preflight.test.ts` | Checks the pre-output HTTP boundary, event replay, exclusions, and cancellation. |
| Supporting registrations and docs | `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json`, both Grok Build guides, `structure/transports/responses-failover.md` | Registers the regression and describes the client behavior. |

The dependency review covered event preflight, adapter error mapping,
`resolveClientRetryAfter`, abort cleanup, and owned temporary test homes.
Generated code, dependencies, and unrelated directories are outside this audit.

## Findings

| ID | Severity | Flag | Location | Evidence | Smallest redesign | Status |
| --- | --- | --- | --- | --- | --- | --- |
| DD-001 | S2 | Repetition | `src/server/responses/run-turn-execution.ts:541`, `src/server/responses/run-turn-execution.ts:665` | The streaming and collected-response paths repeat the same web-search options. Both copies exist in the base revision. | Use one local wrapper that builds the options at each invocation, preserving the current `selectedForwardHeaders`. | Open, pre-existing; recorded 2026-09-26. |

DD-001 was checked against the local-coupling exception. Both calls accept an
`AsyncIterable<AdapterEvent>`, so the wrapper needs one argument and can preserve
the timing of option reads. It is separate from the Grok fix and was not changed.

## Duplication evidence

Nose 0.21.0 compared snapshots of the changed TypeScript files with `--mode syntax`.
The base snapshot contained one source file; the candidate added the regression
file. Each snapshot had one duplication family. The comparison retained that
family with unchanged evidence and found no added family. The reported regions
are the two sites in DD-001. No source was skipped within these snapshots.

This scan checks syntax duplication among the changed files. It does not establish
the absence of semantic duplication or copies elsewhere in the repository.

## Audit record

- Date: 2026-09-26.
- Swept two code modules and their changed registrations and documentation against all APOSD red flags.
- Newly recorded findings: S1 0, S2 1, S3 0. Findings introduced by the branch: 0.
- Inconclusive modules within this scope: none. Repository-wide coverage is not claimed.
- Findings refuted in verification: 0. One repetition finding passed independent refutation review.
- Thermos review found two issues that were corrected: unconditional documentation promises about retry handling, and test cleanup that could skip environment restoration after lease-release failure.

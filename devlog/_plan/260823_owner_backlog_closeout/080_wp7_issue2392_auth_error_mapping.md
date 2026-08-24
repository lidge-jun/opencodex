# 080 — wp7: issue #2392, centralize Codex auth-context error mapping

## Item

`Ingwannu` issue #2392, "centralize Codex auth-context error mapping across
Responses and compact". No PR exists; this work-phase builds one.

## Investigation verdict

`gpt-5.6-sol` high, read-only, against `origin/dev`:

- STATUS REPRODUCES (structural), disposition FIX_SMALL, effort small.
- `src/server/responses/core.ts:1537` — regular Responses carries a full local
  exception matrix through `:1576`.
- `src/server/responses/compact.ts:397` — compact carries the same common matrix
  through `:414`, with its own `ForwardAdmissionCredentialError` at `:337`.
- `d52032ebe` (PR #2390) already fixed the user-visible half of this — the compact
  substitution failure — by adding one local 401 branch. What remains is
  duplication, not a defect, so the refactor must change no observable behavior.
- `tests/codex-envkey-admission-substitution.test.ts` 4/4 confirms both
  substitution paths return before upstream I/O.
- `tests/core-lab-boundary.test.ts` 13/13 confirms the protected-core guard on
  `src/server/responses/core.ts`.

## Why this one is riskier than it looks

The existing tests check status codes on both paths but not byte-level parity
(`tests/server-auth.test.ts:1889`, `:1900`). A refactor that folds two error
matrices into one can pass those tests while quietly changing a response body or
a `Retry-After`. So the characterization test comes first in the definition of
done, not last: it must assert identical status, serialized body, content type,
cooldown and drain `Retry-After`, thread-affinity 409, zero upstream I/O for
substitution, regular-only safe logging, and rejection of unknown errors.

The new module also becomes a dependency of a protected core file, so it has to
be a pure leaf — builtins and local types only.

## Plan

New `src/server/responses/codex-auth-error.ts` exporting a pure
`mapCodexAuthContextErrorToResponse(error, { accountSelector, now })` returning
`Response | undefined`. Core and compact delegate the common classes and keep
their endpoint-specific logging and admission handling local. Unmapped errors
rethrow rather than being swallowed. `structure/01_runtime.md` records the new
owner.


## Execution record

Built on `codex/fix-2392-auth-error-mapping`, rebased onto `81bf4b9a4`, opened as
PR #2450.

New pure leaf `src/server/responses/codex-auth-error.ts`. Seven error classes
moved to it; four things deliberately left local, each for a stated reason:

| Left local | Reason |
|---|---|
| regular-Responses pseudonymous reauth log | compact has no equivalent, folding it in would add a log line |
| `ForwardAdmissionCredentialError` (both paths) | not an auth-context resolution error |
| compact alternate-account `CodexMainProfileDrainingError` | returns `null` to preserve the first account's rejection |
| unmapped errors | rethrown in both handlers, never swallowed |

Verification: 147 pass / 0 fail on the four focused suites, `typecheck` exit 0,
`privacy:scan` pass, and a full `bun run test` at 14,521 pass / 11 skip / 0 fail
across 906 files. Independently re-run by the main session after rebase:
61 pass / 0 fail on routing, admission-substitution, and core-lab-boundary.

The full suite was run here despite the session's focused-proof instruction
because this is the authentication surface and `AGENTS.md` requires security
review for it.

## Landing record

PR #2450 merged to `dev` as `9cebfc64e`, CI 20 pass / 0 fail. Issue #2392 closed.

This clears the entire Ingwannu queue: six PRs and five issues, all with a
recorded terminal disposition.

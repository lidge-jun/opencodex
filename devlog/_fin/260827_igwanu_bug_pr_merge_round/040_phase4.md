# 040 — wp5: maintainer changes-requested — #2745, #2729

Both are authored by `lidge-jun` (the maintainer) and both carry a detailed
CHANGES_REQUESTED review from Ingwannu naming specific, reproducible defects.
Neither may merge as-is. Lane **L4 (fix-then-land)** for both.

## #2745 — fix(responses): rebind credential identity on every OAuth 429 rotation

Head `a90ab6ee7`, ready, MERGEABLE, 26 behind, 24 checks zero failures.
Touches `src/server/responses/core.ts` (+55/-11) and
`tests/generic-oauth-failover.test.ts` (+78).

**This is an OAuth credential-boundary change — the exact surface `MAINTAINERS.md`
requires explicit security review for.** It does not land on my judgement alone.

The PR carries a CHANGES_REQUESTED review with two open blockers: one credential
-boundary correctness defect and one test-oracle defect. **That analysis is
pre-disclosure material and is deliberately not reproduced here.** `devlog/` is a
public tracked directory, the defect is unfixed, and the PR is open, so per
`AGENTS.md` §"Security working notes" the reasoning, reproduction, and
remediation plan live in scratch (`.tmp/2745-security-triage.md`, gitignored) and
are readable on the PR itself via `gh pr view 2745 --json reviews`. Once the fix
ships, the write-up belongs in `_fin/` — not before.

`src/server/responses/core.ts` is also touched by #2638 and #2497 —
`git merge-tree` pairwise before a second one lands.

Disposition: **NEEDS_HUMAN.** Both blockers must be closed by the author, and the
credential-boundary change then needs explicit human security sign-off plus a
non-author maintainer approval at the exact merged head. Not landed this round.

## #2729 — fix(claude): derive response.failed status from the classified error

Head `19801d201`, ready, MERGEABLE, 89 behind, 24 checks zero failures.
Touches `src/adapters/cursor/cursor-errors.ts` (+8), `src/claude/outbound.ts`
(+17/-3), `tests/claude-outbound.test.ts` (+73), `tests/cursor-errors.test.ts` (+10).

Reviewer accepts the main diagnosis (Cursor `failed_precondition -> 400` is
correct, 157/157 across eight suites) but found one **error-fidelity regression**:

`httpStatusFromTerminalError` recognizes only `server_error + server_is_overloaded`
before falling through to message inference. A status-less envelope like
`{type:"server_error", code:"upstream_server_error", message:"...malformed tool
call arguments"}` returns **400** because the message contains "malformed".
Before this PR it became a transient 500. Result: Claude Code receives
`invalid_request_error` and **stops retrying a genuine upstream failure**. The
reviewer probed the exact head and got 400.

Fix: structured generic server classifications must win over message keywords —
map `server_error`/`upstream_server_error` and equivalent generic upstream codes to
transient 5xx, while retaining the specific 429/401/403/invalid-request/policy/
cancellation/explicit-overload mappings. Add a status-less regression using a
server-classified message containing an invalid-request keyword, asserting the
Anthropic tail stays `overloaded_error`.

Deferred, not blockers: the dead `translation_buffer_limit` status arm; loss of
the original error code.

No authentication decision, credential state, token, OAuth, or account-routing
surface. It maps already-classified upstream error envelopes to HTTP status codes;
the 401/403 arms propagate a classification rather than making an auth decision.
That is why it sits on a different side of the line from #2745, #2638 and #2497,
which touch OAuth snapshots, account selection, credential fencing, and bearer or
refresh-token handling respectively.

This one can be prepared autonomously once the fix and regression are in and the
merged-tree suite is green, and then merged **after a non-author maintainer
approval at the exact head** (`MAINTAINERS.md`: authors do not approve their own
pull requests).

## TESTS

- #2745: `tests/generic-oauth-failover.test.ts` — the required test work is
  recorded with the rest of the pre-disclosure triage in scratch, not here.
- #2729: `tests/claude-outbound.test.ts` — add the status-less
  `upstream_server_error` case asserting a transient 5xx tail.

## Verification (C)

```bash
bun test tests/generic-oauth-failover.test.ts
bun test tests/claude-outbound.test.ts tests/cursor-errors.test.ts
bun x tsc --noEmit
```

For #2729 the load-bearing proof is the new negative case failing on `dev` without
the fix and passing with it.

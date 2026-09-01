# 010 — Batch A: MERGEABLE review-required bug PRs

Four PRs are `MERGEABLE` and waiting on review rather than on their authors.

## #3174 — fix(gui): mobile topbar and integration card overflow (@lidge-jun)

14 files, +714/-2. Two responsive defects measured through CDP geometry rather than read
off CSS: a flex child without `min-width: 0` held its intrinsic width and pushed the
version badge under the action orbs at 320px; and `minmax(260px, 1fr)` could not shrink
below a 320px content box, pushing the integration card's action row off the page.

Maintainer-authored, carries before/after screenshots (which `enforce-target` requires for
any PR mentioning gui), and records a review pass that removed an invented 400px
breakpoint. **Action:** confirm CI, merge.

## #3176 — fix(codex): rotate accounts on wrapped quota failures (@Vadevious)

6 files, +219/-15. ChatGPT reports quota exhaustion as HTTP 502 with a quota-shaped
message; the pool treated it as transient, retried the exhausted account, and surfaced
`adapter_eof`. The fix normalizes bounded, display-safe pre-stream 5xx to the existing
quota path with cooldown, affinity clear, and the bounded alternate retry.

**Security review — performed, recorded here (A-gate finding A5).** This touches account
selection, which `MAINTAINERS.md` puts behind explicit security review, and the PR carried
no recorded review when it was merged. The review was done by reading the diff directly;
recording it after the merge rather than before is the process gap, not the code:

- `src/lib/errors.ts` — `upstreamErrorMessageFromPayload` reads four **canonical** paths
  only (`error.message`, `last_error.message`, `response.error.message`,
  `response.incomplete_details.message`) and returns a value only when it is a string.
  Echoed request content sitting elsewhere in the payload cannot reach the quota matcher.
- `src/server/responses/core.ts` — `shouldRetryCodexPoolAccountQuota` keeps 402/429 as an
  immediate true, then admits 5xx **only** when the bounded body is both `displaySafe` and
  not `truncated`. `fatalUtf8: true` rejects malformed UTF-8 rather than matching quota
  words around replacement characters. The whole path is wrapped so a read failure returns
  false — it fails closed, never rotates on an unreadable body.
- The fallback for non-JSON gateways returns the raw text only from the `catch`, so a
  well-formed JSON body is never scanned wholesale.
- Request-log rendering stays limited to canonical fields, so the widened matcher does not
  widen what gets logged.

Verdict: the credential-boundary reasoning holds. The precedence the plan asked to verify
is present and is what bounds the blast radius.

## #3177 — fix(responses): surface provider 413 as terminal context overflow (@Ingwannu)

5 files, +350/-1. A streaming 413 became a 5/5 reconnect loop; it now converts to one
terminal `response.failed` with `context_length_exceeded` so Codex can compact next turn.
Bounded proxy-owned failure message, so an upstream 413 body cannot echo request content.

**Draft.** Body says it stays draft until exact-head CI resolves. Action: check CI, mark
ready if green, merge. Closes bug issue #3170, so this is two items for one merge.

## #3151 — fix(export): preserve Hermes vision capabilities (@Ingwannu)

7 files, +97/-13. Replaces the Hermes string-only model array with the metadata map, so
`supports_vision` is emitted from exported catalog modalities. Closes #3146.

**Draft with red CI** — `ci fail` and `macos fail`. The body claims the failures are
pre-existing. **The A-gate audit checked the logs and the claim is TRUE (A2):** `ci` is only
a rollup reporting `platform-macos=failure`, and the macOS job's single `(fail)` is
`server local API auth > websocket passthrough refreshes pool auth for each response.create
turn` (`tests/server-auth.test.ts:2302`) — a known macOS flake. This PR touches
`src/clients/config-export.ts` and the export tests, nowhere near websocket auth.

Action: clear draft, merge. Do not waive the red by assertion — rerun the macOS job first
and merge on a green or same-flake result.

## Execution order

1. #3174 — maintainer-authored, self-contained, screenshots present.
2. #3177 — clear draft if CI is clean; closes #3170 too.
3. #3176 — read the credential-path diff first.
4. #3151 — diagnose the red CI before deciding merge vs. repair.

## Verification (C)

Per merged PR: `gh pr view <n> --json state,mergeCommit`, then
`git merge-base --is-ancestor <sha> origin/dev` exiting 0. Linked issues closed by hand,
since PRs target `dev` rather than the default branch.

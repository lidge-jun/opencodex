# 070 — Phase 7: docs, review, delivery

## Docs

- `docs-site/src/content/docs/guides/integrations.md` (#8742's Gemini section): Interactions endpoint
  (`POST /v1beta/interactions`, `/v1/interactions`), what is refused and why (agent, background,
  hosted tools, non-text output), `previous_interaction_id` retention (process memory, 24 h, owner-scoped,
  lost on restart), `GET`/`DELETE`, `countTokens` as a local estimate.
- `docs-site/src/content/docs/reference/adapters.md` google section (from line 467): usage composition
  (D5), fail-closed finish reasons, prompt blocks, structured 429 handling, tool-result images on
  Antigravity, audio input, Vertex `us`/`eu` hosts.
- `docs-site/src/content/docs/reference/cli/providers-accounts.md` and its `es` translation:
  `needs-reauth(tos)`.
- English is the source; per `docs-site/AGENTS.md`, translated pages must not contradict it (update or
  leave untouched, never leave a contradicting statement).
- `structure/`: every owned file touched by 010–060 has its doc updated in the same commit;
  `bun run structure:index` after manifest changes.
- Move this unit to `devlog/_fin/` only after the PR merges (owner decision); until then it stays in
  `_plan/` with a status line per phase.

## Verification

Once, at the end, under `/usr/bin/lockf -k /tmp/ocx-test.lock`: `bun run typecheck`, `bun run test`
(record the known container/systemd/mtime failures from AGENTS.md separately if they appear),
`bun run structure:check`, `bun run privacy:scan`, `cd docs-site && bun run build`, `bun run lint:gui`
only if `gui/` changed.

## Review

A fresh GOAT review task (`task.create`, `role: review`) on the final head with this unit, the matrix
and the diff; findings folded or rebutted in a second round that continues the same reviewer; the final
approval round uses a fresh reviewer. Security-relevant observations go to `.tmp/` only.

## Delivery

Push `feat/google-protocol-cpa-parity`; open one PR to `dev` using
`.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist), stating the #8742 dependency and
which commits are #8742's; link it with `goat_pull_request_link`; report exact-head PR CI. No merge, no
force-push, no `ci.yml lane=all`.

## Review round 1 (b5d57cd870, verdict FAIL: 2 MAJOR, 1 MINOR)

Report `.tmp/research/review-r1.md` (security detail kept in `.tmp/` only).

- S1 (MAJOR) accepted: `:countTokens` now holds the shared inbound-body allowance through `runAdmittedBodyWork`
  (`isGeminiBodyPath`). NEW `tests/server/gemini-count-tokens-admission.test.ts` queues behind a saturated allowance
  (failed before the fix: the request completed without queuing).
- R1 (MAJOR) accepted: AI Studio's raw 429 keeps a body-only wait as `Retry-After` on the over-ceiling and quota
  returns (`withBodyRetryAfter` in `src/adapters/google-http.ts`); two cases in
  `tests/adapters/google/google-retry-structured.test.ts` failed before the fix.
- R2 (MINOR) rebutted and deferred as matrix row INT-20: no inbound wire carries a tool-error flag, so the fix is a
  new Chat-wire contract in both lanes; the error stays readable as result text.

## Review round 2 (35a5932033, same reviewer, verdict FAIL: 1 MAJOR, 1 NIT)

Report `.tmp/research/review-r2.md`. S1 closed; the R2 deferral (INT-20) accepted.

- R1b (MAJOR) accepted: a 429 on the last allowed attempt (and on a send-budget stop) returned before its body was
  read. Every final answer now goes through `finalGoogleAnswer` in `src/adapters/google-http.ts`; the 503, 503, 429
  cases for AI Studio (raw) and Vertex (normalized) in `google-retry-structured.test.ts` failed before the fix.
- N1 (NIT) accepted: matrix totals now count 74 rows and 19 deferred.

## CI on the PR (35a5932033)

- `test 2/5`: README translation parity. 020 changed the English README's retained-store count and the seven
  locale READMEs in the same commit, but not `readme/i18n-manifest.json`; the hashes now name the current README.
- `react-doctor`: `gui/src/pages/integrations/gateway-clients-api.ts` (#8742's code; #8742's own run fails the
  same check) read an action body before checking the status. The action client now branches on the status first
  and reads a body only for 2xx and the route's 4xx refusals; NEW `gui/tests/gateway-clients-api.test.ts` (the 5xx
  case failed before the change).


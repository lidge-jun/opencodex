# 260923 Claude reset grants — diff-level plan (wp1)

Loop-spec: HOTL, single work-phase wp1. Write scope: this worktree only
(branch codex/anthropic-reset-grants). Tools: local fs, bun tests, GET-only
Anthropic probes with local OAuth tokens. Forbidden: any POST to
`/api/organizations/*/reset_rate_limits` during development or verification,
push/PR/merge, restarting the live ocx service. Budget: one PABCD cycle.

## Problem

Claude Pro/Max/Team subscriptions currently carry a one-time usage-limit reset
grant (Anthropic program `cedar_ember`, e.g. `opus55-launch-promax-20260921`),
valid until 2026-10-22T16:00Z. opencodex already shows reset tickets for Codex
(reset credits) and Grok (reset coupons) on the account rows, but Anthropic OAuth
rows show nothing, and the existing Anthropic quota probe sends
`claude-cli/2.1.63`, which upstream now answers with
`ineligible_reason: "cli_version"` for the grant block.

## Upstream contract (evidence)

- Read: `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1`,
  bearer OAuth token, `anthropic-beta: oauth-2025-04-20`,
  `User-Agent: claude-cli/2.1.280 (external, cli)`. Verified live (GET only) on six
  local accounts on 2026-09-23: each returned one unused grant.
- Redeem (from the Claude Code 2.1.278 client, function `fJe`):
  `POST https://api.anthropic.com/api/organizations/{orgUuid}/reset_rate_limits`
  body `{program:"cedar_ember", grant_id, request_id}`; grant id
  `/^[a-z0-9_-]{1,40}$/`, request id `/^[A-Za-z0-9_-]{1,64}$/`; response
  `{result: reset|already_used|not_limited|cooldown|ineligible|unavailable, reason,
  resets_left, cleared[], weekly_resets_at, cooldown_until}`; 429 → rate_limited,
  401/403 → auth_error. The client reuses the same request id when retrying an
  unsettled claim for the same grant. orgUuid comes from `GET /api/oauth/profile`
  (`organization.uuid`), which accepts the OAuth token.
- Not usable: `GET /api/organizations/{org}/usage` returns 403
  `oauth_token_not_accepted` for OAuth tokens.

## Decisions (architect proposal D1–D6, main dispositions)

- D1 accepted: `src/providers/anthropic-reset-grants.ts` (wire + parsing),
  `src/providers/anthropic-reset-grant-ledger.ts` (journal),
  `src/server/management/anthropic-reset-grant-routes.ts` (lazy-loaded).
- D2 accepted: fail-closed parse; malformed or missing `cedar_ember` is an error,
  never zero grants; `event_props` and upstream bodies never leave the server.
- D3 amended: JSON journal with atomic write (not the Codex SQLite ledger), with
  the D3 semantics. The single binding contract is the "Ledger contract" section
  below; it supersedes the first-revision wording.
- D4 accepted: `GET /api/anthropic/reset-grants?accountId=`,
  `POST /api/anthropic/reset-grants/consume` with required
  `{accountId, grantId, operationId}`. New operations re-read eligibility first and
  require the grant present, not paused, usable_now, resets_left > 0. Status codes
  400/401/409/429/502/503. Both routes registered as `deferred-verb` with this
  document as ownerDoc (CLI verb out of scope).
- D5 accepted: `gui/src/hooks/useAnthropicResetGrants.ts`,
  `gui/src/components/provider-workspace/AnthropicResetGrants.tsx`, wired into
  healthy Anthropic OAuth rows in ProviderAuthPanel; i18n prefix `anthropicGrant.*`.
- D6 accepted: `src/providers/claude-cli-identity.ts` exports
  `CLAUDE_CLI_USER_AGENT`; the quota probe imports it.

## File change map

| File | Change |
| --- | --- |
| src/providers/claude-cli-identity.ts | new: pinned UA constant |
| src/providers/quota/vendor-probes-oauth.ts | use the constant |
| src/providers/anthropic-reset-grants.ts | new: read, profile, redeem, parsers |
| src/providers/anthropic-reset-grant-ledger.ts | new: journal |
| src/server/management/anthropic-reset-grant-routes.ts | new: handlers |
| src/server/management-api.ts | lazy dispatch |
| src/server/management/route-registry.ts | two entries, deferred-verb |
| gui/src/hooks/useAnthropicResetGrants.ts | new |
| gui/src/components/provider-workspace/AnthropicResetGrants.tsx | new badge + dialog |
| gui/src/components/provider-workspace/ProviderAuthPanel.tsx | wire badge + modal |
| gui/src/i18n/*.ts (10 locales) | anthropicGrant.* keys |
| tests/adapters/anthropic/anthropic-reset-grants.test.ts | new (existing adapters/anthropic domain) |
| tests/server/management-anthropic-reset-grants.test.ts | new |
| gui/tests/anthropic-reset-grants.test.tsx | new: badge + abort → same-id retry |
| scripts/test-layout/layout.json, tests/fixtures/test-layout-expected.json | register |
| structure/gui-and-management-api.md | ownership row |
| docs-site reference/management-api.md (+7 locales) | route rows + dashboard note |

## Acceptance (activation scenarios)

1. Parser: valid block → grants; missing block, bad grant id, duplicate id,
   negative counts → error (unit test with fixtures).
2. Redeem wire: exact URL/body/headers; each `result` and 429/401/403/500
   mapping (fake fetch records the request).
3. Ledger: new op executes; same op after terminal replays with no fetch; same op
   while leased → 409 `in_flight`; same op open, lease lapsed, inside the 10 min
   retry window → re-sends the same request id; outside it → 409
   `unknown_outcome_expired`, no fetch; other account/grant/org → 409; corrupt
   journal → 503, no fetch; settlement write failure after an upstream answer →
   500 `journal_write_failed` and the record stays open.
   A different operation id for the same account + grant + org while an open
   record younger than 10 min exists → 409 `unresolved_prior_operation`, no fetch.
4. Routes: missing grantId/operationId → 400; ineligible or unusable grant → 409
   with no redeem call; token failure → 401; happy path returns code `reset`;
   unknown outcome (fetch throws) → 502 `unknown_outcome` and record stays open.
5. GUI: badge renders count, error, loading; dialog two-step confirm; screenshot.
6. Gates: `bun run typecheck`, focused tests, route registry, i18n parity, test
   layout, file-size ratchet, structure:check, core-lab boundary, GUI lint/build.
7. Live GET through the new module for local accounts; no POST.

## Out of scope

CLI verb (owed; this doc is the deferred-verb owner), auto-redeem, push/merge.

## Build deviations

- The consume route requires the `gui-session` principal and is registered as
  `session-only` instead of `deferred-verb`. AGENTS.md ("User-consent actions")
  asks that any new action spending the user's identity or credits be gated rather
  than left to a prompt an agent can answer; a one-time subscription reset is such
  a spend. The read route stays `deferred-verb` with this doc as owner.
- New CSS lives in `gui/src/styles/anthropic-reset-grants.css` (imported from
  `gui/src/main.tsx`) because `gui/src/styles.css` sits exactly at its
  file-size cap.
- Test files: `tests/adapters/anthropic/anthropic-reset-grants.test.ts`,
  `tests/server/management-anthropic-reset-grants.test.ts`,
  `gui/tests/anthropic-reset-grants.test.tsx`.

## Check-phase code review (Mill, gpt-6-sol)

Round 1 found five issues; four were fixed in `13c15083d3`: the journal now
publishes through `atomicWriteFileStreamed` (temp fsync plus parent-directory
sync) so the open record is on disk before the claim; settlement returns the
stored answer and a missing record fails closed; a replayed refusal renders as
that refusal; a same-id retry refused for a transient reason keeps the attempt
held. Trailing blank lines were removed.

Round 2 residual, accepted: `syncParentDirectory` in
`src/config/atomic-write.ts` is best-effort by platform (no directory
descriptor on Windows; some filesystems refuse the open), and this unit does not
change the shared primitive. Losing a just-renamed open record needs a power cut
in that window on such a platform, and a second spend then still needs the grant
to report `resets_left > 0` to the pre-spend gate after the first claim; every
grant observed today has `resets_total: 1`.

## Architect reflection (MISALIGNED → folded)

The same architect flagged three gaps against the first revision; all accepted:

1. D3 identity and concurrency. The journal record binds account + grant + a
   SHA-256 digest of the organization UUID (the raw UUID is never stored). Every
   journal read-modify-write runs inside a cross-process lock: a sibling
   `<journal>.lock.sqlite` opened with `busy_timeout=0; BEGIN IMMEDIATE` (same
   OS-backed pattern as `src/config/mutation-lock.ts`). Details, lease length
   and recovery rules: see "Ledger contract (binding)"; the older wording in this
   item is superseded.
2. D4 spend gate. A new operation requires `eligible === true`, the grant
   present, not paused, `usable_now`, `resets_left > 0`, and `at_limit` when
   `use_requires_limit` is true. A retry of an open record re-checks that the
   profile organization digest matches the journal (mismatch → 409).
3. GUI same-id retry. After an unknown outcome the dialog keeps the operationId
   and its retry sends the same id; a happy-dom test drives abort → retry and
   asserts both POST bodies carry the identical operationId.

## Audit round 1 (Arendt, FAIL → folded)

Four blockers, all accepted. The first two are resolved by the ledger contract
below; test placement is fixed in the change map; privacy is item P below.

## Ledger contract (binding)

Journal: `<configDir>/anthropic-reset-grant-ledger.json`, version 1, atomic write.
Lock: every read-modify-write runs synchronously inside a sibling
`<journal>.lock.sqlite` `BEGIN IMMEDIATE` transaction with `busy_timeout=0`.
Nothing asynchronous runs inside the lock; the upstream POST always runs after the
open record is durably written and the lock is released. Busy → 503
`ledger_busy`; unreadable or corrupt journal → 503 `ledger_unavailable`; no
spend in either case.

Record: `{accountId, grantId, orgDigest (sha256 of org uuid), status:
open|settled, code?, resetsLeftAtOpen, leaseUntil, attempts, createdAt,
updatedAt}`. The operationId (UUIDv4) is the upstream `request_id`.

Begin (under lock):
- no record → write `open` with `leaseUntil = now + 90 s` (25 s client timeout
  plus margin) → execute.
- record for another account/grant/org → 409 `operation_identity_mismatch`.
- settled → replay the stored code, no upstream call.
- open with an unexpired lease → 409 `in_flight`, no upstream call.
- open with an expired lease, less than 10 minutes after `createdAt` → renew the
  lease and POST again with the same request id. This is only reached by an
  explicit user retry of the same operation; nothing retries automatically.
- open with an expired lease, 10 minutes or more after `createdAt` → 409
  `unknown_outcome_expired`; no upstream call for this operation ever again.
- a NEW operation for the same account + grant + org while another record for
  that triple is still `open` and younger than 10 minutes → 409
  `unresolved_prior_operation` (response carries only that code); the dashboard
  steers the user to the same-id retry instead.

Why same-id retry is allowed (audit round 2): the vendor client does exactly
this. Claude Code 2.1.278 keeps `unsettledClaimRequestId` per grant and reuses it
for a retry while `now - unsettledClaimAtMs < 600000` (`b5o=600000`, functions
`Fqt`/`TJe`/`Dqt`), and after a second unconfirmed attempt tells the user
"nothing more was used" (`stillUnconfirmedLine`). The server-side dedup on
`request_id` is therefore the vendor's designed recovery contract, and the
10-minute window mirrors it. No settlement is ever inferred from a re-read: an
unknown outcome stays open until an upstream answer settles it or the window
closes. After the window, a new operation still has to pass the pre-spend gate
(eligible, usable_now, resets_left > 0), so a first attempt that did consume the
grant blocks the new one.

Audit round 3 (new-id bypass): folded for the 10-minute window as above. After
the window, a new operation id is allowed through the pre-spend gate. Rebuttal
for blocking it forever: the vendor client does the same — once
`now - unsettledClaimAtMs >= 600000`, `Fqt` stops reusing the old id and returns
a fresh `d5o()` UUID for the next claim, and a permanent block would strand a
grant that was never spent with no way to release it. Accepted residual (not a
guarantee): the 25 s timeout is client-side only, so an upstream that is still
processing the first POST, or has not reflected it in `/api/oauth/usage`, after
ten minutes could let a second reset be spent when `resets_left > 1`. Every grant
observed on 2026-09-23 had `resets_total: 1`; that is an observation, not a
parser-enforced limit.

Settle (under lock): first terminal settlement wins; a later or stale
settlement for an already-settled record is ignored. Terminal codes: every
upstream `result` value, plus `rate_limited` and `auth_error` (the spend was
refused before it ran). A thrown fetch, timeout, or unreadable response leaves the
record `open` and the route answers 502 `unknown_outcome`. If the upstream
answered but the settlement write fails, the route fails closed with 500
`journal_write_failed` and no upstream code; the record stays open, the GUI
treats it as an unknown outcome, and a same-id retry inside the window gets the
upstream's deduplicated answer.

Residual risk: two processes that both find an expired lease serialize on the
lock, so only one renews it. A first attempt still in flight after 90 s could
overlap an explicit same-id retry; both carry the same request id, which is the
case the vendor dedup exists for.

## Privacy (P)

Routes return fixed codes and fixed messages only; no exception text, upstream
body, token, organization UUID, or email reaches a response or log line. Route
tests assert that response bodies do not contain the fake token, org uuid, or
email used by the fakes, and capture console output during the route tests to
assert none of those values is logged.

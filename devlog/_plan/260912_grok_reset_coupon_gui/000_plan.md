# Grok reset coupons — dashboard surface

## Reader summary

PR #4306 gave opencodex a Grok reset-coupon client, a journaled redemption ledger,
two management routes, and a CLI verb, but it deliberately left the dashboard out.
An operator who hits an xAI weekly limit therefore sees the same wall the Codex
pool showed before its ticket badge existed: the coupon is there, the proxy can
read and spend it, and nothing in the UI says so. This unit adds that surface — a
ticket badge per xAI OAuth account row in Providers > Accounts, and a dialog that
lists each coupon's validity window and redeems the nearest-expiry one. It changes
nothing on the server: both actions call routes that already shipped.

This document is the post-audit contract. It supersedes its own first draft: the
architect review (`010`), the architect reflection (`020`), and the independent
audit (`030`) are folded into the decisions, file map, verifiers and criteria below.

## Loop spec

- **Loop archetype:** satisfy-spec. The contract is fixed by the merged management
  routes and by the Codex reset-credit surface this mirrors.
- **Trigger:** user request on 2026-09-12 — "여기서 코덱스 처럼 리셋쿠폰 아이콘도 생기고
  쓸수 있게해줘", pointing at the xAI Grok Accounts tab.
- **Goal:** an operator reads remaining Grok coupons and redeems one from the
  dashboard, and is never told a redemption succeeded when it did not.
- **Non-goals:** no server change (routes, ledger, gRPC-Web client stay as merged);
  no auto-redeem; no change to the Codex reset-credit surface; no new dependency;
  no quota-probe change.
- **Verifier:** the table below. Each row records the command's exit code at plan
  time, or "not run yet" where the artifact it observes lands in B, plus whether it
  observes this unit's files.
- **Stop condition:** merged into `dev` with exact-head CI green and `dev` ancestry
  proven.
- **Memory artifact:** `devlog/_plan/260912_grok_reset_coupon_gui/`, closing into
  `devlog/_fin/` after the merge.
- **Expected terminal outcomes:** DONE on merge; BLOCKED if review requires the
  server change this unit excluded; NEEDS_HUMAN if a second maintainer approval is
  required and unavailable.
- **Escalation condition:** main reclaims a delegated slice after two distinct
  agents fail its packet. Delegation is limited to locale catalogs and docs-site
  locale text, which have disjoint write sets; moving implementation to a worker
  would require a P-phase amendment.
- **Resource bounds:** none set by the user; no token or time budget is claimed.

## Design decisions (post-audit)

**D1 — eager read, bounded, with the cost stated.** Codex reset credits ride the
quota payload (`gui/src/codex-quota-utils.ts:21`), so its badge count is free. xAI
quota carries no equivalent, and the request is explicitly for a Codex-style badge
that shows the number, so lazy-on-open would ship a different feature. The panel
therefore reads `GET /api/grok/reset-coupons` once per account when the xAI
Accounts panel mounts. Honest cost: each read is a token refresh plus a live
gRPC-Web billing RPC with no server cache
(`src/server/management/grok-coupon-routes.ts:83`), React StrictMode makes that
**2N** reads for N accounts in development, and a panel remount re-reads because
this unit adds no TTL cache. The bound is a **three-at-a-time queue inside the
hook** — implemented, not asserted — plus the fact that only the currently open
provider's accounts are in the read set. Folding the count into the xAI quota probe
is the recorded follow-up.

**D2 — roster epoch and per-account cancel tokens are separate.** A single scalar
generation cannot serve both: bumping it for one row's retry silently discards
every sibling read and strands those badges on the placeholder. The scalar stays
the roster epoch, bumped only by the effect and its cleanup; each in-flight read
additionally carries a per-account token, so one row's refresh or redemption never
cancels another row's read.

**D3 — redemption truth comes from `code`, not from HTTP 200.** The ledger settles
failures terminally (`src/grok/reset-coupon-ledger.ts:133`) and the route replays a
settled record as HTTP 200 with `replayed: true` and the original code
(`src/server/management/grok-coupon-routes.ts:174`). A client that reads only
`replayed` announces a failed redemption as a completed reset. The hook therefore
returns the settled `code`; only `redeemed` is success, every other code routes
through the failure table. 409 clears the held operation id, `capacity` gets its
own retryable message, and no failure message claims a coupon was not consumed
unless that is known — `redeem_failed` can follow an upstream call that already
went out.

**D4 — the operation id is client-minted or the request is refused.** The
idempotency the journal offers is only reachable when the client holds the id
across attempts. If `crypto` can produce neither `randomUUID` nor
`getRandomValues`, the dialog refuses to redeem and says so, instead of posting
without an id and letting the server mint a fresh one per attempt.

**D5 — an aborted redemption is an unknown outcome, and the dialog stops posting.**
The 30 s bound can abort while the server is still calling RedeemReset against a
record that is still `open`, and an `open` record re-executes on the next attempt
(`src/grok/reset-coupon-ledger.ts:87`). A second POST therefore spends a second
coupon whether it carries a new id or the same one. After an abort the dialog
issues **no further consume request at all**: it holds the operation id, enters an
explicit unknown state, and offers exactly one action, re-reading the account. If
the coupon has disappeared it reports the coupon as consumed; if it is still listed
the state stays unresolved and the copy says so, pointing at a later re-read rather
than at a retry button. A new confirmation cannot be started while an unknown
outcome is outstanding.

**D6 — one reauth predicate, and the OAuth surface gate is local.** The read set
and the badge use the same predicate, built from the same health state the row
renders (`showReauth`), so no row is fetched and then hidden. The enabling
condition names the OAuth surface directly rather than relying on the roster loader
three files away to leave `accounts` empty for key-auth xAI.

**D7 — no new CSS.** Badge and dialog reuse `badge-clickable`, `credit-list`,
`credit-item`, `modal-overlay`, `modal-card` (`gui/src/styles.css:1065`). The
loading placeholder keeps the Codex pattern of an `aria-hidden` slot carrying a
literal `0` (`gui/src/components/codex-account-pool-helpers.tsx:34`), which is why
criterion 4 below is scoped to visible copy rather than to every glyph.

## File change map

| File | Change |
| --- | --- |
| `gui/src/hooks/useGrokResetCoupons.ts` | new — bounded per-account read queue (D1), roster epoch + per-account tokens (D2), settled-`code` redemption result (D3), abort reported distinctly (D5), NaN validity sorts last |
| `gui/src/components/provider-workspace/GrokResetCoupons.tsx` | new — badge and dialog; failure table incl. `capacity`; 409 clears the id; unknown-outcome state; unconditional `tokenId`; fail-closed when no id can be minted; `role="alert"` for failures; focus moves to the confirmation |
| `gui/src/components/provider-workspace/ProviderAuthPanel.tsx` | wire the badge into xAI OAuth rows, host the dialog, single reauth predicate, OAuth-surface gate computed before the hook call |
| `gui/src/i18n/en.ts` | 36 `grokCoupon.*` keys (source of truth) |
| `gui/src/i18n/{de,fr,ja,ko,ru,tr,zh,zh-TW}.ts` | the same 36 keys, translated; zh-TW translates `couponNextBadge` rather than joining the keep-English allowlist |
| `gui/tests/grok-reset-coupons.test.tsx` | new — the activation cases below |
| `docs-site/src/content/docs/**/reference/management-api.md` | name the dashboard surface beside the coupon routes: English root + `ko`, `ja`, `zh-cn`, `zh-tw`, `fr`, `ru`, `tr` |
| `structure/providers/xai-grok.md` | record the dashboard surface under the coupon section |
| `structure/gui-and-management-api.md` | add the coupon routes and their GUI owner to the route/owner table (`structure/manifest.json:299` lists `gui/` under this doc) |

Scope boundary — IN: the files above. OUT: `src/` (server, ledger, CLI), the Codex
reset-credit surface, `src/lab/`, quota probing, `gui/dist`, and
`gui/tests/locale-parity.test.ts` (no allowlist edit is needed once zh-TW
translates the badge word).

## Verifier table

| Command | Exit at plan time | Observes this change? |
| --- | --- | --- |
| `cd gui && bun test tests/locale-parity.test.ts` | 1 — `de key count: 2653` vs `2682` | yes: reads every `gui/src/i18n/*.ts` |
| `cd gui && bun test tests/i18n-locales.test.ts` | 1 — same key-set assertion | yes: compares each catalog to `en` |
| `cd gui && bun run lint` | 0 | yes: `oxlint .` covers `src/hooks` and `src/components`, including rules-of-hooks |
| `cd gui && bun run lint:i18n` | 0 | partly: `oxlint src/pages src/components …` sees the new component but **not** `src/hooks` or `src/i18n` (`gui/.oxlintrc.json` ignores `src/i18n/**`) |
| `cd gui && bun test tests/grok-reset-coupons.test.tsx` | file lands in B | yes: mounts `ProviderAuthPanel` with an xAI item |
| `cd gui && bun test tests` | not run yet | yes: full GUI suite |
| `cd gui && bun run build` | not run yet | yes: `tsc -b && vite build` over `gui/src` |
| `bun run structure:check` | 0 | yes: gates `structure/` doc-map and ownership for `gui/` |
| `bun run typecheck` and `bun run test` (root) | not run yet | PR-ready gate required by `AGENTS.md` |
| `rg -l 'reset-coupons' docs-site/src/content/docs` | 0 (16 files today) | human review: no automated gate reads docs-site locale prose |

## Conditional paths and how C triggers them (C-ACTIVATION-GROUNDING-01)

| Path | Trigger in the test | Observable proof |
| --- | --- | --- |
| Read failure | GET returns 502 | row renders `data-grok-coupon-badge="error"`; dialog offers retry |
| Auth failure on read | GET returns 401 `auth_failed` | dialog says sign in again, not "billing unavailable" |
| Replayed **failure** | consume returns 200 `{"replayed":true,"code":"redeem_failed"}` | failure message in the alert channel; no success claim |
| Replayed success | consume returns 200 `{"replayed":true,"code":"redeemed"}` | replay message, no second POST |
| Identity mismatch | consume returns 409 | failure message **and** the held operation id is cleared, proven by the next POST carrying a different id |
| Ledger capacity | consume returns 503 `capacity` | its own retryable message, distinct from the generic failure |
| Aborted redemption | consume never settles until the bound aborts | unknown-outcome state, a re-read, no new operation id |
| Aborted redemption issues no retry | after the abort, the dialog's only control is the re-read | no second POST to `/consume` is recorded by the fetch stub |
| Read queue bound | five-account roster with GETs held open | at most three `/reset-coupons` requests are in flight at any moment |
| Sibling reads survive | two accounts; row A retries while row B's read is in flight | row B still resolves to its count |
| Reauth row | account with `needsReauth` | no badge and no GET for that id |

## Accept criteria

1. An xAI OAuth row shows a ticket badge whose number equals `tokens.length` from
   `GET /api/grok/reset-coupons?accountId=<id>` for that row.
2. The dialog lists every coupon with its validity window, nearest expiry first,
   and an unparsable `validityEnd` sorts last instead of being treated as nearest.
3. Redeeming posts `{accountId, tokenId, operationId}` with a UUIDv4 id and an
   always-present `tokenId`; with no id mintable, the dialog refuses instead of
   posting.
4. Every grok-specific visible string resolves through a `grokCoupon.*` key present
   in all nine catalogs; shared `common.*` keys and the Codex-inherited
   `aria-hidden` placeholder are the only exceptions.
5. `cd gui && bun test tests`, `bun run lint`, `bun run lint:i18n`, and
   `bun run build` are green, and `bun run structure:check` passes.
6. The docs-site coupon rows name the dashboard surface in the English root and
   every translated locale, verified by reading the eight files.
7. A replayed redemption whose `code` is not `redeemed` is reported as a failure.
8. A 409 identity mismatch clears the held operation id.
9. A 503 `capacity` reports its own retryable message, and no failure message
   claims a coupon was not consumed unless that is known.
10. One row's retry or redemption never cancels another row's in-flight read.
11. An aborted redemption enters the unknown-outcome state, keeps its operation id,
    re-reads the account, and issues no further consume request.
12. At most three coupon reads are in flight at once.

## PR gate

`AGENTS.md` requires `bun run typecheck` and `bun run test` before the PR is
review-ready, the repository PR template in full, and — because this PR is about
`gui` — **a screenshot of the UI change in the description**
(`.github/PULL_REQUEST_TEMPLATE.md:8`). The PR targets `dev`.

## Source-of-truth sync (SOT-SYNC-01)

`structure/providers/xai-grok.md` owns the Grok coupon contract and gains the
dashboard surface. `structure/gui-and-management-api.md` owns `gui/` per
`structure/manifest.json:299` and gains the coupon routes with their GUI owner.

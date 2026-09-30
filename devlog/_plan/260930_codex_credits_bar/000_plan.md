# 000 — Codex credits balance on Codex Set account cards

## Objective

Show each Codex login's credits balance ("Credits remaining 62,500" on chatgpt.com Codex
usage settings) as a compact row directly under the existing Week quota row on the
Codex Set → Multi-auth main card and every pool card, behind one persisted page-wide
switch, the way the retired Codex Spark quota switch worked (#2649, bf73afee50).

Scope change recorded 2026-09-30: the GPT-5.5 retirement originally bundled with this
unit was removed by the owner ("5.5는 내가 나중에 패치할께 그냥 크레딧만 진행"). For
that later patch: the live `/backend-api/codex/models?client_version=0.170.0` roster still
lists `gpt-5.5` with `visibility: list` and
`upgrade: { model: "gpt-5.6-sol", retirement_at: "2026-10-14T19:00:00Z" }`.

## Evidence (000-range research)

- `GET https://chatgpt.com/backend-api/wham/usage` (Bearer Codex access token +
  `ChatGPT-Account-Id`) returns top-level keys `account_id, additional_rate_limits,
  chatpass, code_review_rate_limit, credits, email, model_usage, plan_type, promo,
  rate_limit, rate_limit_reached_type, rate_limit_reset_credits, spend_control, user_id`.
  Probed 2026-09-30 with the main login; only key names and value types were printed.
- `credits` = `{ has_credits: boolean, unlimited: boolean, overage_limit_reached: boolean,
  balance: string, approx_local_messages: [number, number], approx_cloud_messages:
  [number, number] }`. `balance` is a decimal STRING and is fractional on pool accounts
  (e.g. "62498.725", "62479.806261").
- The official Codex usage page (read through Aside, chatgpt.com/codex/cloud/settings/usage)
  renders "Credits remaining 62,500 — Credits extend usage beyond your plan limits." as a
  plain number with no bar and no denominator.
- opencodex already fetches this exact response: main in
  `src/codex/auth-api/main-account-probe.ts` (`fetchMainAccountInfoWhileOwned`, publish block
  after `credentialIsCurrent()`), pool in `src/codex/auth-api/pool-quota-probe.ts`
  (`publishPoolQuotaResponse`-style block that parses `WhamUsageResponse`). The response's
  `credits` object is currently ignored.
- The closest analogue is `rate_limit_reset_credits.available_count`: main keeps it
  memory-only and bound to the physical ChatGPT account id
  (`rememberMainResetCredits` / `mainResetCreditsForCurrentIdentity`) because the
  `__main__` alias can change identity while the proxy is down.

## Decisions

- D1 Storage: new sibling module `src/codex/credits.ts` with a process-local map
  keyed by opencodex account id (`__main__` or pool id) and tagged with the identity it
  was read from. Never persisted, never logged, never folded into `StoredAccountQuota`
  (quota participates in routing, recovery and persistence; credits are display only).
  No TTL: the row shows the last observation for the same identity, like reset credits.
  Explicit `credits: null` clears; an absent field keeps the previous observation.
- D2 Exposure: optional `credits` on `CodexAuthAccountDto`, emitted only when
  `config.showCodexCredits === true`. `/api/provider-quotas` stays unchanged (its
  projection is an allowlist). The switch controls exposure only, not probing.
- D3 Switch: `showCodexCredits?: boolean`, default off (absent = off), following the
  Spark precedent and the `oauthOpenBrowser` settings chain (type, zod degrade-not-reject
  schema, diagnostics, GET/PUT `/api/settings` with validate-mutate-persist-rollback).
  Toggle sits in the Codex Auth page head beside Pause exhausted / Refresh quotas.
- D4 Row: same `.quota-row` grid as Week: label "Credits", reset columns reused for
  "remaining", a bar, and the formatted balance in the value column. There is no
  denominator, so the bar is a STATUS bar, not a percentage: full (ok tone) when a
  positive balance or `unlimited`; empty when the balance is zero or
  `overage_limit_reached`. Value column: locale-formatted balance (max 2 fraction
  digits), "Unlimited", or balance plus "· Overage limit reached". The title tooltip
  carries the approx local/cloud message ranges. No `%`, no `role=progressbar`.
  Architect D5 proposed a number-only row; the owner explicitly asked for "비슷한 바"
  (a bar like the Week one), so the status bar is kept and documented.

## Work-phase map (dependency order)

| Work-phase | Doc | Delivers |
|---|---|---|
| wp0 | 000 (this), 010, 020 | Locked roadmap |
| wp2 | 010_phase1_credits_implementation.md | Parser + store + DTO + setting + GUI row + toggle + tests + docs |
| wp3 | 020_phase2_pr_ci_merge.md | PR from template with screenshot, exact-head CI, merge into `dev` |

## Constraints

- File-size ratchet: `gui/src/styles.css` has one line of headroom → new CSS lives in a
  new stylesheet. Keep additions in the large files minimal; put logic in siblings.
- New test files must be registered in `scripts/test-layout/layout.json` `explicit` and
  `tests/fixtures/test-layout-expected.json`.
- i18n: every key lands in all ten locales (en, ko, ja, zh, zh-TW, de, fr, ru, tr, vi).
- Privacy: never log WHAM bodies, balances, tokens, or account ids.
- SoT sync: `structure/providers/openai-accounts.md` (credits projection) and
  `structure/config.md` (new setting) if they enumerate settings/DTO fields;
  `bun run structure:check` must pass.


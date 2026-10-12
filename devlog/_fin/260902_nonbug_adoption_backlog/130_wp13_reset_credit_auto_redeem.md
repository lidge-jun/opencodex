# wp13 — #822 opt-in reset-credit auto-redemption (slice 1: policy + ledger + tests)

Investigation (grok subagent Volta). Today: inspect (`GET .../wham/rate-limit-reset-credits`) and
manual consume (`POST .../consume` with a fresh `redeem_request_id` per call) in
`src/codex/auth-api.ts`, CLI `ocx account reset-credits`, dashboard button. An unused #657 ledger
(`reset-credit-operation-ledger.ts`, kinds `recovery|manual`) exists. No auto-redeem config.

## Slice 1 (this cycle)
- Config: `resetCreditAutoRedeem: { enabled: boolean; leadTimeMinutes?: 1..60 }` (default off; malformed
  → disabled with one warning). Types + zod `.catch(undefined)`.
- `src/codex/reset-credit-auto-redeem.ts`: pure policy `planAutoRedeem(now, credits, settings)` → nearest
  unused credit with parseable `expires_at` and its due time `expires_at - lead`; identity
  `{accountId, grantedAt, expiresAt}`; `shouldDispatch(refreshedCredits, plan)` re-validates the
  identity after a fresh inspect. Ledger kind `"auto-redeem"` with one operationId reused as
  `redeem_request_id` per identity (crash-safe idempotency).
- Scheduler: `startResetCreditAutoRedeem(config, deps)` registered from `src/server/index.ts` only when
  enabled, teardown via `registerOptionalShutdownHook`; timer fire = refresh + re-check, never blind
  redeem. Logs hashed account key only.
- Docs row in server.md. No GUI.

## Acceptance
- Default off: no timer, no import cost on core files (core-lab boundary test green).
- Fake clock + fake WHAM: schedules at expiry-lead; identity change / disable / manual consume first →
  skip; dispatch reuses the same redeem_request_id across a simulated restart; success re-reads balance.


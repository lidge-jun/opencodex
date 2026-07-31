# 050 — PR #159 absorb: Cursor totals + Kimi usage quota accuracy

## 1. Scope and locked inputs

Absorb community PR #159 from immutable source head
`90eca76e4b8e66cf7fe20d2067976264766c89a3` (`codex/source-pr159-90eca76e`)
onto local `dev` with maintainer repairs. No push. Attribution per `000_plan.md`.

Source delta (2 files, +223/−59), all in `src/providers/quota.ts` +
`tests/provider-quota.test.ts`:

- `normalizeResetAt` handles unix-ms decimal strings (Cursor Connect RPC
  `billingCycleEnd: "1771077734000"`).
- Kimi: `unwrapKimiQuotaPayload` (data envelope), `parseKimiQuotaRow` direct
  percent fields, `isKimiWeeklyLimit` maps weekly from `limits[]`,
  `resolveKimiQuotaBearer` (OAuth or coding-plan API key), canonical-host guard
  extended to key providers in `maybeFetchProviderQuota`.
- Cursor: `totalPercentUsed` kept as monthlyPercent, auto/API pools retained as
  customWindows in the same report (previously customWindows short-circuited).

`git merge-tree` clean vs dev@eb1c39e5. QuotaBars contract test: 13 pass
(reviewer-verified against live dev).

## 2. Sol review verdict (2026-07-19, lane C)

`VERDICT PR#159: GO-WITH-FIXES (blockers=0)`

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | P2 | API-key fallback loop can pick a pool key that isn't the active account when primary `apiKey` env is unresolved (quota.ts:343-347) | FOLD — DECIDED: resolve only the ACTIVE key; when the primary `apiKey` env reference is unresolved, return null (no probe) instead of walking `apiKeyPool` — a quota bar attributed to the wrong account is worse than no bar. Add env-reference test asserting no fetch fires |
| 2 | P2 | Envelope detection uses `!== undefined`; `{usage: null, data:{usage: valid}}` keeps the dead outer (quota.ts:252-254) | FOLD — treat null/non-record outer fields as absent when deciding to unwrap; add conflicting-envelope test |
| 3 | P2 | `authMode !== "oauth"` includes `forward`/`local` modes → unintended probe with stale key material (quota.ts:647) | FOLD — restrict to `authMode === "key"` |

## 3. Landing plan

1. Wibias-author pick of `90eca76e` — source-faithful.
2. Maintainer repair commit (+Co-authored-by): three P2 folds + tests.

## 4. Verification

- `bun run typecheck` exit 0.
- `bun test tests/provider-quota.test.ts tests/quota-bars-rows.test.ts` pass.
- C-ACTIVATION: tests drive the unwrap-conflict branch, key-mode restriction
  (forward-mode config gets no probe), and unresolved-env-key branch.

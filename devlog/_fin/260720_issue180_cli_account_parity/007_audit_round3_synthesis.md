# 007 — Audit round 3 synthesis (REVIEW-SYNTHESIS-01, WP3 A-gate)

Reviewer: sol agent "Schrodinger" (WP3 A-gate round 1 over `020`). Verdict:
**GO-WITH-FIXES (blockers=5)** + 3 non-blocking. Main-session judgment:
**near-pass** — all five blockers folded into the amended 020 as concrete design
changes; non-blocking items folded as specifications (no open residuals).

## Per-blocker RCA and dispositions

| # | Blocker | RCA | Disposition |
|---|---|---|---|
| B1 | 020 scope omitted account-api.ts; `apiJson` union is GET\|PUT only; codex refresh needs quota fields | 020 was written against the pre-split single module | ACCEPT: 020 scope/map now names `src/cli/account-api.ts` (union → GET\|POST\|PUT\|DELETE; codex reader gains refresh+quota) and NEW `src/cli/account-extra.ts` |
| B2 | OAuth refresh prescribed re-GET of `/api/oauth/accounts` — a no-op dressed as refresh | I missed `GET /api/provider-quotas?refresh=1` (management-api.ts:517-520, quota.ts:658-670) which the GUI uses (Providers.tsx:121) | ACCEPT: oauth refresh calls `/api/provider-quotas?refresh=1` and prints the provider's report row |
| B3 | `auto-switch` syntax had no provider slot, yet row 16 triggered "wrong provider" | self-contradictory spec | ACCEPT: syntax stays provider-less (codex pool only); extra token → exit 1 naming openai-only via leftoverArgsError; row rewritten |
| B4 | "removing ACTIVE promotes first remaining" is false for codex — pin clears to null/auto (account-lifecycle.ts:18) | overgeneralized from oauth/keys | ACCEPT: promotion output split per family; codex prints the cleared-pin/auto-select result; codex matrix row added |
| B5 | conditional budget nudge insufficient: 296 + ~255 ≈ 550 lines | module budget | ACCEPT: explicit split — NEW `src/cli/account-extra.ts` owns refresh/auto-switch/remove/add-key; `cmdAccount` dispatches |

## Non-blocking folds

> Update (main session, post-verdict): a parallel session's own WP3 audit
> (reviewer "Gauss", 021) had ALREADY folded the equivalents of B1/B3/B4/B5
> and most of N1-N3 into 020 before this round landed. Schrodinger's net-new
> folds on top of the Gauss-rewritten 020: **B2** (oauth/key refresh →
> `/api/provider-quotas?refresh=1` — independently re-verified at
> management-api.ts:517 + quota.ts:643-652), the **row renumber 22-40**
> (collision with the restored guards 18-21 in the shared suite), and the
> **`--yes` arg-parse-time ordering**. Dispositions below cover the union.

- N1: `AccountDeps` gains `stdinImpl?: () => Promise<string>`; default stdin read
  has a 5s timeout treated as EMPTY → exit 1 with guidance. Missing rows added:
  refresh on oauth provider (quota endpoint), refresh on api-key provider
  (exit 1), non-integer threshold (`abc`, `55.5`).
- N2: add-key family gate — classification must be `api-key`; codex/oauth
  targets exit 1 with guidance (server would accept any non-oauth/forward
  configured provider, so the CLI gate is the guard).
- N3: `--yes` enforced at ARG-PARSE time (before `resolveBaseUrl`) so the
  re-run hint fires even with the proxy down; `--json` shapes specified for all
  four subcommands; test rows renumbered 22-31 (the suite is shared with 010's
  rows 1-21); accept criterion updated; test-file growth justified by the
  shared-suite convention (no split).

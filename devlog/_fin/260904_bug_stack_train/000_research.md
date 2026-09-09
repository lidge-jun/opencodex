# 000 — Live manifest and disposition research

Snapshot taken 2026-09-04, base `origin/dev` = `b5777aa2d642`.
Worktree: `/Users/jun/.codex/worktrees/9d5b/opencodex`.

All findings below were produced by four parallel read-only research lanes and
re-checked against the current tree. Every disposition names its evidence.

## Open bug-labelled PRs (10)

| PR | Author | Verdict | Basis |
|----|--------|---------|-------|
| #3335 | x3M3x | LAND_AS_IS | GUI hardcodes 2 of 5 strategies at `gui/src/components/combo-workspace-controls.tsx:24-50`; canonical set already has 5 at `gui/src/combo-workspace-data.ts:11-30`. Test is RED without the fix. |
| #3333 | blackjune67 | LAND_AS_IS | Models panels are persistent and toggle `hidden` (`gui/src/pages/Models.tsx:2228-2312`); scoping to the visible panel id stops width leakage. Test asserts selectors absent on dev. |
| #3322 | luvs01 | LAND_AS_IS | Head already implements the exact requested message at `src/cli/observe.ts:75-77`. The `CHANGES_REQUESTED` review is stale against the corrected head. |
| #3357 | huaiqing-afk | LAND_AS_IS (draft) | One global previous-text slot at `src/adapters/cursor/protobuf-request.ts:303-381` lets every tool result reset narration detection. PR tracks roles independently. Strong RED regression. |
| #3325 | luvs01 | BLOCKED_ON_POLICY | Code correct, but `.github/workflows/` is a restricted surface (`.github/scripts/pr-sponsored-surface.cjs:24-27`); hygiene fails `unsponsored_surface` without the `maintainer-sponsored` label. The second "failure" is a cancelled `enforce-target` run, not a real failure. |
| #3364 | lidge-jun | LAND_WITH_FIX | Exact-head CI green. Missing a direct `parseResponse()` non-stream regression even though production parse calls the same extractor (`src/adapters/openai-responses.ts:2450-2481`). |
| #3361 | lidge-jun | LAND_AS_IS | Exact-head CI green; marker/journal ownership preserved per key; `startServer` stays synchronous. Touches unauthenticated loopback admission, so it needs explicit maintainer security sign-off. |
| #3332 | full999 | LAND_WITH_FIX | Writes an OUTPUT limit into an INPUT field: `ModelMetadata.maxTokens` is output (`src/generated/model-metadata.ts:4-12`) but lands in `maxInputTokens`. Would shrink Claude 1M input models to 64K/128K. |
| #3348 | RHODIZSECURITY | DEFER | 2,248 lines / 34 files across failover, credentials, persistence, shutdown, and the core response path. Confirmed blocker: generic HTTP 410/413 become retryable hops, so an oversized or invalid request is replayed to the next provider. |
| #3312 | RHODIZSECURITY | DEFER (superseded) | Functionally the same work as #3348 with the same 410/413 blocker; currently CONFLICTING/DIRTY. Not an ancestry successor, but #3348 supersedes it. |

## Open bug-labelled issues (6)

None are safely fixable from the evidence currently attached. Detail:

- **#3352** (GPT-5.6 401) — NEEDS_REPORTER_EVIDENCE. Mechanism is established end to end:
  gating at `src/codex/catalog/native-models.ts:5`, roster fetch at
  `src/codex/model-entitlements.ts:185`, unconfirmed-evidence fallback at `:548`,
  granted-only projection at `:958`/`:1024`, and the exact 401 at
  `src/codex/auth-context.ts:435`. The reported `0.142.2` floor theory is already
  ruled out — the code enforces `0.144.0` at `:75`. Letting `unknown` through would
  be a security-policy change, not a bug fix.
- **#3320** (Windows non-ASCII scheduler) — NEEDS_REPORTER_EVIDENCE. Production XML
  writes a locale-independent SID (`src/service.ts:1841,1912`); exact `<UserId>`
  matching is deliberate (`:2117`) because folding two non-ASCII identities to `???`
  could adopt another account's task. Needs redacted live XML before any patch.
- **#3279** (GUI 401) — NEEDS_REPORTER_EVIDENCE. Each page load mints a session from
  its own Host-derived origin (`src/server/gui-session.ts:166`); exact origin checks
  are the admission boundary (`:417`); expiry is deterministic at 5 minutes (`:62`).
  Canonicalizing localhost/IPv4/IPv6 would weaken auth without proving cause.
- **#3255** (capability vs speed) — PRODUCT_DECISION. The two dimensions are already
  independent (`src/reasoning-effort.ts:5` vs `src/codex/catalog/effort.ts:160`), and
  there is no Ultra-fast wire tier to pass through.
- **#3245** (stream disconnect) — NEEDS_REPORTER_EVIDENCE. 426 is intentional
  (`src/server/index.ts:1107`) and the 426-then-POST path is already covered
  (`tests/server-auth.test.ts:1384`). The reporter saw no subsequent POST, which puts
  the failure before the Responses bridge.
- **#1527** (Cursor large context) — NEEDS_REPORTER_EVIDENCE. Every known defect in
  this path is already fixed; a matched current-dev trace is required.

## Issue #3366 — deviceauth (the implementation target)

Key correction to the issue's premise: `chatgpt` is deliberately excluded from the
generic OAuth surface (`src/oauth/index.ts:284-297`, `tests/oauth-public-surface.test.ts:77-111`)
and `openai|codex|chatgpt` route through the separate Codex-auth API. Returning
`deviceCode` from `src/oauth/` alone therefore does NOT light up the existing UI —
the Codex-auth layer discards it today at `src/codex/auth-api.ts:2199-2209`.

Upstream wire flow, confirmed against `codex-rs/login/src/device_code_auth.rs`:
15-minute poll window, only 403/404 mean pending, server-issued `code_verifier`,
and `redirect_uri=https://auth.openai.com/deviceauth/callback`.

Non-fabrication note: the issue claims a `codex_cli_rs` User-Agent is required.
Upstream actually builds a raw auth client with no Codex default headers
(`device_code_auth.rs:165-171`), and its real UA is dynamic. We do not hard-code
client impersonation; we send no custom UA and let the platform default stand.

## Stack plan

Dependency-ordered, bottom-up (DEV-STACK-01):

1. `codex/deviceauth-core` — the grant itself in `src/oauth/` (010)
2. `codex/deviceauth-surface` — Codex-auth API + CLI + docs (020)
3. `codex/bug-carry` — carried contributor fixes with attribution (030)

Deferred out of the stack with recorded reasons: #3348, #3312, #3325, and all six
bug issues. Documented in 040.

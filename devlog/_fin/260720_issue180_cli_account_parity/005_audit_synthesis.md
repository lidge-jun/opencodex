# 005 — Audit round 1 synthesis (REVIEW-SYNTHESIS-01)

Reviewer: sol agent "Anscombe" (A-gate round 1). Verdict: **FAIL** — 2 blockers + 7
non-blocking observations. This doc records per-blocker RCA and accept/rebut
decisions before the plan amendment and re-audit.

## Blocker 1 [High] — registry-first classification misroutes key-overridden OAuth providers

- RCA: the 010 draft classified by capability (`providerCodexAccountMode` → registry
  `authKind`) instead of by the CONFIGURED credential surface. `xai` and
  `github-copilot` are `authKind:"oauth"` with `allowKeyAuthOverride:true`
  (src/providers/registry.ts:326-327,822-827); `ocx provider add xai --api-key`
  persists `authMode:"key"` (src/cli/provider.ts:91). The server gates the keys
  family on config authMode (`isKeyAuthProvider`, src/providers/api-keys.ts:38-40)
  and the GUI resolves one surface per provider from config authMode
  (`providerAuthSurface`, gui/src/provider-workspace/auth.ts:17-28). A registry-first
  CLI shows an empty OAuth section while the real key pool is invisible, and
  `use xai <key-id>` 404s against the wrong family. The no-arg `list` fan-out also
  double-bucketed one provider into two families.
- Decision: **ACCEPT**. Amend 010 `classifyAccount` to config-first (authMode →
  family; registry only for unconfigured names) and make `list` classify each
  provider exactly once.
- Cross-blocker conflict: none — the fix narrows behavior to server semantics.

## Blocker 2 [Medium] — parity matrix claimed a CLI chatgpt login path that does not exist

- RCA: my original `001_gui_cli_parity_matrix.md` row said OAuth add-account is 🟡
  covered by `ocx login chatgpt`; 004 repeated a similar claim for `ocx login
  openai`. But `isPublicOAuthProvider` excludes `chatgpt`
  (src/oauth/index.ts:123-126), `openai` is not an OAuth provider at all, and
  neither is a key-login provider — both `ocx login chatgpt` and `ocx login openai`
  print usage and exit 1 (src/oauth/login-cli.ts:35-42).
- Decision: **ACCEPT**. Fix the 004 codex add-account row to ❌/OUT (no CLI path;
  dashboard flow only). Delete my stale duplicate 001/002 (superseded by 004/003;
  their unique stale-check content is folded into 004).
- Cross-blocker conflict: none.

## Non-blocking observations — dispositions

| # | Observation | Disposition |
|---|---|---|
| 1 | Line drift (management-api delegation :1621; v2 exitCode index.ts:525; helpEntries :72-78) | Folded: 010 cites :525 and :72-78; my stale 002 (which cited :1610) is deleted |
| 2 | Exit-code "house convention" overstated; v2 is the donor | Already v2-donor-framed in 010; kept |
| 3 | Null-pin display diverges from GUI legacy (null→main) but matches server auto-select | ACCEPT as intentional; 010 records the divergence with routing.ts:383-389 evidence |
| 4 | `openai` direct mode unspecified | ACCEPT: 010 adds a direct-mode display note |
| 5 | maskEmail passes non-emails through raw | ACCEPT: same as GUI; noted in 010 secret-hygiene; no credential fields exist in DTOs |
| 6 | Classification must be disk-config-based (GET /api/providers omits authMode) | ACCEPT: stated in the amended classifyAccount spec |

## Re-audit request

Round 2 goes to the SAME reviewer (Anscombe) with this synthesis + the amended
010/020/004, per AUDIT-LOOP-01.

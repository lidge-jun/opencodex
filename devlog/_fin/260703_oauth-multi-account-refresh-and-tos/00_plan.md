# OAuth multi-account proactive refresh ("Token Guardian") + ToS/account-safety — PLAN

Date: 2026-07-03
Owner: Boss (Claude main session), PABCD P phase. Research done directly by main session
(codex delegation aborted after 12m with no output; main session investigated code + web itself).
Status: IMPLEMENTED. Phase 0 (design) + Phases 1–4 (code) all executed heuristically across
multiple PABCD cycles (user goal: "run multiple PABCD cycles and finish the implementation").
tsc --noEmit green; opencodex own suite 1354 pass / 0 fail; new token-guardian suite 6 pass.
See "Implementation record" at the bottom.
Work class: C4-lite (cross-provider architecture + background scheduler + persistence +
ToS/security implications). Full PABCD plan.

## Request (verbatim intent)

1. Multi-account auth tokens keep expiring. Root-caused (loop 1 of this session): opencodex
   only refreshes a token **lazily**, at the moment a request is routed to that account
   (`getValidCodexToken` / `getValidAccessToken`). Idle pool accounts' **refresh tokens age out
   server-side** and die (`refresh_token_expired` / `refresh_token_reused` / `invalid_grant`)
   before they are ever used. Sibling project `Soju06/codex-lb` solved this with a background
   "Auth Guardian" scheduler that proactively refreshes stale accounts.
2. **Generalize** that fix beyond ChatGPT/Codex to the whole OAuth provider surface.
3. The user's second concern (verbatim): "이런걸로 tos 잡는 애들도 있잖아" — some providers
   catch/ban multi-account pooling via ToS. Research it and record in devlog.

## TL;DR — the load-bearing finding

Proactive background refresh is the right fix for token *survival*, **but it is also the single
biggest ToS-detection amplifier we can add.** Keeping idle consumer-subscription tokens warm
generates refresh traffic with zero user activity — exactly the "automated/programmatic access to
a consumer subscription" signal that Anthropic, OpenAI, and Cursor actively monitor and (for
Anthropic) already server-side-block. So the guardian **must be per-provider policy-gated**, not a
blanket loop. The design below adds a `refreshPolicy` to every provider and defaults the
high-risk providers to lazy-only.

## ToS / account-safety verdict (Thread B) — MLB 20-80 scale (20 = highest ban risk)

| Provider | Grade | Basis (cited in 30_tos-account-safety.md) |
|---|---|---|
| **Anthropic (Claude Pro/Max OAuth)** | **20** | Feb 2026 terms explicitly **prohibit** subscription OAuth tokens in any third-party tool; Anthropic deployed **server-side blocking** Feb–Mar 2026. Using Claude OAuth in opencodex is a live, enforced ToS violation. Proactive refresh makes it worse. |
| **OpenAI (ChatGPT/Codex OAuth)** | **35** | ToS prohibits sharing credentials and **circumventing rate limits**; switching accounts to bypass limits risks flag/ban. One-real-user-per-account is grayer, but pooling to aggregate quota is squarely in the prohibited zone. |
| **Cursor** | **35** | Account-bound usage + behavior monitoring (rapid location switching, overlapping sessions trigger abuse checks/forced logout). Many accounts behind one proxy IP is a strong detection signal. |
| **Google (Antigravity/Gemini)** | **45** | Could not fully verify a pooling-specific clause — flagged uncertain. General Google ToS bars automated abuse/limit circumvention. |
| **xAI (Grok)** | **50** | Public ToS lacks a pooling-specific clause we could cite — **uncertain**. Treat as unknown, not safe. |
| **AWS Kiro / CodeWhisperer** | **50** | AWS service terms bar circumvention; no pooling-specific clause verified — **uncertain**. |
| **Moonshot Kimi** | **55** | More API-oriented; least evidence of consumer-subscription pooling enforcement — **uncertain, lowest observed risk**. |

Uncertain grades (Google/xAI/Kiro/Kimi) are honest unknowns, NOT clearances. Full citations and
2+-source verification live in `30_tos-account-safety.md` (written in B).

## Provider token semantics (Thread A, from code — full table in 10_provider-token-semantics.md)

| Provider | Access TTL | Existing skew | Refresh-token rotation | Storage layer | Survival risk when idle |
|---|---|---|---|---|---|
| chatgpt/Codex | ~1h (`expires_in`) | 60s generic | rotates; reuse invalidates family | **multi**: `codex-account-store.ts` | **HIGH** (the reported bug) |
| anthropic | `expires_in` | −5min | rotates | single: `oauth/store.ts` | low (single seat, used often) |
| google-antigravity | ~1h | **−50min (already proactive)** | rotates | single | low |
| xai | `expires_in` | 60s | returns refresh each call | single | low |
| cursor | JWT `exp` | 60s | returns refresh each call | single | low |
| kimi | `expires_in` | skew | device-flow refresh | single | low |
| kiro | `expiresIn`/3600 | 60s | re-importable from CLI sqlite | single | low |

Key point: the acute survival bug is the **multi-account Codex pool**. Single-account providers
get exercised regularly, so they rarely go fully idle — but generalizing still buys (a) pre-expiry
refresh for latency, and (b) a clean home for any future multi-account provider pools.

## Design — unified "Token Guardian" (full spec in 20_guardian-design.md)

One background scheduler that REUSES the existing refresh machinery (it is a *caller*, adding no
new refresh/locking logic):

- Single-account layer → calls existing `getValidAccessToken(provider)` (already dedups via the
  in-memory `tokenRefreshes` map + persists via `saveCredential`).
- Multi-account Codex layer → calls existing `getValidCodexToken(id)` (already file-locked +
  generation-CAS + grant-fingerprint safe). This is the direct `codex-lb` Auth Guardian analogue.
- Per-provider `refreshPolicy: "proactive" | "lazy-only" | "disabled"` gates whether the guardian
  touches a provider at all. **Anthropic defaults to `lazy-only`** (ToS). Global config kill-switch
  `tokenGuardian.enabled` (default: **off** until user opts in — safety first).
- Cadence, jitter, concurrency cap, and permanent-failure backoff mirror codex-lb
  (tick ~ every few hours; refresh accounts whose last-refresh age exceeds a per-provider
  threshold; stop retrying on `revoked`/`expired` and surface a reauth notice).

## Work-phase slice map (multi-pass — one full PABCD per phase)

- **Phase 0 (this pass): design + research, code-free.** Deliverables = the four devlog docs
  (00 plan, 10 token semantics, 20 guardian design, 30 ToS matrix with citations). No src/ change.
- **Phase 1**: `refreshPolicy` metadata on every provider def + `tokenGuardian` config schema +
  kill-switch. (`src/oauth/index.ts`, `src/types.ts`, `src/config.ts`.)
- **Phase 2**: single-account guardian loop over `oauth/store.ts` providers, reusing
  `getValidAccessToken`. New `src/oauth/token-guardian.ts`.
- **Phase 3**: multi-account Codex guardian loop over `listCodexAccountIds()`, reusing
  `getValidCodexToken` + the existing lock/generation infra (the codex-lb parity piece).
- **Phase 4**: lifecycle wiring (`startTokenGuardian()` in `src/cli.ts` after `startServer`; stop
  in the `shutdown`/`syncCleanup` path), jitter/backoff, and tests.

This P pass covers **Phase 0 only**. Phases 1–4 each get their own P→A→B→C→D on approval.

## Phase 0 file map (NEW — devlog only, no source code)

```
devlog/_plan/260703_oauth-multi-account-refresh-and-tos/
├── 00_plan.md                     [THIS FILE]        the plan + slice map + verdicts
├── 10_provider-token-semantics.md [B output]         per-provider TTL/rotation table, file:line grounded
├── 20_guardian-design.md          [B output]         unified guardian interface + diff-level hook points
└── 30_tos-account-safety.md       [B output]         ToS matrix, 2+-source citations, per-provider clause
```

No `src/` files are created or modified in Phase 0. No new `structure/`/`docs/`/AGENTS files.

## Non-goals (Phase 0)

- No source-code changes, no scheduler implementation (that is Phase 2–4).
- No decision to *remove* any provider's OAuth support — the ToS matrix informs defaults, it does
  not unilaterally drop Anthropic.

## Decisions — LOCKED per goal ("각자의 ToS 리스크에 맞는, 더 위험이 적어지는 선택")

The governing rule: **every default is the lowest-ToS-exposure value consistent with that
provider's risk grade.** Nothing proactively refreshes unless the user explicitly opts in, per
provider. This makes the bug fix available without adding any default detection surface.

**Per-provider default `refreshPolicy` (risk-tiered):**

| Grade band | Providers | Default `refreshPolicy` | Rationale |
|---|---|---|---|
| ≤25 (severe) | Anthropic | **`disabled`** + login-time ToS warning | Active Feb-2026 server-side ban; never warm the token, never auto-refresh in background. |
| 26–40 (high) | OpenAI/ChatGPT-Codex, Cursor | **`lazy-only`** | Refresh only at the moment a request needs the token; `proactive` available as explicit per-provider opt-in. |
| 41–60 (uncertain) | Google, xAI, Kiro, Kimi | **`lazy-only`** | Uncertain ≠ safe — treat unknown pooling clauses as risky; opt-in `proactive` only. |

**Global guardian switch:** `tokenGuardian.enabled` defaults **OFF**. When a user turns it on, it
still only touches providers whose per-provider policy is `proactive`.

**The reported Codex-pool bug:** the guardian *can* fix it (proactive refresh of the multi-account
pool), but that path stays behind BOTH the global opt-in AND the per-provider `proactive` policy.
Recommended posture documented for users who accept OpenAI's pooling risk: enable the guardian and
set the Codex pool to `proactive`; leave everything else at its risk-minimizing default.

Net effect: default install = zero added ToS surface (identical behavior to today); the survival
fix is one explicit, informed opt-in away. See `30_tos-account-safety.md` for the evidence each
tier rests on.

## Implementation record (Phases 1–4, 2026-07-03)

Delivered across multiple heuristic PABCD cycles. Verification: `npx tsc --noEmit` exit 0;
`bun test tests/*.test.ts` = 1354 pass / 0 fail; `tests/token-guardian.test.ts` = 6 pass.

- **Phase 1 — policy metadata.** `src/types.ts`: added `RefreshPolicy`, `OcxTokenGuardianConfig`,
  `OcxConfig.tokenGuardian`, `OcxProviderConfig.refreshPolicy`. `src/oauth/index.ts`: added
  `defaultRefreshPolicy` to `OAuthProviderDef` (anthropic → `"disabled"`; others fall back to
  `"lazy-only"`) + exported `resolveRefreshPolicy(provider, config)`.
  (config schema untouched — `providerConfigSchema`/`configSchema` are `.passthrough()`, so new
  fields survive validation.)
- **Phase 2+3 — guardian.** NEW `src/oauth/token-guardian.ts`: `guardianSweep(nowMs)` (testable
  one-shot) + `startTokenGuardian()` (jittered, unref'd timer loop). Single-account layer calls
  `getValidAccessToken`; Codex pool calls `getValidCodexToken` — no new refresh/lock logic. Refresh
  horizon = `(tickSeconds + leadSeconds)`; concurrency cap; permanent-failure backoff (revoked/expired
  → ceiling wait; else exponential). Off unless `tokenGuardian.enabled`.
- **Phase 4 — lifecycle + tests.** `src/cli.ts`: `startTokenGuardian()` after server bind;
  `guardian.stop()` in `syncCleanup` (no refresh fires mid-drain). NEW `tests/token-guardian.test.ts`
  (6 cases: default-off, proactive-refresh, lazy-only untouched, far-from-expiry skip,
  anthropic-disabled-by-default, codex-pool gated on chatgpt policy).

Defaults keep a stock install byte-for-byte identical to today (guardian off, Anthropic disabled).
The Codex-pool survival fix activates with: `tokenGuardian.enabled=true` + the chatgpt provider's
`refreshPolicy="proactive"`.

# Shared Account-Pool Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Implementers and per-task reviewers use **composer-2.5**. Do not dispatch two implementers that edit the same files.

**Goal:** One small engine that sticks a conversation to one credential, spreads only
unbound sessions when a plugin opts in, and rotates mid-request only on 429/auth
death — without rewriting Codex routing or lighting prompt-cache cost.

**Architecture:** Keep `src/codex/routing.ts` as the Codex-only rich plugin. Lift
generic pieces from `src/codex/pool-rotation.ts` into `src/routing/account-pool/`.
Claude, Antigravity, and Cursor become thin plugins. Do not merge
`src/providers/key-failover.ts` in v1.

**Tech stack:** Bun-native TypeScript, existing OAuth store, focused
`bun test tests/<file>.test.ts`, docs-site Starlight.

## Global Constraints

- Fork-only: `origin` = `yansigit/opencodex`. No `--repo lidge-jun/opencodex`.
- Lab boundary: `src/routing/account-pool/` must not import `src/lab/`. Do not add
  imports from `src/router.ts` or `src/server/lifecycle.ts` into the kernel.
- Privacy: no emails, tokens, or account ids in logs (existing `p3fa91c`-style labels).
- Defaults: Codex pool unchanged; Claude pool stays `enabled !== true`; Cursor pool
  `enabled !== true`; Antigravity spreading stays absent.
- Command Code: no pool config key, no GUI, no 429 account carousel.
- TDD per task; focused `bun test`; `bun run typecheck` before a task is marked done
  if it touched `src/`.
- Implementer model: **composer-2.5**. Parallel implementers only when file trees are
  disjoint (kernel `src/routing/account-pool/` + tests vs docs-site). Anthropic →
  Antigravity → Cursor are **sequential** (all touch `src/server/responses/core.ts`).
- Do not expand ToS circumvention. Copy the existing Codex caution; do not claim
  multi-account use is endorsed.

---

## Wave 1 (parallel, disjoint trees)

### Task 1: Kernel + tests

**Files:**
- Create: `src/routing/account-pool/types.ts`
- Create: `src/routing/account-pool/affinity.ts`
- Create: `src/routing/account-pool/cooldown.ts`
- Create: `src/routing/account-pool/resolve.ts`
- Test: `tests/account-pool-kernel.test.ts`

**Interfaces:** `AccountPoolPlugin`, `AccountPoolPickReason`,
`ACCOUNT_POOL_MAX_FAILOVERS`, `resolvePoolAccount`, `rotatePoolAccountOn429`,
`CooldownRegistry`, `parseRetryAfterMs`.

- [ ] Write tests covering: affinity hit; TTL expiry; cap eviction; ignore
  shared-cohort cache key; 429 hop binds the new account to the same session key
  only; second concurrent session key does not move; `all-cooled`; disabled plugin
  returns active/none; failover cap 3; **402/billing does not hop**; **rate_limited
  remaining ≤5s stick-wait does not hop**.
- [ ] Run `bun test tests/account-pool-kernel.test.ts`; expected initial failures
  are missing module/export failures.
- [ ] Implement kernel modules. Reuse `pickRoundRobinAccount` / `selectPriorityTier`
  from `src/codex/pool-rotation.ts`. Affinity ignores Desktop shared-cohort
  `prompt_cache_key`.
- [ ] Run focused test again; expected result is all kernel tests passing.
- [ ] Run `bun run typecheck` if `src/` changed.
- [ ] Commit: `feat: add shared account-pool kernel`.

### Task 2: Policy docs (English)

**Files:**
- Create: `docs/superpowers/specs/2026-08-22-shared-account-pool-kernel-design.md`
- Create: `docs/superpowers/plans/2026-08-22-shared-account-pool-kernel.md`
- Modify: `docs-site/src/content/docs/reference/configuration/providers.md`
- Modify: `docs-site/src/content/docs/guides/web-dashboard.md`

- [ ] Write design spec: four rules, plugin vs Codex, ToS operator stance, non-goals.
- [ ] Write this plan with Global Constraints and wave tasks.
- [ ] Update English providers reference: kernel contract; Command Code unsupported;
  Antigravity failover-only (no OAuth cache-hit savings); Cursor default-off;
  billing ≠ 429; stick-wait ≤5s `rate_limited` only.
- [ ] Extend web-dashboard Codex caution; do not endorse circumventing limits.
- [ ] Note locale follow-up if translations are not updated this wave.
- [ ] Commit: `docs: shared account-pool kernel policy`.

---

## Wave 2 (sequential, shared request path)

### Task 3: Claude onto kernel

**Files:**
- Modify: `src/oauth/anthropic-routing.ts`
- Modify: `src/server/responses/core.ts` (pre-stream ~4741 and streaming ~5124)

- [ ] Delegate affinity / 429 / cooldown to kernel. Preserve: default-off, promote
  after token success only, `local-cli` refresh guard, no promote inside
  `rotateAnthropicAccountOn429`.
- [ ] Run `bun test tests/anthropic-account-pool.test.ts`; expected green with no
  intentional behavior change.
- [ ] Wire pre-stream and streaming 429 loops.
- [ ] Run `bun run typecheck`.
- [ ] Commit: `refactor: anthropic routing on account-pool kernel`.

### Task 4: Antigravity affinity + stick-wait

**Files:**
- Modify: `src/oauth/antigravity-routing.ts`
- Modify: `src/server/responses/core.ts` (~2626–2663 bind, ~4778–4823 carousel)
- Test: `tests/antigravity-session-affinity.test.ts`
- Extend: `tests/antigravity-routing.test.ts`

- [ ] On 429 and cooldown skip at bind, pick next account for this session key; do
  not `setActiveAccount` when other session affinities exist.
- [ ] If sticky account is `rate_limited` with ≤5s remaining, wait instead of hop.
- [ ] Keep `bindAntigravityProject` and `recordAntigravityHttpCooldown` local.
- [ ] Project bind remains fail-closed. Docs must not claim OAuth cache-hit savings.
- [ ] Run focused Antigravity tests + `bun run typecheck`.
- [ ] Commit: `fix: antigravity session affinity and stick-wait`.

### Task 5: Cursor 429 pool (default off)

**Files:**
- Modify: `src/server/responses/core.ts` (~2601–2670 Cursor opt-in)
- Modify: `src/providers/cursor-pool.ts` (leave unwired; comment)
- Test: `tests/cursor-account-pool.test.ts`
- Extend: `tests/cursor-pool.test.ts`

- [ ] If `cursorAccountPool.enabled === true` and ≥2 OAuth accounts: sticky +
  429 hop (affinity key from `_clientThreadId` / headers, **not**
  `CursorCredentialRouter` WRR); set `_cursorIdentityScope` to chosen account.
- [ ] Default path unchanged (`getValidAccessTokenSnapshot` / active account).
- [ ] Do not hop after client-visible output. Billing/402 does not use 429 carousel.
- [ ] Test: disabled = today; enabled sticky; 429 rotates once; billing/402 no
  carousel; checkpoint `identity_changed` across accounts.
- [ ] Run focused Cursor tests + `bun run typecheck`.
- [ ] Commit: `feat: optional cursor account-pool failover`.

### Task 6: GUI + i18n

**Files:**
- GUI: Cursor experimental toggle mirroring Anthropic warning pattern
- All locale files for new copy

- [ ] Cursor pool toggle default off. No Command Code pool UI.
- [ ] Run `bun run lint:i18n` if copy changes.
- [ ] Commit: `gui: cursor account-pool experimental toggle`.

### Task 7: Typecheck + focused suite

- [ ] `bun run typecheck`
- [ ] `bun test tests/account-pool-kernel.test.ts tests/anthropic-account-pool.test.ts tests/antigravity-routing.test.ts tests/antigravity-session-affinity.test.ts tests/cursor-pool.test.ts tests/cursor-account-pool.test.ts tests/session-affinity.test.ts`

---

## Wave 3 (sequential, Cursor adapter only — after Wave 2 Cursor plugin)

### Task 8: Senpi-style conversation remint

**Files:**
- Modify: `src/adapters/cursor.ts`
- Modify: `src/adapters/cursor/thread-continuity.ts`
- Checkpoint rekey paths

- [ ] On overflow 0-token RE (`isCursorZeroTokenResourceExhausted`, no quota cue):
  **surface first** (do not remint; let Codex compact), then on later overflow REs
  remint wire id **≤3** with `rekeyCursorContextUsage` + checkpoint rekey +
  `rememberCursorThreadConversation`. Cap then skip.
- [ ] Never remint after client-visible output, on tool-result resumes, or by calling
  the account-pool 429 hop.
- [ ] Tests: first overflow surfaces; second remints and persists thread override;
  fourth is skip; quota-cue RE still 429 and can hit Cursor account plugin if
  enabled; identity scope still fail-closed.
- [ ] Commit: `feat: cursor overflow conversation remint`.

**Controller:** after each task, `scripts/review-package` + task reviewer
(composer-2.5). Ledger: `.superpowers/sdd/progress.md`. Final whole-branch review
once Wave 3 finishes.

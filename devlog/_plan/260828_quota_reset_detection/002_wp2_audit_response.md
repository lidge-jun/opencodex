# wp2 A-gate audit response

The retired plan auditor (grok-4.6, `audit-quota-reset-plan-2`) returned after its third
wait cycle with `GO-WITH-FIXES (blockers=9)` — after I had already audited directly. Both
audits are recorded; this one found things mine did not. I re-verified every blocker I acted
on rather than taking the verdict on trust.

## Blocker 1 — Critical, and correct. The provider seam could never have fired.

`src/providers/quota.ts:2290` binds `previous` only when `cache.key === key`. I had read
the `:2309` comment saying the key encodes the provider SET and stopped there. The key is
actually built by `cacheKeyWithAggregationState` (`:193`), which folds
`quotaSignatureValue` (`:155`) — `weeklyPercent`, `weeklyResetAt`, `monthlyResetAt`,
`customWindows`, and `updatedAt` — into a sha256 digest appended to the key.

A reset changes exactly those values, so the key rotates, so `previous` is `[]`, so the
detector's no-prev rule returns null. On a pooled install the key rotates on every quota
write, since `updatedAt` is in the digest.

Verified by reading `:2273-2290` and `:193-217`. The wp3 seam claim was wrong: `:2343` is
indeed the only place a newer report displaces an older one, but it displaces under a
DIFFERENT key, which makes the displacement invisible to a cache-key-equality diff.

Fix folded into `020`: provider observation no longer reads `previous` at all. The detector
owns its own last-seen map keyed by `(provider, accountTag, window)`, which is immune to
cache-key rotation by construction. That map is the same store wp2 already persists.

## Blocker 2 — High, and correct. Fixed in this B.

`src/codex/quota.ts:323-329` carries the previous burst tuple forward verbatim when a
header write omits it. So a partial write reproduces the old deadline AND the old percent;
once wall-clock passes that copied deadline, my "an expired clock is sufficient evidence"
rule fired on a snapshot where upstream said nothing — on the once-per-pooled-response path.

My reasoning for dropping the drop-requirement (catching low-usage rollovers) was sound; the
conclusion was too broad. `scheduled` now requires the expired deadline PLUS corroboration:
either usage fell, or upstream issued a new deadline. A byte-identical carried-forward window
supplies neither. Regression test: "a carried-forward window past its deadline is NOT a
reset".

## Blocker 4 — High, and correct. Three missed consumers.

My field-chain audit searched for `agentTaskRecovery` and concluded `config.ts` plus
`types/config.ts` was the whole chain. It missed:

- `validFileConfigDiagnostics` (`src/config.ts:1957`) — a diagnostics warning surface
  SEPARATE from the three `loadConfig` branches, feeding `ocx config show --source`.
- `SECRET_KEYS` (`src/cli/config-command.ts:18`) matches
  `apiKey|key|accessToken|refreshToken|idToken|token|password|clientSecret`. `webhookUrl`
  matches none of them, so a Slack or Discord webhook — whose secret IS the URL — would be
  echoed in plaintext by `ocx config show` and written by `config export`. That is a real
  credential-disclosure defect, not a style nit.
- `safeConfigDTO` (`src/server/auth-cors.ts:695`) is an explicit whitelist, so the section
  is correctly invisible to the GUI. Right outcome, undocumented.

All three added to the wp4 file map in `030`, with `webhookUrl` redaction as a named
requirement.

## Blockers 3, 5, 7, 8 — accepted, folded into their phases

- **3:** `loadConfig` (`src/config.ts:1805`) is a `readFileSync` plus a full
  `safeParse` with no memoization. Calling it per pooled response to ask "is this feature
  off" is absurd. The gate becomes generation-cached via `captureConfigGeneration`.
- **5:** `PROTECTED` has FOUR entries and all four reach `src/codex/quota.ts` statically,
  so the lazy-import requirement is load-bearing and nothing enforced it. wp5's guard is
  parameterized over a target set and gets a synthetic attack case.
- **7:** `Bun.spawn` rejects a string `stdin`; encoded bytes it is.
- **8:** two concurrent forced refreshes make the loser skip both the commit and the notify.
  Once observation moves off `cache.key` (blocker 1) the loser still observes, so this
  largely dissolves — but the residual window is stated in `020` rather than hidden.

## Blocker 9 — Low, correct

`QUOTA_PERSIST_DEBOUNCE_MS` is at `src/codex/quota.ts:43`, not `:493` (that line is the
function). And `000_plan.md` promised docs `010`–`050` for wp1 while `050` is a wp5
deliverable. Both corrected.

## Blocker 6 — already fixed before the verdict arrived

The racy has/mark pair became one atomic `claimQuotaReset` during my own audit. The
reviewer noticed the shipped code already says "claim".

## Found by me, not the reviewer

`quotaResetKey` used `resetAt ?? "none"`. For the several provider parsers that never emit
a reset clock, every reset of one window collapsed onto a single key, so the first claim
would have permanently suppressed all later ones. Now falls back to the expired deadline
before "none", and a window with no deadline on either side is not evaluated at all.

VERDICT ACCEPTED: GO-WITH-FIXES (blockers=9). Two fixed in wp2, seven folded forward, none
rebutted.

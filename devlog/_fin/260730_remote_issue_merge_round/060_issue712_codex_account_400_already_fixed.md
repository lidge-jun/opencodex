# 060 — Issue #712: Codex-account model 400 + no account auto-switch (already fixed — with a posted-comment correction)

Work-phase: WP2 of the two-issue loop entry (2026-07-30).
Class: C1 (no production code change — triage close with version evidence, plus a public correction).
Issue: https://github.com/lidge-jun/opencodex/issues/712
Reporter: DingDingChae, version **2.7.31**, Windows 11, Claude Code client.

## Revision history

- r1 (initial P) — asserted a single v2.7.37 boundary covering both symptoms.
- **r2 (post-audit, round 1) — that assertion was WRONG.** The reviewer caught it; independently
  re-verified. There are **two** boundaries, and the comment already posted on #712 carries the r1
  error. This document is now a retrospective plus a correction task. See
  `070_audit_synthesis_round1.md`.

## Status of external state (read before acting)

#712 is **already CLOSED** (`2026-07-29T22:38:50Z`) with a comment by `lidge-jun`. So WP2's remaining
work is NOT "post a comment and close" — it is a **correction comment on the closed issue**.

## Reported symptoms

1. `API Error: 400 upstream error (400): {"detail":"The 'gpt-5.6-sol' model is not supported when
   using Codex with a ChatGPT account."}`
2. "Accounts do not also auto switch when account is used up" — with ~10 GPT accounts plus GitHub
   Copilot and Claude accounts in the pool.

## Finding: both symptoms are handled on current `dev`, and the fix postdates 2.7.31

### Symptom 1 — the exact error string is allow-listed and retried

`src/server/responses/core.ts:207` `isAllowListedCodexAccountModel400()` matches this precise detail
string, normalizing whitespace and case:

```ts
const expected = `The '${modelId}' model is not supported when using Codex with a ChatGPT account.`;
return normalizeCodexUnsupportedModelDetail(detail) === normalizeCodexUnsupportedModelDetail(expected);
```

`shouldRetryCodexPoolAccountModel400()` (line 226) additionally requires the body be display-safe and
untruncated before treating it as retryable. At line 1470 a match sets `poolRetryOutcome = 400`, which
enters `retryCodexPoolOnAlternateAccount()` (line 1482) — the request is retried on a different pool
account rather than surfaced to the client.

### Symptom 2 — quota exhaustion uses the same retry path, but it shipped LATER

`shouldRetryCodexPoolAccountQuota()` (line 243) returns true for `429` and `402`, and line 1476 feeds
it into the same `retryCodexPoolOnAlternateAccount()` call. So "account used up → switch accounts" is
the same mechanism as symptom 1, gated pre-stream only (the inline comment notes mid-stream quota
stays terminal, which is correct: SSE already began).

**Sharing a call site does not mean sharing a ship date.** That was the r1 error.

### Version boundaries — TWO, not one (corrected)

```
$ git log --format='%h %ad %s' --date=short -1 b5ca7f53a
b5ca7f53a 2026-07-24 fix(codex): retry allow-listed pool model rejection

$ git tag --list 'v*' --contains b5ca7f53a --sort=v:refname | head -1
v2.7.37

$ git tag --list 'v2.7.31' --contains b5ca7f53a | wc -l
       0

$ git log --format='%h %ad %s' --date=short -1 903b62c7d
903b62c7d 2026-07-28 fix(codex): same-request multi-account failover on quota 429 (#584) (#585)

$ git tag --list 'v*' --contains 903b62c7d --sort=v:refname | head -3
v2.7.43
```

| Symptom | Commit | Date | First release |
|---|---|---|---|
| Allow-listed model-400 retry | `b5ca7f53a` | 2026-07-24 | **v2.7.37** |
| Pre-stream 429/402 quota failover | `903b62c7d` | 2026-07-28 | **v2.7.43** |

The reporter runs **2.7.31**, which contains neither. Current release is v2.7.43, so "upgrade to
latest" remains the correct advice — but a user pinning exactly 2.7.37–2.7.42 would get the 400 fix
and **no** same-request quota failover.

### Honest limitation: one bounded alternate, not a walk

`src/server/responses/core.ts:307-310` states it directly: "One bounded alternate-account retry."
`retryCodexPoolOnAlternateAccount` resolves a single alternate via
`excludeAccountId: firstAuthCtx.accountId` (`core.ts:320-325`), which `src/codex/routing.ts:907-923`
filters. With ~10 pool accounts, if account A and account B both return a previously unknown 429, C
is **not** tried within that same request. Later requests can skip the newly cooled accounts, so the
pool still drains correctly across requests — but the reporter should not be told the proxy walks the
whole pool in one request.

Mid-stream quota is terminal by design once SSE has begun (`core.ts:1477`).

## Decision: keep the close, post a correction, no code change

This remains `NOOP` for production code — writing a new retry would duplicate a shipped mechanism,
and the close outcome was right. But the posted comment states:

> "That same retry path is what drives the account switching you found missing ... quota rejections
> and this model rejection both route through it."

placed under a **v2.7.37** boundary. That is inaccurate for symptom 2 and would mislead anyone who
pins 2.7.37 instead of taking latest. A public correction is required; silently leaving a wrong
technical claim on a closed issue is not acceptable.

Scope boundary:

- IN: one correction comment on #712 naming both boundaries (v2.7.37 / v2.7.43), the one-bounded-
  alternate limitation, and mid-stream terminality. Issue stays closed; the existing reopen
  invitation stands. This devlog record (UNIT-RESIDENCE-01).
- OUT: any change to `core.ts`, the retry allow-list, pool selection, or Claude Code routing. Also
  OUT: broadening the allow-list to fuzzy-match upstream detail strings — the exact-match design is
  deliberate (an over-broad match would retry genuine model-unavailable errors across every account
  and multiply upstream load). Also OUT: converting the single bounded retry into a full attempted-
  account loop — that is a real feature request, and it only becomes justified if someone reproduces
  multi-account exhaustion on >= 2.7.43.

## What we are NOT claiming

- We are not claiming the reporter's pool config is otherwise healthy. Ten GPT accounts plus Copilot
  and Claude accounts in one pool is a configuration we did not inspect, and their screenshot was not
  re-verified against 2.7.43 behavior.
- We are not claiming the 400 never reaches a client on current `dev`. If every pool account rejects
  the model, the retry exhausts and the error surfaces — correctly. That is a different bug report
  than the one filed, and the comment invites it explicitly.

## Accept criteria

| # | Scenario | Observable proof |
|---|----------|------------------|
| 1 | Allow-list still matches the reported string on current `dev` | `isAllowListedCodexAccountModel400` read at `core.ts:207`; exact-string construction quoted above |
| 2 | Quota path shares the retry | `shouldRetryCodexPoolAccountQuota` (429/402) → same `retryCodexPoolOnAlternateAccount` call site |
| 3 | Model-400 fix postdates the reported version | `git tag --contains b5ca7f53a` → first tag `v2.7.37`; `v2.7.31` does not contain it |
| 4 | Quota failover has its OWN later boundary | `git tag --contains 903b62c7d` → first tag `v2.7.43` |
| 5 | Retry is one bounded alternate, not a pool walk | `core.ts:307-310` comment + `excludeAccountId` at `core.ts:320-325` filtered by `routing.ts:907-923` |
| 6 | Issue closed with evidence and a reopen path | Posted comment URL + issue state `CLOSED` |
| 7 | Correction published | New comment URL on #712 naming both version boundaries and the bounded-retry limitation |

## Verification (C phase)

No build gate applies — no source file changes. Verification is the GitHub comment state plus the
quoted code/tag evidence in criteria 1-6, with criterion 7 as the published correction.

## Lesson recorded (LOOP-PESSIMIST-01)

What died: the inference "two branches feeding one call site shipped together." Two branches sharing
a call site tell you nothing about their release history. For any "already fixed, just upgrade" close,
run `git tag --contains` on **each** symptom's commit separately — one per reported symptom, never one
per issue.

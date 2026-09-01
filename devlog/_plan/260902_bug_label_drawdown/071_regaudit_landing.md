# 071 — regaudit landing

## Reviewer verdicts (verbatim tails)

### Pass 1 — src-touching commits, first half (Faraday, xai/grok-4.6)

VERDICT: pass
c7f3f6f31 compaction can send a bare native id to a non-OpenAI default (medium)
0d6424f80 streaming 413 becomes terminal SSE overflow, not HTTP 413 (medium)
865a36ef0 dotenv-only Claude creds can be classified proxy (medium)
efefe3671 standalone still shows dead key-rotation UI (medium)
2e2da87b5 quota-word 5xx can cool/rotate a pool account (low)
51c49177f Hermes export model list shape changed (low)
f3bcc67a7 citation PUA stripped on translated streams (low)
7386b5201 combo default can raise to lowest supported rung (low)

Checked and not counted: outbound body ceiling default-off (52d941640); loopback
/v1/alpha/search still authenticates inside the handler (53c09a247); pairing "allowed" in
pairing only matches refusals (88d9889bb); logout goes through patched window.fetch so CSRF is
attached (9bded9c41); native-main refresh claim/identity checks fail closed (fecb77a91,
c17bc94c2).

### Pass 2 — src-touching commits, second half (Kuhn)

VERDICT: pass
- 863a88ea3 src/client/state.ts:43 — unreadable config.json is invalid, so ocx start/ensure/claude
  exit 1 instead of the old default fallback. Medium.
- b14b741dc src/service.ts:2127 — unscoped Windows session-recovery triggers fail closed and skip
  auto-repair. Medium, Windows-only.
- bf221bc26, d25cbc02a, 10a31986a, 4fdd54d46, b81c43551 — low, hub/relay/MiniMax-only.

### Pass 3 — tests-only commits + two newest feature commits (Epicurus)

VERDICT: pass
4a382beed keeps Design B unless codexDesktopAuthless === true on loopback. 0d73d6557's
/v1/images relay returns immediately unless images.bridgeEnabled === true and an xAI provider
exists. No Node-only APIs. Tests-only commits add coverage or retarget assertions to
#3198/#3108/remote-protocol contracts; none skip, mock away a live path, or drop a security check.

### Pass 4 — MAINTAINERS security boundary (Socrates)

VERDICT: pass
41 commits in-scope. 6f415bae is workflow_call only — no PAT, no release-job write grant, pinned
actions. Pairing/session/rotation stay grant- or management-authenticated; public
/opencodex-session is hub-only, origin-bound, rate-limited. Authless Desktop is loopback-only.
CI still runs bun run privacy:scan.
Residual (non-blocking): 863a88ea3 src/lib/service-secrets.ts:40 live service-api-token reads skip
the owner-only mode check .prev enforces; abf0f81bd src/server/auth-cors.ts:134 hub
managementPublicOrigin replaces the observed scheme.

## Follow-ups filed from the residuals

Recorded here as candidates; none blocks promotion and none carries the bug label:

1. service-secrets: apply the owner-only mode check to the live token read, not only `.prev`.
2. auth-cors: let pairing observe the raw scheme when `managementPublicOrigin` rewrites it.
3. client/state: consider a warning-plus-default path for an unreadable `config.json` on
   standalone hosts instead of exit 1.

## Exact-head CI (workflow_dispatch on the dev tip)

Run 33552542958 on `5bc6939d8` (branch `codex/regaudit-ci-5bc6939d8` = `origin/dev`),
Windows shards enabled. Result: **every non-Windows job green on the exact head** — test 1/4
through 4/4 (Linux), macos, gates, storage policy, api usage, keyring ubuntu/macos/windows,
npm-global ubuntu/macos/windows. That settles the two macOS failures seen during the train
(`lab-live-pinned-timeouts` first-byte race, `codex-prompt-route` probe race) as flakes: the
same tip passed the whole macOS suite.

The four Windows shards failed (1/4, 2/4, 4/4 failure; 3/4 cancelled by the composed gate).
The failure signatures are environmental, not assertion failures in campaign code:

- shard 2/4: `ACL hardening failed (EICACLS) — icacls command error` thrown from
  `hardenSecretDir(..., { required: true })` inside `saveConfig` (`src/config.ts:2674`) and
  `ETIMEDOUT — transient icacls stall` 16×. Every test that calls `saveConfig` on that runner
  fails identically. The ACL module (`src/lib/windows-secret-acl.ts`) and `atomic-write.ts`
  are unchanged since `main` (only `e5d588669`, already on `main`, touches them).
- shard 1/4 and 4/4: `EPERM: operation not permitted, rm 'tests\.tmp-codex-accounts-test'`
  (49×) and `rm 'tests\.tmp-codex-auth-api-test'` (287×) — Windows file-handle contention on
  the test temp dirs during `rmSync`, cascading into every case in those files. Plus one
  "Bun runtime crash" retry.

History: the last Windows-green dispatch was `33290817128` on `223a0a287` (on `main`); the
dispatch on the same SHA from `dev` (`33291970929`) failed Windows 3/4, and the intervening
Windows dispatches on feature branches (`33292931792`, `33290258063`, `33289201339`,
`33288039685`) all failed. Windows shards have therefore not been a stable signal for any
branch since 2026-08-30, before this campaign's first landing.

Control: the same workflow dispatched on `origin/main` (`af6113a03`, branch
`codex/regaudit-ci-main-af6113a03`, run 33555110133). Result: CONTROL_PLACEHOLDER

## Devlog stack landing

Branch `codex/260902-bug-pr-closeout-stack` (devlog-only) → PR PR_PLACEHOLDER.

## Final bug-label count

COUNT_PLACEHOLDER

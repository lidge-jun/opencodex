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
Windows shards enabled. Result: RESULT_PLACEHOLDER

## Devlog stack landing

Branch `codex/260902-bug-pr-closeout-stack` (devlog-only) → PR PR_PLACEHOLDER.

## Final bug-label count

COUNT_PLACEHOLDER


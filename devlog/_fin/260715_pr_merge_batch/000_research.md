# 260715 PR merge batch — research notes

Session: 019f638e-885f-7151-a19e-adb92823cb2e (codexclaw HOTL loop, goalplan `land-open-prs-128-129-130-132-onto-opencodex-dev`)
Date: 2026-07-15

## Objective

Land all 4 open PRs onto `dev` (stacking improvements on top where warranted, per user
instruction — contributor PRs are not rejected by default), then promote
`dev -> main -> preview` and publish an npm release (expected `2.7.19`).
Push + deploy pre-approved by the user in the kickoff message.

## Branch state (verified 2026-07-15)

- `dev` == `main` == `preview` == `a50e1470` (`release: v2.7.18`). Promotion will be
  fast-forward if nothing else lands on main meanwhile.
- Current npm version: `@bitkyc08/opencodex 2.7.18`.
- Release path: bump on main + `bun run release <version>` -> GitHub Actions
  `release.yml` workflow_dispatch (dry-run default false via script), OIDC trusted publishing.

## PR inventory (all base=main, all MERGEABLE as of check)

| PR | Title | Author | Files (headline) | Size |
|----|-------|--------|------------------|------|
| #130 | tooling: pre-push hook matching the CI gate | Wibias | package.json, scripts/pre-push.sh, scripts/setup-hooks.ts, tests/claude-agents-inject.test.ts | ~64 ins |
| #128 | feat(provider): OpenCode Free keyless public tier | Wibias | adapters, registry, derive, auth-cors, relay, request-log, GUI, tests | ~550 ins |
| #129 | feat(provider): MiMo Free keyless Xiaomi public tier | Wibias | adapters/mimo-free.ts, registry, derive, adapter-resolve, auth-cors, GUI, tests | ~470 ins |
| #132 | fix(gui): OAuth manual redirect URL / code paste fallback | claudianus | src/oauth/*, management-api, GUI Providers/AddProviderModal, i18n de/en/ko/zh, tests | ~369 ins |

Known overlap risk: #128 and #129 both touch `src/providers/registry.ts`,
`src/providers/derive.ts`, `src/adapters/openai-chat.ts`, `src/server/auth-cors.ts`,
`gui/src/components/AddProviderModal.tsx`, `gui/src/pages/Providers.tsx`,
`gui/src/provider-icons.ts`, `tests/provider-registry-parity.test.ts`,
`tests/server-auth.test.ts`, `tests/claude-agents-inject.test.ts`.
#130 also touches `tests/claude-agents-inject.test.ts` (small).

## Review dispatch (sol subagents, cxc-search attached)

| Agent | Scope | Status |
|-------|-------|--------|
| Chandrasekhar (019f6392-7983) | #130 tooling: CI-gate parity, setup-hooks safety, portability | dispatched |
| Goodall (019f6392-7c31) | #128+#129 providers: endpoint legitimacy proof (web), conflict map, landing order | dispatched |
| Copernicus (019f6392-7ec3) | #132 OAuth: PKCE/state correctness, security regression, i18n, test coverage | dispatched |

Findings are folded into this folder's decade docs when returned; raw verdicts appended
below in `## Review findings`.

## Landing strategy (draft, to be locked at roadmap D)

1. WP1 / doc 010 — #130 (smallest, tooling-only; establishes pre-push gate for the rest).
2. WP2 / doc 020 — #128 then #129 (reviewer may flip order based on conflict map).
3. WP3 / doc 030 — #132 + stacked improvements from review.
4. WP4 / doc 040 — push dev, ff-merge main, merge preview, CI proof, `bun run release 2.7.19`, npm view proof, close PRs with merged-via-dev comments if GitHub does not auto-mark them.

Landing mechanics: merge each PR branch into local `dev` (`git merge --no-ff` or
cherry-pick preserving contributor authorship), run `bun test --isolate ./tests/` +
`bun run typecheck` after each landing, commit per landing (LOOP-GIT-01).

## Open questions

- OQ1: Are the keyless endpoints in #128/#129 legitimate public services? (Goodall, web proof required)
- OQ2: Does #132's management-api code-paste endpoint introduce a CSRF/auth hole? (Copernicus)
- OQ3: Since PRs base=main and dev==main, do PRs auto-close on push? Base is `main`; merging via dev then pushing main should mark them merged only if commit SHAs are preserved (merge, not squash/cherry-pick). Decide per PR in decade docs.

## Review findings

### Copernicus — PR #132 (returned)

Verdict: **land-with-fixes**. Focused suites 36 pass, root+GUI typecheck pass on PR tarball.

Blockers (Medium):

1. `src/oauth/callback-server.ts:239-245` — pasted redirect URL/query WITHOUT `state` is
   accepted as if it were a raw code, silently dropping the state defense (PKCE still
   protects today; unsafe for future non-PKCE flows). Fix: `parseCallbackInput` returns
   `{kind: url|query|raw, code, state}`; enforce state match for url/query, allow missing
   state only for syntactically-raw codes.
2. `tests/oauth-manual-code.test.ts:54-105` — test never proves successful manual login
   or PKCE continuity (token exchange marked unexpected, mismatched state accepted
   either way). Fix: deterministic fake flow / mocked token endpoint asserting
   code_verifier, redirect URI, pasted code, persistence, done status + negative cases
   + route-level test of `POST /api/oauth/login/code`.

Non-blocking stacked candidates: AddProviderModal hard-codes all six strings in English
(bypasses existing `prov.paste*` keys, missing aria-label); add endpoint-specific input
length limit in management-api; validate before returning success (immediate 400/409);
UX copy "copy the full URL from the browser address bar". Security otherwise clean:
PKCE retained (xai.ts:150-184 pattern), no open redirect, no code logging, management
auth/Origin policy unchanged. Sources: RFC 9700, RFC 8252, RFC 8628, Google OOB
migration guidance.

Plan impact: 030 B-phase stacks fixes for blockers 1+2 and the i18n gap.

### Chandrasekhar — PR #130 (returned)

Verdict: **land-with-fixes**. PR checks green on all 3 platforms, but installer flawed.

Blockers:

1. HIGH `scripts/setup-hooks.ts:27` — `copyFileSync` silently overwrites an existing
   pre-push hook. Fix: abort/back-up when dest exists and differs.
2. HIGH `scripts/setup-hooks.ts:14` — hard-coded `<repo>/.git/hooks` breaks for git
   worktrees (`.git` file), `core.hooksPath`, non-default git dirs. Fix: use
   `git rev-parse --path-format=absolute --git-path hooks` (verified locally by reviewer).
3. MEDIUM — "matching the CI gate" is overstated: hook runs typecheck+test only; CI also
   runs privacy:scan, release-helper build, GUI lint/build, CLI smoke, npm-global matrix.
   Fix: reword claim OR add shared `ci:gate` script used by both.
4. MEDIUM `tests/claude-agents-inject.test.ts:92-96` — EPERM catch turns a skip into a
   silent pass. Prefer capability detection + explicit conditional skip.

Wiring notes: do NOT auto-add `prepare` lifecycle (bun install would mutate git config —
Bun docs); `prepush` npm script is dead duplication — make the hook shim
`exec bun run prepush` for one source of truth; add trailing newlines; BOM in
setup-hooks.ts (found in local diff read). Sources: git githooks docs, Bun install +
module-resolution docs.

Plan impact: 010 B-phase merges PR then stacks fixes for 1/2/4 + claim reword +
shim `exec bun run prepush` + BOM/newline cleanup. Consider adding privacy:scan to the
prepush script (cheap, part of CI gate).

### Goodall — PR #128 + #129 (returned)

#128 verdict: **land-with-fixes**.

- HIGH: PR head CI red on every job — unused `hints` at `gui/src/provider-icons.ts:52`.
- MEDIUM: `src/adapters/openai-chat.ts:445` reverses global header precedence
  (provider.headers now overridden by apiKey auth); unnecessary for opencode-free.
  Fix: keep existing precedence; apply registry staticHeaders separately.
- MEDIUM: `relay.ts:215` / `request-log.ts:297` buffer non-JSON >=400 bodies fully and
  store 500 chars — PII risk, unbounded buffering. Fix: bounded reader + keep cap.
- MEDIUM: no free-tier data-use warning; OpenCode Zen docs say free-model inputs may be
  retained/used for training. Fix: registry note + link.
- Endpoint legitimacy VERIFIED from primary sources: opencode.ai/docs/zen + opencode
  server source (`public` key = anonymous; `x-opencode-client` is first-party).
- Note: PR body claims `Authorization: Bearer public` but code sends no auth header —
  both anonymous server-side; align description/tests.

#129 verdict from reviewer: **reject in current form** (undocumented private protocol,
UA spoof + MiMoCode identity marker to pass "Illegal access", machine fingerprint from
hostname/OS/arch/CPU/username; retry body not disposed; no abort/timeout/single-flight).
Xiaomi's anonymous free MiMoCode tier is officially confirmed, but the exact
bootstrap/chat contract only appears in third-party reverse-engineering material.

**Main-session synthesis (accept/rebut, recorded per REVIEW-SYNTHESIS-01):** the
"reverse-engineered first-party client emulation" objection is REBUTTED as a landing
blocker: it is this repo's core architecture (see `src/adapters/client-fingerprint.ts`
— Claude Code + Antigravity header mirroring; `kiro.ts:512` KiroIDE UA + fp). #129 is
consistent with existing kiro/antigravity adapters. ACCEPTED as stacked-fix blockers:
(a) machine-derived fingerprint -> replace with persisted random UUID (privacy),
(b) retry response body not drained, (c) bootstrap abort/timeout/single-flight.
Residual risk (Xiaomi contract may change/ban) is noted in the provider note, same as
other emulated providers. Escalation to user only in final report, not a stop.

Conflict map (Goodall): #128/#129 share near-identical hunks in AddProviderModal,
Providers.tsx, provider-icons, derive.ts (`keyOptional` propagation), auth-cors DTO
allowlist, openai-chat header hunk, claude-agents-inject symlink skip, and direct
conflicts in provider-registry-parity (3 expected arrays) + server-auth tests.
Landing order: #128 first (based on current main a50e147; #129 based on older
16bef043), then #129 dropping duplicate hunks. Registry order: OpenCode before Xiaomi;
MiMo after Kilo. Both PRs drop the openai-chat.ts:445 precedence reversal.

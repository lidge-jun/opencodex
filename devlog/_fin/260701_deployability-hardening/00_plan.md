# Deployability hardening: dev vs main (2.6.13 -> 2.6.14)

Date: 2026-07-01
Surface: release (package.json version) + src/adapters/anthropic.ts fingerprint headers.
Class: C4 (release surface).
Status: VERIFIED - candidate 717d2ff green in a clean worktree; pending gpt-5.5 final review + user go for merge/release.
Loop: cxc-loop PABCD, one work-phase (WP1).

## Goal

Make `dev` deployable relative to the previously published `origin/main` (npm
`latest = 2.6.13`), without sweeping in the unrelated in-progress fingerprint
refactor that sits dirty in the worktree.

## Blockers found (git diff origin/main..HEAD)

1. Version regression (RELEASE BLOCKER). `dev` package.json was `2.6.4` while
   `origin/main` is `2.6.13` and npm `latest` is `2.6.13`. Publishing from this
   tree would either fail or ship a lower version. The dev worktree's
   package.json had been reset in an earlier session and never re-bumped.

2. Untested swept headers. Commit 1302a18 carried two new request headers into
   `src/adapters/anthropic.ts` with no paired test:
   - `Accept`: stream-conditional (`text/event-stream` when streaming, else
     `application/json`).
   - `User-Agent`: `@anthropic-ai/sdk/0.74.0`.
   These are coherent first-party fingerprint hardening (they match the pinned
   SDK `0.74.0` in `client-fingerprint.ts` / `CLAUDE_CODE_HEADERS`) and apply on
   BOTH the OAuth and API-key paths (set before the `isOAuth` branch). Intended,
   but uncovered.

## Already-good intended changes on dev (verified, not re-touched)

- WP1 anthropic reasoning-"none" gate (5ac3573) + test.
- WP2 openai-chat EOF fail-closed on truncated stream (3ac5dc2) + test.
- WP4 server.ts partial split: gui-static + adapter-resolve (behavior-preserving).
- WP5 codex-catalog golden oracle test (future split safety net).

## Out of scope (left dirty, NOT swept)

In-progress fingerprint refactor in the worktree: `client-fingerprint.ts`
(X-Stainless-Arch/OS/Package-Version/Runtime-Version additions), `google.ts`,
`kiro-wire.ts`, `kiro.ts`, `oauth/anthropic.ts`, `oauth/google-antigravity.ts`,
`oauth/kimi.ts`, `tests/google-antigravity-wire.test.ts`. These are user work
and are not required for this release candidate.

## Fix applied (WP1, candidate 717d2ff)

1. `package.json`: `2.6.4 -> 2.6.14` (next unused; npm dist-tags `latest=2.6.13`,
   `preview=2.6.11-preview.20260630`).
2. `tests/client-fingerprint.test.ts`: added two assertions —
   - `Accept=application/json` + `User-Agent=@anthropic-ai/sdk/0.74.0` on both
     OAuth and API-key paths.
   - `Accept=text/event-stream` for a streaming request.
   Red-green confirmed: removing the `Accept` header fails 2 tests.

## Verification (clean throwaway worktree, mandatory)

The dirty main worktree masks regressions, so verification ran in a detached
clean worktree at the candidate SHA:

    git worktree add --detach /tmp/ocx-verify-717d2ff 717d2ff
    bun install --frozen-lockfile
    bun run privacy:scan   # passed
    bun x tsc --noEmit     # exit 0
    bun test ./tests/      # 977 pass / 0 fail / 5123 expect, 93 files (2 stable runs)

Baseline was 975; +2 from the new fingerprint assertions. Worktree removed after.

## Remaining gate

- gpt-5.5 xhigh final deployability review of 717d2ff vs origin/main.
- Merge dev -> main/preview + publish 2.6.14 ONLY after explicit user confirmation.

## WP2 (post-review hardening + user-authored changes folded in)

After the WP1 gpt-5.5 review (SHIP-WITH-NITS), the user confirmed the previously
deferred working-tree changes are THEIR work and must ship in this release. WP2
folds them in and clears the one MEDIUM from the WP1 review.

Candidate SHA: `f34f742`.

1. openai-chat EOF MEDIUM fixed: a final `finish_reason`/usage frame delivered
   WITHOUT a trailing newline stayed in `buffer` and was never parsed at reader
   EOF, so a complete stream was falsely failed. Added a trailing-buffer flush
   before the terminal-signal check; a genuinely truncated mid-content frame
   still fails closed. +3 paired tests (red-green verified).
2. openai-responses: `stripUnsupportedHostedTools` removes hosted tools a native
   slug rejects (codex-spark vs `image_generation`) before OAuth passthrough.
   +2 paired tests. (user-authored)
3. client-fingerprint: added X-Stainless Arch/OS/Package-Version/Runtime-Version.
4. google: antigravity UA assembly moved; runtime `x-goog-api-client` dropped
   (now onboarding-only) + test updated. Fixed a stray 7-space indent.
5. oauth: anthropic tool prefix `proxy_`->`custom_`; antigravity onboarding UA +
   `x-goog-api-client`; kimi CLI `0.14.0` + `kimi_code_cli` platform.
6. kiro: fingerprint salt + `KIRO_IDE_VERSION` alignment.

### Verification (clean worktree at f34f742)

    bun test ./tests/       # 982 pass / 0 fail / 5134 expect, 93 files (2 stable runs)
    bun x tsc --noEmit      # exit 0
    bun run privacy:scan    # passed
    bun run prepublishOnly  # GUI build + package prep, exit 0
    npm pack --dry-run      # bitkyc08-opencodex-2.6.14.tgz, 131 files, valid

Final gate: gpt-5.5 review of f34f742, then merge dev->main/preview + publish 2.6.14.

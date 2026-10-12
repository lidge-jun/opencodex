# Quota send-lock contributor split: roadmap

Status: roadmap locked by the docs-only cycle; implementation runs one PABCD cycle per PR.
Date: 2026-10-01. Baseline: `origin/dev` `64294638a69e25ca0c7a4e2102e2349973161f71`.

## Problem

The Codex desktop composer disables Send when the signed-in ChatGPT quota reports
exhausted, even for models opencodex routes to independently funded providers
([#6196](https://github.com/lidge-jun/opencodex/issues/6196), duplicate
[#4878](https://github.com/lidge-jun/opencodex/issues/4878)). Two contributor PRs
address it:

- [#5947](https://github.com/lidge-jun/opencodex/pull/5947) (lcxhh521, head
  `61947c04d9`, +7317 / 54 files) mixes three mechanisms: (a) a local-CA TLS
  intercept of chatgpt.com traffic (send-unblock), (b) a PAC fallback entry so the
  intercept survives opencodex stopping, (c) an app-server shim: a `CODEX_CLI_PATH`
  launcher that execs the bundled `codex app-server` and filters only its stdout,
  clearing the plain-quota gate in `account/rateLimits/read` and
  `account/rateLimits/updated`.
- [#5879](https://github.com/lidge-jun/opencodex/pull/5879) (MateuszJuszczyk, head
  `9a5b6d9d72`) toggles `codexDesktopAuthless` automatically on quota exhaustion.

## Evidence

- #6196 (TooSpace, 2026-09-27..29): with (a)+(b) deployed, the loopback listener saw
  **zero established connections over ~20 h**; the bundled app-server owns the
  chatgpt.com sockets, so the intercept never sees the gate reads.
- #6196 (TooSpace, 2026-10-01 10:47 Asia/Taipei): Plus account, 5-hour window 100%,
  weekly 51%, Desktop 26.928.21956 / bundled CLI 0.159.2: launching through the shim
  launcher re-enabled Send before the window reset; `dynamic_app_tools_peer_rejected`
  did not recur. Ingwannu's note: the run had intercept + shim + restart together,
  so it does not isolate the shim as sole cause.
- `devlog/_plan/260928_macos_quota_gate/000_design.md` (maintainer design) prefers
  upstream provider-aware admission and rejects CA installation and quota rewriting.
  The split PRs below are explicitly experimental/opt-in candidates the maintainers
  may close against that decision.

## Existing defence and its gaps

`codexMainAccountHardLock` (default on since #5694, `src/codex/main-account-hard-lock.ts`)
stops opencodex from sending main-account traffic at 98% on any governing window.
Gaps: usage outside opencodex, observation lag (a long turn crosses 98%), the small
Plus 5-hour window, and `unknown` state admitting.

## PR map (dependency order)

| Doc | Work-phase | Branch | Base | Credit |
| --- | --- | --- | --- | --- |
| 010 | wp1 hard-lock hardening | `codex/main-hard-lock-window-thresholds` | `dev` | none (maintainer code) |
| 020 | wp2 app-server shim | `codex/chatgpt-app-server-shim` | `dev` | Co-authored-by: lcxhh521 |
| 030 | wp3 local-CA send-unblock intercept | `codex/chatgpt-send-unblock-intercept` | wp2 branch (stacked) | Co-authored-by: lcxhh521 |
| 040 | wp4 PAC fallback | `codex/chatgpt-pac-fallback` | wp3 branch (stacked) | Co-authored-by: lcxhh521 |
| 050 | wp5 #5879 disposition | none (rationale only) | - | - |
| 060 | wp6 closeout | - | - | - |

Stacking reason: wp2, wp3 and wp4 all extend the same new `ocx chatgpt` command and
`chatgptDesktop` config block. Opening them independently against `dev` would
make the second one to land conflict on `src/cli/chatgpt-command.ts`, the config
type/validator, the CLI registry, the guide and `structure/clients/chatgpt-desktop.md`.
The PAC fallback has no function without the TLS listener (its CONNECT entry only
splices into that listener), so wp4 cannot target `dev` alone. The shim has no
dependency on either and is the piece with field evidence, so it sits at the bottom.
Stack lifecycle:

- Parent merged (squash): rebase the child with
  `git rebase --onto origin/dev <old parent head> <child>`, retarget it to `dev`, and
  wait for fresh CI on the new head. Cascade the same rebase to every descendant
  (wp4 onto the new wp3 head) and wait for fresh CI on each. Land bottom-up only.
- Parent closed: its children carry its commits and dependencies, so they close with
  it unless a maintainer asks for a reconstruction on a different base. The children
  are themselves "may close" candidates, so this is the expected path if the shim is
  rejected.

wp1 is independent of all three.

## Common constraints

- New branches from latest `origin/dev`; `codex/` prefix; no git config, no GIT_* env.
- Respect `tests/fixtures/file-size-baseline.json`; unlisted files stay below 2000 lines.
- New test files: register in `scripts/test-layout/layout.json` `explicit` and
  `tests/fixtures/test-layout-expected.json`.
- `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts` must not
  reach new optional modules (core-lab boundary).
- GUI strings in all ten locale catalogs; GUI PRs need a screenshot on `pr-assets`.
- Verification per PR: `bun run typecheck`, focused tests, `bun run test:changed`,
  `bun run structure:check`, `bun run privacy:scan`, `bun run skill:surface:check` when
  the CLI changes, the core-lab boundary test, and the full `bun run test` (or the
  documented resource exception recorded in the PR), then required CI green on the
  exact pushed head.
- wp2-wp4 touch process exec and credential interception: PR descriptions request
  explicit security review per MAINTAINERS.md.
- Merge/close decisions belong to maintainers; this unit opens PRs only.


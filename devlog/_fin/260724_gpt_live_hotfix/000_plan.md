# 260724_gpt_live_hotfix — GPT‑Live (voice) `/v1/live` relay: PR #379 status + release plan

Unit owner: codex (live agent)
Branch/worktree: `codex/260724-gpt-live-hotfix` @ `/Users/jun/.codex/worktrees/260724-gpt-live-hotfix/opencodex`
Base at authoring: `origin/dev` = `9dc88f27` (ff-only, no unique local commits)
Class: C3 (report + release enablement; no production code authored in this unit yet)
Status of this doc: **P (concretize) — reporting to user before implementation**

## 0. Objective

Make Codex App / ChatGPT **voice (GPT‑Live / Frameless Bidi)** actually work when
OpenCodex is injected as `base_url` under Design B, then ship it as a hotfix
release. Issue #371: voice call-create hits `POST /v1/live` and dies on the
`/v1/*` JSON‑404 guard. PR #379 is the candidate fix.

The user's directive: land a **working** hotfix now (release-first), refine
later. This unit tracks where #379 actually stands and what remains before a
patch release.

## 1. Live-state findings (verified 2026-07-24T04:31Z)

### 1.1 PR #379 — current head `5e55fe5d` (force-updated ~04:19Z)

The PR was **substantially rebuilt after the maintainer's DEFER**. Earlier head
(`e932fd4c`) was POST-only with the sideband WS explicitly left as a follow-up.
The new head adds exactly the three things the maintainer flagged.

| Item | Earlier `e932fd4c` | New head `5e55fe5d` |
|---|---|---|
| POST `/v1/live` + `/v1/realtime/calls` call-create relay | yes | yes |
| ChatGPT multipart → backend `{sdp,session?}` JSON rewrite | yes | yes |
| `intent=quicksilver&architecture=avas` call-create query | **missing** | **added** (`LIVE_AVAS_QUERY`, `withAvasQuery`) |
| Sideband WebSocket relay (`/v1/live/{callId}`, `/v1/realtime/calls/{callId}`, `/v1/realtime?call_id=`) | **missing** | **added** (transparent bidi relay) |
| Body size cap that actually bounds memory | buffered whole body first (cap defeated) | incremental `readBodyCapped` (req 16 MiB / resp 16 MiB) |
| Pool-account token override on relay | yes | yes (shared `resolveLiveRelay`) |
| Locale architecture docs (ja/ko/ru + en/zh) | partial | all 5 synced |

Files (vs `origin/dev`): `src/server/live.ts` (+454, NEW), `src/server/index.ts`
(+182), `src/server/ws-bridge.ts` (+7), `src/server/auth-cors.ts` (+3, CORS
`ChatGPT-Account-Id`), 5 architecture docs, `tests/server-live.test.ts` (+501,
NEW, 10 tests incl. sideband), `tests/server-auth.test.ts` (+3).

### 1.2 CI (PR #379 @ `5e55fe5d`)

All required checks green on the exact head:

- Cross-platform CI: ubuntu / windows / macos + npm-global smoke (all 3 OS) — SUCCESS
- Service lifecycle: linux-systemd / macos-launchd / windows-schtasks — SUCCESS
- React Doctor, PR Labeler — SUCCESS
- CodeRabbit re-reviewed `e932fd4c..5e55fe5d` (11 files) — COMMENTED
- `mergeStateStatus: CLEAN`, `mergeable: MERGEABLE`, base `dev`, not draft

### 1.3 Local verification (this unit, on top of `origin/dev` `9dc88f27`)

Merged `origin/fix/proxy-v1-live` onto current dev in a throwaway branch
(`tmp/live-verify-379`, since deleted). PR touches files dev has not moved
(dev's recent commits are bridge/backpressure only) → **no conflicts**.

- `bun install --frozen-lockfile` → ok
- `bun run typecheck` (`tsc --noEmit`) → **exit 0**
- `bun test tests/server-live.test.ts tests/server-auth.test.ts` → **64 pass / 0 fail** (379 expects, 6.0s), including:
  - `sideband GET /v1/live/{callId} upgrades and relays bidirectionally to ChatGPT backend`
  - `buildLiveSidebandUpstreamWsUrl maps Frameless and Realtime join shapes`

### 1.4 Contract cross-check vs codex-cli (upstream source of truth)

`/Users/jun/Developer/codex/120_codex-cli` @ `4462b9dee` (2026-07-23):

- Call-create query `intent=quicksilver&architecture=avas` — matches
  (`realtime_call.rs:522/675`, app-server tests `:1435/1507/1837`).
- Frameless sideband path `/v1/live/{callId}` — matches (`realtime_call.rs:560/697`, app-server `:285/1580`).
- Realtime v1 join `/v1/realtime?intent=quicksilver&call_id=` — matches (core tests `:781/895/1135`).

PR #379's `forwardLiveUrl` / `keyedLiveUrl` / `buildLiveSidebandUpstreamWsUrl`
reproduce these exactly. **Contract is faithful to current upstream.**

### 1.5 Maintainer triage state (dev `9dc88f27`, `devlog/_plan/260724_pr_triage/000_plan.md`)

> `#379 | voice relay /v1/live | REBUILD_ON_DEV (Arendt): sideband WebSocket +
> backend query contract missing, buffering defeats size cap | DEFER — review
> comment posted | comment posted`

The three DEFER reasons were **all addressed by `5e55fe5d`**, which landed after
the triage row was written. So the recorded status ("DEFER") is **stale** with
respect to the current PR head. This is the key decision the user needs to weigh.

### 1.6 Release baseline (npm `@bitkyc08/opencodex`, verified 04:1x–04:3xZ)

- npm dist-tags: `latest = 2.7.35`, `preview = 2.7.38-preview.20260724`.
- Note: `2.7.36` was published then **`main` reverted to the 2.7.35 tree**
  (`42a1b60e revert: restore v2.7.35 tree on main (2.7.36 regression, pending fix)`),
  so `latest` deliberately points back at 2.7.35 while 2.7.36/2.7.37 are burned.
- Next stable patch must be chosen against live npm + git tags at release time
  (release helper `assertUnusedReleaseVersion` enforces this). Candidate: **2.7.37**
  (unused on npm), but confirm live before dispatch — do not hardcode.
- Release authority: `scripts/release.ts` on `main`/`preview` only; requires
  exact-SHA Cross-platform CI **and** Service lifecycle green, then dispatches
  `release.yml`. Promotion order dev → preview → main is maintainer-controlled.

## 2. Where #379 stands — one-line answer

**PR #379 is now functionally complete and green**: call-create relay + AVAS
query + full bidirectional sideband WebSocket relay + bounded buffering, with
local typecheck/tests and remote CI all passing, and the wire contract matches
current codex-cli. The only blocker to "voice works on a release" is **merge +
release**, not missing code. The maintainer's DEFER predates the fixing commit.

## 3. Open questions / risks (need a call before B)

1. **Merge path.** #379 is an external contributor PR (Wibias) already targeting
   `dev` and green. Options:
   (a) let the maintainer merge #379 as-is, then we cut the release; or
   (b) we take over on this branch (cherry-pick / re-land) only if the user wants
   local edits first. Recommend (a) — the PR is clean and CI-proven; re-landing
   duplicates work and loses attribution.
2. **Manual runtime proof.** Automated tests + upstream-contract match are strong,
   but nobody has driven **real Codex App voice through ocx** end-to-end yet
   (PR test-plan item is unchecked). A hotfix release without one live smoke is a
   calculated risk. Decide: release on CI+contract confidence, or gate on one
   manual voice smoke first.
3. **Residual hardening (post-release, non-blocking).** Not required for "works",
   but worth a follow-up unit: no idle/stall timeout on the sideband socket
   (`WEBSOCKET_IDLE_TIMEOUT_SECONDS = 0`); `LIVE_SIDEBAND_PENDING_MAX = 32`
   pre-open frame cap drops → closes 1009; CodeRabbit's earlier error-branch
   coverage nits (malformed multipart, oversize, auth-error mappings) partly
   covered — audit before closing the follow-up.
4. **Release regression caution.** `main` just reverted a 2.7.36 regression.
   Cutting 2.7.37 straight from a voice PR means the release train must go through
   preview first and both exact-SHA gates, per `scripts/release.ts`.

## 4. Proposed plan (pending user approval — no code/push yet this unit)

- **WP1 — Decision + merge (needs user):** confirm merge path (3.1). If (a),
  ping maintainer / approve #379; if (b), stage a local re-land on this branch.
- **WP2 — Pre-release verification:** on the exact merge SHA, full `bun run
  typecheck` + `bun test` + `bun run privacy:scan`; require Cross-platform CI +
  Service lifecycle green on that SHA.
- **WP3 — (optional) manual voice smoke:** ocx as injected base_url + ChatGPT
  login (or `openai-apikey`), start Codex App voice, confirm call-create 2xx +
  sideband frames. Capture as activation evidence.
- **WP4 — Release train:** pick next unused patch from live npm/git; run
  `scripts/release.ts` dev→preview→main per maintainer policy; verify tag /
  GitHub Release / npm dist-tag / fresh `ocx` runtime.
- **WP5 — Post-release hardening follow-up:** open a new unit for §3.3 items.

## 5. Attestation log

- **P (2026-07-24T04:31Z):** Live PR/CI/dev/npm state captured; #379 head
  `5e55fe5d` verified locally green on top of dev `9dc88f27` (typecheck exit 0,
  64/64 live+auth tests); wire contract matched against codex-cli `4462b9dee`;
  maintainer DEFER shown stale vs current head. No production code, push, or
  release performed. Awaiting user decision on §3 before B.

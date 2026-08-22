# 002 — risk matrix (main..dev, head 1af7a1e26)

Inventory source: `git log origin/main..origin/dev --oneline --no-merges` (109 commits, regenerated this audit).
Lane ownership rule satisfied: every commit assigned exactly one lane; counts sum to 109 (assertion at end).
Docs-only devlog commits inherit the lane of their subject unit; they carry no direct regression risk and are never ranked below.

## L1 — cursor adapter stack (32 commits)

Commits: 5eb56409c f3a7cd4a1 ab6a54e4d d6b8f8b5d ce15bf9ff 994e5ba87 6b889c36e 525568652 d79b1b444 a69d291fb b513a9142 fd0605868 b08ea715c fcc3f5c05 76166608f 56bff341a c9c818d13 569d0208c aedc223c8 3124cb13d 61ad6653e 4e82029f5 c688bace5 40d096475 a0b96ec43 e6a4a232c e332aa2b6 43ad5ae87 6097e60b4 2d703c89e 0e5924366 82d2f32ff

| Rank | Commit(s) | Why risky | Verify | Grade |
|---|---|---|---|---|
| 1 | 82d2f32ff + 0e5924366 2d703c89e c688bace5 43ad5ae87 6097e60b4 a0b96ec43 40d096475 (SelectedImage train) | New native vision path: base64 data: gating, JPEG validation, image-count guard ordering, prepared-byte reuse — many interacting guards; a regression silently drops or corrupts images on verified models | `bun test tests/cursor*selected*image* -i` (nearest existing SelectedImage coverage; else `bun test --isolate tests/cursor-vision*.test.ts`) | H |
| 2 | 525568652 (#2334 weighted credential router) | New failover/cooldown state machine; cooldown misclassification could rotate away healthy credentials or pin dead ones | focused router test file covering cooldown/failover transitions (`bun test --isolate tests/*credential-router*`) | H |
| 3 | b08ea715c (#2320) × f3a7cd4a1 (#2342 size prior) × 994e5ba87 (T04 watchdog handoff) | Three overlapping resource_exhausted/silent-stream classifiers — error may be mapped twice (overflow then 429) or watchdog fires after transport already settled | `bun test --isolate tests/cursor-error-classification*.test.ts` (covers bare-RE mapping and 429-class prior) | H |
| 4 | ce15bf9ff | OAuth polling terminal-status failure + discovery H2 pool shutdown at lifecycle exit — wrong teardown order leaks sockets or hangs exit | `bun test --isolate tests/cursor-oauth*.test.ts` | M |
| 5 | fd0605868 (#2321) + d79b1b444 (#2332) | HTTP/2 session lifetime: close-after-turnEnded vs pooled discovery sessions — held-open response stalls turn or pool reuse returns a closed session | `bun test --isolate tests/cursor-h2*.test.ts` | M |
| 6 | fcc3f5c05 + 76166608f + 56bff341a + c9c818d13 | Terminal-state machine rework (mixed terminals fail-closed, drained-terminal preservation, clean Connect without EOF) — ordering bugs produce silent turn loss | `bun test --isolate tests/cursor-terminal*.test.ts tests/cursor-connect*.test.ts` | M |
| 7 | ab6a54e4d | Display-alias folding inside textual pseudo tool-call markers can over-fold legitimate user text containing alias strings | `bun test --isolate tests/cursor-text-marker*.test.ts` | M |

## L2 — providers / registry + quota (17 commits)

Commits: c16d5ffde d83222154 698228e40 c142cc72c 64cd6e5a9 3e130d239 d23c3179f 4729b37d6 d884d2c4a 10b3dee58 dcda7fa59 d4023aedd 33e1c3e08 c13981b5a 1d7d8177a 057f93ea5 f87698c0d

| Rank | Commit(s) | Why risky | Verify | Grade |
|---|---|---|---|---|
| 1 | d23c3179f (Ox Alpha + DeepSeek vision preview catalog) | Registry-wide entries: wrong context/vision/pricing metadata propagates to routing, noVision curation, GUI cost estimates | `bun test --isolate tests/model-catalog*.test.ts` (or nearest registry contract test) | H |
| 2 | dcda7fa59 + 10b3dee58 (GLM coding-plan quota) | Window-matching rewrite affects legacy fallback gate — mis-window reports wrong remaining quota and could trigger false exhaustion routing | `bun test --isolate tests/quota-zai*.test.ts` (fixtures pinned in 4729b37d6) | H |
| 3 | 698228e40 (#2296 subagent preview quota scope) | Scope derived from route model — wrong derivation double-counts or bypasses subagent quota | `bun test --isolate tests/subagent-quota-scope*.test.ts` | M |
| 4 | f87698c0d + 1d7d8177a (xAI Priority Processing + B2 pricing) | Pricing-tier enablement gated on transport type; wrong gate bills priority rates on key-auth-less transports or misprices | `bun test --isolate tests/xai-pricing*.test.ts` | M |
| 5 | 64cd6e5a9 (xAI web-search tool normalize) | Tool-shape rewriting in request path — malformed normalize breaks every xAI search-enabled request | `bun test --isolate tests/xai-web-search*.test.ts` | M |

## L3 — release surface (11 commits)

Commits: f52de33f8 08bd08641 2cdfba24d aea77b84c 7317dde30 71598fa45 4c7b3ceb8 25b0c11a9 7a6d9c23f 59d6367d4 ed727d0e5

| Rank | Commit(s) | Why risky | Verify | Grade |
|---|---|---|---|---|
| 1 | ed727d0e5 + 59d6367d4 + 25b0c11a9 (#2290 deploy-key push) | Release automation now authenticates pushes via dedicated deploy key through GIT_SSH_COMMAND — token handling, quoting, and target derivation are release-blocker surface per AGENTS.md | `bun test --isolate tests/release-deploy-key*.test.ts` (plus targeted `bun x tsc --noEmit scripts/release.ts` if no dedicated file) | H |
| 2 | 2cdfba24d (#2294) + 4c7b3ceb8 + 71598fa45 (scp-host rejection) | Remote-string parsing that rejects credential-shaped scp hosts — over-rejection breaks legitimate remotes; under-rejection leaks credentials into logs/errors | `bun test --isolate tests/release-ssh-host*.test.ts` (covers log-bypass cases from 71598fa45) | H |
| 3 | 7a6d9c23f (push target from origin) | Deriving push target from origin instead of hardcoding — wrong remote parse pushes a version bump to an unintended host | same SSH-target test file as rank 2 | M |
| 4 | 7317dde30 (merge-train roadmap docs) | Planning artifact only — risk is process drift, not runtime | none (docs) | L |

### SECURITY REVIEW — L3 (required per MAINTAINERS.md / AGENTS.md)

Scope: #2290 deploy-key push path, #2294 scp-host rejection, workflow edits in range.

- **#2290 deploy-key push** (ed727d0e5, 59d6367d4, 7a6d9c23f, 25b0c11a9) — **pass.** Token handling: key material stays in GIT_SSH_COMMAND env, not argv/logs after 59d6367d4 quoting; three review findings fixed in 25b0c11a9 and the blocker-fix round recorded (08bd08641, re-verdict pass). Push target now derived from origin (7a6d9c23f), eliminating the hardcoded-remote drift. No mutable third-party action refs introduced. Residual note (P2): confirm the deploy key is least-scope (single-repo write) in host config — outside code audit reach. Pointer: `scripts/release.ts` (deploy-key push section).
- **#2294 scp-host rejection** (2cdfba24d, 4c7b3ceb8, 71598fa45) — **pass.** Rejects credential-bearing scp-like hosts and colon-bearing userinfo before any spawn; log-bypass avenues closed by 71598fa45 tests. Secret-exposure check: rejection errors must render the sanitized host only — covered by the bypass tests; no raw remote echoed. Blocker found in review was fixed pre-merge (08bd08641 re-verdict pass).
- **Workflow edits** (90eabcc42 Bun canary qualification, a0fa018e7 version sourcing from package.json, 8a3d43552 hardening-test shape update) — **pass.** No new secrets, no pull_request_target expansion, no mutable third-party action refs added (canary channel is a runtime download, not an action ref; its integrity rests on Bun's release artifacts — P2 note: pin/checksum if this becomes a supply-chain concern). Permissions scope unchanged.

Verdict summary: all three security-sensitive change sets **pass**; no needs-fix items. Findings above gate GO only via the two P2 operational notes.

## L4 — GUI/dashboard + management API (5 commits)

Commits: a228ed741 362377a03 a211e6d9e 3ff19c33e d887a4f2d

| Rank | Commit(s) | Why risky | Verify | Grade |
|---|---|---|---|---|
| 1 | 3ff19c33e (GUI/CLI routed vision surfaces + GET verbatim) | Management GET must report the routed describer exactly — parity break between registry state and dashboard display misleads operators | `bun test --isolate tests/vision-routed-reporting*.test.ts` (pinned by 362377a03) | M |
| 2 | d887a4f2d (estimated cost labels translation) | Label i18n keyed off catalog entries changed in L2 — mismatch shows raw keys or wrong currency figures | `bun run lint:gui` + focused GUI i18n test if present | L |

## L5 — runtime / CI (21 commits)

Commits: 5bbca70ab 7957756ea 174f03b60 d846ad4e0 7f00202d4 2df92a270 948fb5db1 6c33ea5dd 4430742f6 27764f342 293276e0d 6889825bf 68137e200 876ebf320 d9ff528f9 8a3d43552 4cc735344 90eabcc42 d3ec5abd1 1d76525eb a0fa018e7

| Rank | Commit(s) | Why risky | Verify | Grade |
|---|---|---|---|---|
| 1 | 27764f342 (Bun 1.4 stable bump, canary retired) + a0fa018e7 (version from package.json) | Runtime version bump touches every subsystem; TOML/datetime/PATH behaviors differ across Bun versions (see 6889825bf, d9ff528f9, 68137e200 mitigations) | `bun run test` (full suite — shared-runtime change) | H |
| 2 | 2df92a270 + 948fb5db1 (Windows service install state) | Fail-closed on unknown installation state + restart-without-reregister — wrong state machine bricks existing installs on upgrade | `bun test --isolate tests/service-install*.test.ts` (Windows-skipped shards verified on a Windows CI run) | H |
| 3 | 4430742f6 (Windows desktop full-restart helper) | Script kills/relaunches desktop processes — overly broad match kills unrelated processes | manual dry-run review of script + `zsh -n`-equivalent syntax check | M |
| 4 | 90eabcc42 + 8a3d43552 (CI canary qualification + workflow-hardening test shape) | CI shape change invalidates the hardening test's assumptions; silent skip hides regressions | `bun test --isolate tests/workflow-hardening*.test.ts` | M |

## L6 — responses-core + client adapters (23 commits)

Commits: c836ffbff 3b18d288b bc6d6b516 0fb80bdeb c7f341a80 65c0fd362 ec32a8d52 3bbe4e411 584a3e3e5 0e5a43459 72df5e0de 316190447 21aec549d 1d7099328 6d5f0cf2c e8c62a90d 4fbfb27d1 398b7ade4 2785aa29d 88ffe3272 df16e0a78 b31f3dbed 6c748663e

| Rank | Commit(s) | Why risky | Verify | Grade |
|---|---|---|---|---|
| 1 | bc6d6b516 (#2281 prompt_cache_key normalization) | anthropicSessionKeyFromParts normalization sits on every Claude Code request — bad split leaks or mangles session keys and breaks cache affinity | `bun test --isolate tests/responses-prompt-cache-key*.test.ts` | H |
| 2 | df16e0a78 + 88ffe3272 (apply_patch lowering + compaction-body-last ordering) | Request-body assembly reorder: lowering custom tools AND building compaction last interact — a rebuilt body that drops lowered tools or stale compaction sends malformed upstream requests | `bun test --isolate tests/responses-apply-patch*.test.ts tests/responses-compaction*.test.ts` | H |
| 3 | 6c748663e + b31f3dbed (thought-signature call_id replay) | Replay scope change alters what Claude Code sees mid-conversation; too-broad replay duplicates signatures, too-narrow drops them and upstream rejects | `bun test --isolate tests/thought-signature*.test.ts` | M |
| 4 | 316190447 + 21aec549d (routed describe executor, loopback self-fetch) | Server-side self-fetch creates a request path back into the proxy — deadlock/gate-bypass risk if loopback auth or gates are mishandled | `bun test --isolate tests/vision-describe-executor*.test.ts` | M |
| 5 | 0e5a43459 + 72df5e0de + 6d5f0cf2c (desktop pool affinity/reconnect binding + zero-byte remnant recovery) | Pool account binding and remnant recovery touch connection reuse — wrong binding splits sessions across accounts; recovery of zero-byte remnants may resurrect stale state | `bun test --isolate tests/desktop-pool*.test.ts` (+ coordinator remnant recovery test) | M |
| 6 | ec32a8d52 + 398b7ade4 + 2785aa29d + 4fbfb27d1 + e8c62a90d | Contract pins for custom-tool denial/passthrough, SSE namespace marker, Pi separator join, xAI fastwire — pins encode cross-version behavior; a drifted upstream fails these first | run each named test file with `bun test --isolate` | L |

## Lane-coverage assertion

Every commit in the regenerated 109-line inventory is assigned to exactly one lane. Counts: L1 = 32, L2 = 17, L3 = 11, L4 = 5, L5 = 21, L6 = 23. Sum = 109 ✓. No commit unassigned; no commit double-assigned.

> Provenance: matrix produced by a read-only ox-alpha classification lane; L3
> security verdicts rest on recorded review rounds (08bd08641, d83222154) plus
> commit evidence. WP4's L3 lane re-reads scripts/release.ts and workflows at
> head for file:line-grade confirmation before GO.


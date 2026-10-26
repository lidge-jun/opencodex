# 2.92.0 sweep — wave plan v1

> Written 2026-10-23 after the 2.91.0 release (main `83ec4f75a4`, npm/tag/GitHub release/updater verified).
> Baseline: `dev` at `299e8b68b2` (after #7511, #7510 and #7458). Planner only: no lane here merges; the
> sweep manager owns every merge. UI/UX changes are excluded from the sweep and get issues only.

## 1. Safety gates (unchanged)

- Combined-tree simulation on current `dev` before each merge.
- Rule C: a Windows-sensitive change (path filter plus markers `spawnSync`, `SIGTERM`, `SIGKILL`,
  `process.kill`, PowerShell, `.cmd`) needs a green `lane=all` run on the exact head.
- No unresolved blocking review threads; dev-red stop rule.
- Auth, credentials, dependency, GitHub Actions or release tooling changes carry a security summary in the
  PR description; this applies to every lane below.

## 2. Host placement

- Remote hosts (mac-studio, macmini-ts) are mid GOAT update, and remote launches from the coordinating
  MacBook are refused until the manager deploys the dev build there. **Start remote lanes only after that
  deploy.**
- Until then, run **at most two light lanes on the coordinating Mac** (its GOAT pressure is elevated):
  W1-B and W1-C first, then W1-E when one finishes.
- After the deploy: heavy and Windows-sensitive lanes on mac-studio (16 cores), light lanes on
  macmini-ts (10 cores). mini (win32) and lidge-ts have no opencodex checkout.
- Model: `anthropic/claude-opus-5-5` for auth and Windows-sensitive lanes;
  `anthropic2/claude-opus-5-5` for plain carries and test-only lanes.

## 3. Wave 1 (no file overlap between lanes)

| Lane | Scope | Size | Windows | Host | Branch |
|---|---|---|---|---|---|
| B | #7505 honor upstream no-retry verdict | S | – | this Mac | `sweep/w1-retry-noretry` |
| C | #7392 finish with `length` on Responses incomplete length; register test in both layout maps | S | – | this Mac | `sweep/w1-chat-length` |
| E | #7497 + #7498 SSE carry performance | S | – | this Mac, after B or C | `sweep/w1-sse-carry` |
| A | #7521 (#7517) → #7519 (#7512) → #7391 (#7390), sequential; #7519 and #7391 share `src/clients/config-export/qoder.ts`; #7391 must refuse an unowned legacy collision (review P2) | M | – | mac-studio | `sweep/w1-qoder` |
| D | #7457 (#7403); #7404 finite client-connect deadline; loopback-listener `freePort`→bind race (macOS EADDRINUSE); tests only | M | – | mac-studio | `sweep/w1-flaky-tests` |
| F | PowerShell effective-account SID lookup timeout at `src/codex/user-identity.ts:254` during service install | S | yes | mac-studio | `sweep/w1-win-sid-timeout` |
| G | Upstream catalog refresh (section 6) | M | – | mac-studio | `sweep/w1-upstream-oct` |

#7521 touches `structure/providers-and-adapters.md` and `docs-site/.../guides/providers.md`; #7471, #7444 and
#7445 touch the same files, so they wait for wave 2.

## 4. Wave 2 (after wave 1 merges)

| Lane | Scope | Notes |
|---|---|---|
| H | #7471 command-code credit refusal rotation | blocker withdrawn by reviewer |
| I | #7444 (#7440) Business Premium capacity weight | S |
| J | #7445 deprecate mimo-free → #7439 (#7438) Alibaba Token Plan | sequential: `entries-extended.ts`, `derive.ts`; endpoint change needs primary-source review |
| K | #7463 (#7456) fail unmet required tool completions | conflicting; `openai-chat.ts` after lane E |
| L | #7375 message phase inference | review P2 on terminal snapshot phases |
| M | #7450 + #7499 | share `src/codex/auth-api/account-list.ts` |
| N | #7459 Hermes conversation id | unblocked by #7511; can run beside wave 1 |
| O | #7425 `ocx sync` overwrites user edits in `config.toml` | no PR; implement |
| P | #7442 (#7441) Antigravity family quota to JEV | open CHANGES_REQUESTED blocker; `core-combo.ts` |
| Q | Anthropic API version `2026-10-21` (sampling parameters removed) | `src/adapters/anthropic.ts` |
| – | #7523 replay state isolation by caller | after P (`core-combo.ts`) |
| R | #7516 Qoder CN image input, allowed only for qoderclicn >= 1.1.70 (decision §9) | after lane A: shares `src/adapters/qoder/adapter.ts` with #7521; version probe must fail closed |
| S | #7500 route an Antigravity model only to accounts whose discovered roster lists it; clear error when none is eligible (decision §9) | `src/oauth/generic-account-failover.ts`, `src/providers/antigravity-account-roster.ts`; `anthropic/` |
| T | #7525 opt-in JEV per-session pin, narrower than #6665 (decision §9) | after P: `src/combos/jev-dispatch.ts`, `src/cli/combo.ts`; default off, reuse JEV dispatch/decision owners |
| U | #7366 document how `spawn_agent` fills slots when fewer than five models are featured (decision §9) | docs only (`guides/sub-agent-surface.md`); the dashboard hint is UI and stays on #7366 for the UI track |

## 5. Wave 3

W3: contributor PR review queue, managed separately.

## 6. Upstream provider changes (lane G / Q input)

- Anthropic Claude Haiku 5.5 (`claude-haiku-5-5`, released 2026-10-07): 1M context, 128k output,
  adaptive thinking and `effort`; sampling parameters must be omitted.
- Anthropic API version `2026-10-21`: breaking removal of sampling parameters from the Messages API.
- Gemini: `gemini-omni-flash-preview` shut down 2026-10-22 (replacement `gemini-omni-1.1-flash`);
  `deep-research-pro-preview-12-2025` on 2026-10-23; Vertex retired `gemini-2.5-pro` on 2026-10-20,
  with no Developer API date yet, so change Vertex presets only.
- Codex CLI 0.163.0 stable (2026-10-15), 0.164.0-alpha.9 prerelease: app-server and catalog smoke.
- xAI, DeepSeek, Kimi and Qwen were not checked; lane G verifies them against official docs.

## 7. Lane brief template

Remote lanes cannot be steered after launch (`goat_thread_send` to a remote thread is refused by the
permission ceiling), so a remote brief must be self-contained: every decision pre-made, a stop rule for
ambiguity (decide, record the decision in the PR description, continue), and a final report of PR URL, head
SHA, verification commands with totals, and anything `NOT RUN`.

> `$codexclaw:cxc-loop` (HOTL, scoped) + `$codexclaw:cxc-dev`. Lane <ID>: <PRs/issues>. Base: latest
> `origin/dev`, branch <branch>. Carrying a contributor PR keeps a `Co-authored-by` trailer. Resolve every
> CHANGES_REQUESTED, CodeRabbit and Codex thread, recording reasons for rejected findings. Register new tests
> in both `layout.json` (or its shard) and a `test-layout-expected*.json` shard; never grow a file at its
> size cap. Verify with focused tests, `bun run test:changed`, `typecheck`, `privacy:scan` and
> `structure:check`. Windows-sensitive changes need exact-head `lane=all` green. Auth, credentials,
> dependency, GitHub Actions or release tooling changes carry a security summary. Open a templated PR against `dev`, do not merge, and report
> the head SHA and check state to the manager. File issues for UI changes instead of making them.

## 8. Close proposals

Done by the manager: #7448 (fixed by #7449), #7436 (duplicate of #7433), #7437 (duplicate of #7434),
#7533 (superseded by the opt-in #7534).

## 9. Needs a product decision

Approved by the supervisor as recommended on 2026-10-23; a later user decision overrides.

| Item | Decision |
|---|---|
| #7533 vs #7534 Flex tier | keep the opt-in variant (#7534) |
| #7516 Qoder CN image input | allow, gated on qoderclicn >= 1.1.70 |
| #7500 Antigravity paid vs trial Pro | route by discovered model roster; clear error when no account is eligible |
| #7525 JEV per-session pin | opt-in, narrower than #6665 |
| #7366 `spawn_agent` slot fill | document and hint first; policy change later |

## 10. Deferred and excluded

- Waiting for reporter data: #7443, #7382.
- Upstream tracking only: #7524 (desktop capability gate; no repository change between 2.86.0 and 2.90.0).
- UI/UX, excluded: #4649, #7529, #7318, #7275, #7292, #7347, #7526, #7368, #7406.
- Large drafts parked for this sweep: #7531, #7485, #7344, #7308, #7270, #7267, #7311, #7428, #7376,
  #7234, #7325, #7374, #7370.
- Already in flight: #7527, #7528.

## 11. State at plan revision (2026-10-23)

- Merged: #7511 `8d6e124dd8`, #7510 `943f63ffc1`, #7458 `299e8b68b2`; #7520 and #7509 on exact-head `lane=all`.
- Running on the coordinating Mac: W1-B, W1-C.
- W1-A was started on mac-studio, then interrupted to honor the remote-after-deploy rule: branch
  `sweep/w1-qoder` holds the #7521 and #7519 cherry-picks, unpushed, stopped mid-conflict on #7391.
  Resume in the same worktree after the deploy.


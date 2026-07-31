# Dev/Cursor History Split Plan

## Objective
Rewrite local/remote `dev` so it contains only non-Cursor work from `main..origin/dev`, while Cursor work remains on `cursor-provider-stack` and the original mixed history remains on `dev-with-cursor-backup`.

## Current Branch Facts
- `origin/dev` currently contains 85 commits over `origin/main`.
- Title classification: 55 Cursor-related, 30 non-Cursor.
- `origin/cursor-provider-stack` already contains the isolated Cursor stack.
- `origin/dev-with-cursor-backup` preserves the original mixed dev history.

## Non-Cursor Commits To Keep On dev
- `349d6c9` [agent] docs: devlog 320 bundled-bun npm install plan + research
- `8bda65d` [agent] feat: bundle Bun so npm install works without separate Bun (320 P1+P2)
- `c5b4091` [agent] feat: update advisory + npm-global CI + docs for bundled bun (320 P3+P4)
- `e81497d` [agent] chore: sync bun.lock with bundled bun dependency (320)
- `09553b4` [agent] fix: detect bun placeholder stub by size, not just 0-byte (320)
- `ba67606` fix: use os.tmpdir() instead of hardcoded /tmp in auth context tests
- `699e5a7` fix: use atomicWriteFile for Codex config/profile writes
- `c41cf23` [agent] docs: finish Phase 4 — translated READMEs + docs-site (320)
- `e5a79a1` [agent] test: unit-test bun-runtime size gate + resolution (320)
- `3d04c9f` [agent] docs: register bundled-bun in structure SOT + 320 verification doc
- `d83f10e` fix: add process.on(exit) handler for Windows SIGTERM gap
- `14c2a55` fix: add windowsHide to detached proxy spawns
- `ee32fc0` ci: add macOS to CI matrix and service lifecycle tests
- `87d583f` docs(devlog): 140 phased execution roadmap — all remaining provider ports
- `ea24092` [agent] docs: devlog 360 — plan PR #37 router effort hydration → dev
- `2bed390` fix(router): hydrate registry reasoning effort defaults for stale persisted provider configs
- `dff52ab` [agent] fix(router): review nits for PR #37 effort hydration (360)
- `8090e9f` [agent] docs: devlog 360 verification — PR #37 integrated + closed
- `f1cdd7d` feat: add crash-safe config transaction journal
- `3a35e68` feat: integrate config journal into inject/start/ensure lifecycle
- `8ae90e3` test: add crash-safe journal tests (subprocess pattern)
- `9c1fc92` chore(bin): track dist command symlinks
- `8a242f4` fix(server): explain missing dashboard root
- `1418693` fix(cli): avoid persisting fallback port
- `90bfc40` fix(codex-auth): allow team reset credit tickets
- `47eadea` fix(codex-auth): preserve reset ticket badge styling
- `2b972e9` fix(codex-auth): keep tickets beside next-session badge
- `da12d6e` fix(codex-auth): stop identity-based duplicate blocking
- `c424dfa` fix(codex-auth): detect duplicate refresh grants
- `2d6e5fb` fix(codex-auth): scope duplicate checks by plan bucket

## Cursor Commits To Exclude From dev
- `2dc12f2` docs(devlog): 350 — Cursor provider add plan (grounded in jawcode gjc)
- `b0f9c77` docs(devlog): rename 140 → 400 remaining-provider-ports (cursor 350 prioritized first)
- `92c44a0` docs(devlog): 350 cursor — implementation-ready impl band (10-14) + Backend audit fixes
- `20195fa` docs(devlog): reset cursor provider roadmap evidence
- `2a310e6` feat(cursor): add safe runTurn scaffold
- `9c018ca` feat(cursor): add connect framing helpers
- `1e6b077` feat(cursor): add disabled oauth shell
- `30dba88` docs(devlog): align cursor phase 2 roadmap
- `19e3e99` docs(devlog): plan cursor provider connection phases
- `4dfe387` feat(cursor): add mocked runTurn transport
- `c1f204e` docs(devlog): plan cursor registry exposure
- `4a9f31e` feat(cursor): expose safe static provider metadata
- `9d9e694` docs(devlog): plan cursor live smoke credential gate
- `ffdb19a` test(cursor): add live smoke credential gate
- `3c7d311` feat(cursor): expose safe dashboard preset
- `6f647dc` feat(cursor): expand static model catalog
- `c25d3b9` fix(cursor): show complete static catalog
- `33e04ba` fix(cursor): preserve native codex catalog rows
- `43531ca` feat(cursor): enable live transport bridge
- `dcef33b` feat(cursor): complete native exec bridge coverage
- `b2d272f` docs(cursor): verify installed ocx entrypoint
- `698bbba` fix(router): prefer OpenAI for bare GPT models
- `d9d2c61` fix(cursor): preserve split connect frames
- `14d4bc3` docs(cursor): record runtime safe verification
- `015fe97` docs(devlog): 350.98 RCA — cursor EndStreamResponse misclassified as fatal error
- `c1698fb` docs(devlog): 350.99 plan — cursor end-stream success/error discrimination
- `cbe9341` fix(cursor): treat empty Connect end-stream frame as success, not error
- `9b149c2` docs(devlog): 350.100 plan — cursor OAuth standalone, WP16 core flow + slice map
- `703da18` feat(oauth): implement standalone Cursor OAuth PKCE flow
- `e256b48` docs(devlog): 350.101 plan — cursor OAuth WP17 registry + CLI
- `b248a98` feat(oauth): register Cursor as a standalone OAuth provider
- `d2cb95c` docs(devlog): 350.102 — cursor OAuth gap closed + readiness
- `35dda72` docs(devlog): 350.103 plan — OAuth login status in ocx status (WP19)
- `d4d0453` feat(cli): show OAuth login status (incl cursor) in ocx status
- `81713ee` docs(devlog): 350.104 plan — token-precedence regression guard (WP20)
- `be03142` test(cursor): guard token precedence (managed apiKey beats forwarded header)
- `5968f5b` docs(devlog): 350.105 RCA — cursor not_found is model-name effort suffix + blob handshake
- `8ca8f9c` docs(devlog): 350.106 — cursor blob handshake live success (WP23)
- `8dd97a9` fix(cursor): send rootPromptMessagesJson as blob IDs (fixes 'Blob not found')
- `6177ecb` docs(devlog): 350.107 — cursor reasoning-effort -> model-id suffix (WP24)
- `e0d6312` fix(cursor): map reasoning effort into the model-id suffix (fixes bare-model not_found)
- `3372adf` docs(devlog): 350.108 — cursor per-model reasoning-effort tiers (WP25)
- `c637f4d` fix(cursor): map reasoning effort per-model to the real tier ceiling
- `15c90dc` fix(cursor): align claude catalog ids with the real Cursor names + advertise effort
- `485bcc9` fix(cursor): de-speculate gpt/grok/gemini catalog to real Cursor bases
- `0c351dc` docs(devlog): 350.109 — cursor catalog realigned to real ids + account-availability caveat
- `1f81256` docs(devlog): 350.110 — live GetUsableModels framing solved + account-accurate catalog
- `a0138c3` feat(cursor): live GetUsableModels — filter the catalog to the account's models
- `c594c42` fix(cursor): correct gpt-5.1-codex base to gpt-5.1-codex-max/-mini
- `ac8f035` feat(cursor): real MCP tool executor — make MCP tool-calls work end-to-end
- `a935698` test(cursor): strengthen MCP executor coverage from independent review
- `74c0335` feat(cursor): honest computer-use / record-screen executor hooks
- `2edfe4e` test(cursor): cover recordScreen dispatcher-boundary throw containment
- `713e7cf` feat(cursor/mcp): pass real MCP image bytes through + live stdio integration test
- `62a41aa` fix(cursor/mcp): listMcpResources returns honest error when no executor is wired

## Implementation Plan
1. Create/refresh a safety branch before rewriting dev: `dev-with-cursor-backup` already exists on origin.
2. Create a temporary branch from `origin/main`.
3. Cherry-pick the 30 non-Cursor commits in original order.
4. Run focused verification (`bun x tsc --noEmit`; targeted tests for non-Cursor areas if needed).
5. Move `dev` to the rebuilt branch and force-with-lease push `dev`, because removing already-pushed Cursor commits from dev requires history rewrite.
6. Verify `origin/dev` no longer contains Cursor-title commits and still contains the 30 non-Cursor commits.

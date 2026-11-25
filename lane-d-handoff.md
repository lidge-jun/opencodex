# Lane D handoff (OpenCodex maintenance batch, 2026-11-25)

Worktree: /home/ubuntu/.goat/worktrees/opencodex/lane-d-conflicts-issues-62ea3d8420cca517
origin/dev verified at: 9e0e298ef9720cfeaa1209f090a68e4d1965d2a1

Lane D could not write to GitHub from host pen-cc-06: `gh` and git authenticate as `cursor[bot]`
(installation token without write). Push, PR comments, and closes all returned 403, and GOAT
`pull_request.comment`/`close` returned "You need write access". **Nothing was posted, closed, or pushed.**
The coordinator accepted the decisions below and moved execution to a host with write access.

## Local branches

| Branch | Head | Content |
| --- | --- | --- |
| `lane/d-8935-carry` | `6afa9fa9c120e61c6df842f0d070e737e6614e99` | #8935 head `3d29c8cf95` + merge of origin/dev `9e0e298ef9`. Conflicts were preset counts only: took dev's text and recounted to **113 total / 91 key-based** in all locale quickstarts, provider guides, the EN/ES API-key catalogs and `structure/ops/docs-and-release.md`; test-layout fixture keeps both `abliteratedllm` and `aimlapi`; `structure/INDEX.md` regenerated with `bun run structure:index`. The carry commits on this branch already have Co-authored-by trailers for Hugo, Stan and Vito Bush. Push it to `codex/aimlapi-preset` (a fast-forward of the PR head, base-repo branch). |
| `lane/d-conflicts-issues` | (this commit) | this handoff file only; do not push to dev |

Verification on `lane/d-8935-carry` (fresh, this host):

- `bun test tests/ci-workflows/docs-provider-preset-counts.test.ts tests/providers/aimlapi-provider.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/providers/provider-registry-parity.test.ts`: 132 pass, 0 fail
- `bun run typecheck`: no type errors in 2,692 files
- `bun run structure:check`: passed

NOT RUN: `bun run test:changed`, full `bun run test`, docs-site build, the Terra security review of #8935, and PR CI on a pushed head.

## Triage table

| Item | Decision | Reason |
| --- | --- | --- |
| #8935 AI/ML API (carry) | **Keep.** Push `lane/d-8935-carry`, Terra security review, **report, do not merge** | Owner accepted it on 2026-11-19. It touches `src/oauth/index.ts` (discovery header stripping via `withoutRegistryStaticHeaderCopies`), which is security-boundary scope |
| #8919 AI/ML API (Hugo) | **Close as superseded by #8935** | Owner decision; the carry has Co-authored-by credit |
| #7904 AI/ML API (Vito) | **Close as superseded by #8935** | Same |
| #8339 TRAE CN ACP | Leave open | Owner evidence hold (2026-11-19); Ingwannu's change request is still open. No new comment needed |
| #8189 codebuddy-ai | Leave open | Owner evidence hold (2026-11-19); must also build on #8684. No new comment needed |
| #8843 replay refusals (8k lines) | Leave open; ask the author | Final review at `88c2224d1c` was CODE REQUEST_CHANGES / SECURITY BLOCK with reproduced gaps; it now conflicts with dev. Carrying 8k lines of retry and credential-rotation logic is outside a cleanup lane, and it is security scope anyway |
| #8908 opendesign-go preset | Needs an owner decision, then merge dev (maintainerCanModify=true) | It adds a canonical preset, which is a new credential destination, and MAINTAINERS.md requires canonical-preset evidence and owner acceptance. No owner decision is recorded on the PR |
| #8777 Antigravity interactive ACP | Ask the author; owner scope decision | Draft, 0/4 readiness boxes, conflicting, and no maintainer review yet. It adds a new CLI surface that spawns `agy` |
| #8706 Spanish dashboard + README | Carry the fix on the contributor branch (maintainerCanModify=true): merge dev, add the missing `gui/src/i18n/es.ts` keys, Terra review, then merge with a screenshot | The only blocker in the 2026-11-16 maintainer review was `es.ts` drift after #8754 (`satisfies Record<TKey,string>`). Not started here |
| #8378 Spanish polish | Closes with #8706 | #8706 body says `Closes #8378` |
| #9103 request-history index | Leave to the contributor | shu-chen-dot-ca claimed it at 2026-11-25 00:37 UTC. Pointer: `src/routing/history/schema.ts:68`, `HISTORY_SCHEMA_VERSION = 2` (line 11) |
| #8986 Cursor Grok "continue" | Leave open | Maintainer root-cause comment was posted 2026-11-20; the held-run design needs a decision |
| #9045 `ocx opencode` with a warm service | Findings comment; maintainer chooses the fix | The cause is confirmed in source: `buildOpencodeEnv` puts `OPENCODE_CONFIG_CONTENT` only in the client env (`src/cli/opencode.ts:594-598`), and the success line prints unconditionally (`:682`). The options (auto `--standalone`, fail loudly, or a static managed block) are product choices |
| #9096 shadow intercept follows the conversation | Findings comment; needs design | Enhancement. Target availability lives in `src/server/responses/shadow-target-availability.ts` |
| #8928 Astra → Sol switch | Ask the reporter for info | Intermittent, with no logs or config. Needs a request-log export of the Astra/Sol pair and the routing profile |
| #8934 WebSocket cooldown | Findings comment; needs design | Enhancement. The provider-wide `upstreamWebsocket=false` workaround exists |
| #8953 per-model V1/V2 mode | Findings comment; needs design | The plaintext compiler applies only to the canonical ChatGPT forward route (`src/adapters/routed-agent-messages.ts`), so a third-party `openai-responses` parent keeps encrypted tasks (`unreadable_encrypted_agent_task`, `src/server/responses/core-errors.ts`) |

## Drafted comments

**#8919:** Closing as superseded by #8935, which carries this change onto current dev with Co-authored-by credit for @hugoaimlapi, Stan and @vito-bush (owner decision recorded above).

**#7904:** Closing as superseded by #8935, which carries the AI/ML API preset onto current dev with Co-authored-by credit for @vito-bush, Stan and @hugoaimlapi.

**#8935 (after push):** Merged current dev to resolve the preset-count conflicts. Counts are recounted from the registry as it stands now: 113 total, 91 key-based. The test-layout fixture keeps both new provider tests, and `structure/INDEX.md` was regenerated. Focused preset, layout and registry tests pass (132/0), and typecheck and structure:check pass. This PR still touches `src/oauth/index.ts`, so it waits on the security review before it can be integrated.

**#8339 / #8189:** no comment; the 2026-11-19 hold comment is current.

**#9103:** no comment; a contributor claimed it. If no PR appears in a few days: "Pointer for whoever picks this up: the index lives in `src/routing/history/schema.ts` (`idx_requests_api_key`). On a 12 GB history, a plain `CREATE INDEX IF NOT EXISTS` at open would block startup for about 30 s, so the migration path (version bump with a rebuild, or a background index build) is the part that needs care."

**#8986:** no comment; the maintainer analysis from 2026-11-20 stands.

**#8843:** @luvs01 This now conflicts with dev, and the last review at `88c2224d1c` left reproduced refusal and veto gaps open (listed in the 2026-11-19 status comment). Are you still working on it? If so, please merge current dev and address those findings, and we'll re-review. If not, say so and we'll decide whether to carry a narrower slice.

**#8908:** @bzhu92238-hub Thanks. A new built-in preset is a new credential destination, so before we refresh and merge this we need the canonical-preset evidence from MAINTAINERS.md: who operates opendesign-go and under which terms, a named maintenance owner, and a dated live run on the current head. The branch also conflicts with dev now. The preset counts will need a recount from the registry after the merge.

**#8777:** @srx5216 Thanks for the detailed work. Before review, this needs a scope decision from the owner, since it adds a new `ocx antigravity` command surface that drives the official `agy` binary. Meanwhile the branch conflicts with dev. Please merge current dev and complete the readiness checklist once it's green.

**#8706:** (maintainer, after pushing the fix) Merged current dev into your branch and added the `es.ts` keys introduced since the last review, so the locale catalog typechecks again. Thanks for the translation work.

**#9045:** Confirmed from source. `ocx opencode` delivers its provider blocks only through `OPENCODE_CONFIG_CONTENT` in the environment of the spawned client (`src/cli/opencode.ts`, `buildOpencodeEnv`), and it prints the success line unconditionally. A background service that is already running never sees that variable. The three fixes in the report (auto `--standalone` when a service is warm, refusing to claim success, or a managed static block) are product choices, so this waits on a maintainer decision. Until then, `--standalone` or `ocx export --client opencode` are the workarounds.

**#9096:** Thanks. Today the intercept takes one fixed target, and target availability is enforced in `src/server/responses/shadow-target-availability.ts` (the 409 `intercept_target_unavailable` path from #5618). Following the conversation's model needs the helper call to carry, or the proxy to infer, which conversation it belongs to. That is a design question, so this stays an enhancement for now.

**#8928:** Thanks for the report. To trace this we need the two adjacent requests (the last Astra one and the first Sol one) from Logs & Debug, exported with secrets removed, plus your redacted routing configuration (profiles, combos, any fallback/reserve model, and the account pool settings). A silent switch that keeps the same effort usually comes from a fallback or reserve route, and the log rows show which route served each request.

**#8934:** Thanks for the detailed observation. The provider-wide `providers.openai.upstreamWebsocket=false` switch remains the supported workaround. A cooldown per route needs a design for scope and expiry, so this stays open as an enhancement.

**#8953:** This is expected today. The V2 plaintext compiler only rewrites tasks on the canonical ChatGPT forward route, so a third-party `openai-responses` parent such as `ZQ/gpt-6.2-sol` still emits encrypted worker tasks, which a routed child refuses with `unreadable_encrypted_agent_task`. A collaboration mode per model is a reasonable request and needs a design, so this stays an enhancement.

## What remains

1. Push `lane/d-8935-carry` → `codex/aimlapi-preset`, post the #8935 comment, run the Terra security review, and report it (do not merge).
2. Close #8919 and #7904 with the comments above.
3. #8706: merge dev, fill in `es.ts`, Terra review, merge through the maintainer-integration path; this closes #8378.
4. Post the comments for #8843, #8908, #8777, #9045, #9096, #8928, #8934 and #8953. Owner decisions are needed for #8908, #8777 and #9045.


# 261002 oocheol CLI batch carry — plan (wp1)

Loop-spec: class C2 (eight small, independently reviewed CLI fixes plus one behavioral amendment). Mode HOTL lane, single work-phase wp1.
Tool/credential scope: local git, bun, gh (push this branch, open one PR; no merge, no comments on other PRs).
Write scope: src/cli/{capabilities-command,runtime-api,config-command,init,alias,observe,route-policy}.ts, src/lib/errors.ts, the eight new test files, docs-site reference/cli.md, reference/cli/agents.md, reference/cli/lifecycle.md (en, ko), structure/{runtime,config,dashboard-and-usage}.md and structure/transports/responses-wire-shapes.md (sentences the PRs touch), scripts/test-layout/layout.json, tests/fixtures/test-layout-expected.json.
Budget: one lane session; wall-clock bound ~3h including one hosted CI run.
Base: origin/dev a300b57c81. Branch: codex/carry-oocheol-cli-batch.

## Architect consultation
Architect handle 01a0fc2f-188e-7632-8bd6-e5cee64ec6ab (gpt-6.1-sol, read-only). Decisions D1–D7 all ACCEPTED:
- D1 eight commits in order 6429, 6431, 6432, 6433, 6434, 6435, 6437, 6438; author 정우철 <oocheol@naver.com>, Co-authored-by trailer.
- D2 port retry: keep parseInitPort; do/while around prompt.ask at src/cli/init.ts:197; stderr "Proxy port must be a whole decimal number from 1 to 65535. Please try again."; no exit code; no retry cap; EOF/SIGINT keep InitCancelledError (exit 1/130).
- D3 wizard test: invalid 10100oops then valid 10101, exit 0, config.json port 10101, two port prompts, consumed-output cursor; add invalid→EOF case (exit 1, no config). SIGINT case: invalid→SIGINT while retry prompt pending, exit 130, no config (skip Windows).
- D4 preserve exit contracts (64/4 capabilities; 2/4/1 shared); init port stays stricter than shared integer options.
- D5 docs: keep every appended section once in en+ko; reword #6433 docs/structure to "re-prompts".
- D6 no baseline caps on touched files; structure docs keep line counts (append in-line); run skill:surface:check without regeneration.
- D7 reject abort and retry caps.

## File change map
| Commit | Files | Change |
|---|---|---|
| #6429 | capabilities-command.ts, tests/cli/cli-capabilities-arguments.test.ts, docs cli.md en/ko, structure/runtime.md, layout maps | as source |
| #6431 | runtime-api.ts, tests/cli/cli-integer-options.test.ts, docs cli.md en/ko, structure/config.md, layout maps | as source |
| #6432 | config-command.ts, tests/cli/cli-config-bom.test.ts, docs, structure/config.md, layout | as source |
| #6433 | init.ts, tests/cli/cli-init-port.test.ts, lifecycle.md en/ko, structure/runtime.md, layout | source + D2/D3 amendment, docs "re-prompts" |
| #6434 | alias.ts, tests/cli/cli-alias-json.test.ts, docs, structure/runtime.md, layout | as source |
| #6435 | observe.ts, tests/cli/cli-logs-request-id.test.ts, agents.md en/ko, structure/dashboard-and-usage.md, layout | as source |
| #6437 | route-policy.ts, tests/cli/cli-route-policy-not-found.test.ts, agents.md, structure/runtime.md, layout | as source |
| #6438 | src/lib/errors.ts, tests/lib/upstream-error-message-fallback.test.ts, agents.md, structure/transports/responses-wire-shapes.md, layout | as source |

Conflict resolution (rehearsed with git apply --3way): docs cli.md (6431/6432/6434 after 6429), agents.md (6437/6438 after 6435), layout maps (6433). Resolve by keeping all sections in commit order and all layout entries.

## Scope
IN: the eight behaviors, #6433 amendment, docs/structure wording. OUT: #6436, src/lib/sse-decoder.ts, merge, other PRs.

## Acceptance (activation scenarios)
- c-1 each commit carries its regression test; activation: bun test of each new test file passes at final head.
- c-2 invalid port path: wizard subprocess answers 10100oops then 10101 → stderr contains "Please try again", exit 0, config.json.port 10101; invalid then EOF → exit 1, no config.json.
- c-3 rg counts each new heading exactly once in en and ko docs.
- c-4 verifiers (run at final head): bun run typecheck; bun test <8 new files> tests/service/init-eof.test.ts tests/test-layout*.test.ts; bun run test:changed; bun run structure:check; bun run skill:surface:check; bun run privacy:scan.
- c-5 push once; PR to dev with full template; one CI run green.

## SoT sync
structure/*.md sentences listed above (owned docs for touched src areas); no new src area.


## Reflection (same architect, revision 2)
Verdict MISALIGNED with two gaps, both FOLDED:
1. D3 SIGINT: REQUIRED (not optional). tests/cli/cli-init-port.test.ts adds invalid→SIGINT while the retry prompt is pending (exit 130, no config), skipped on Windows like tests/service/init-eof.test.ts:225.
2. Ownership fan-out: C reviews every structure doc mapped to src/cli/ and src/lib/ (structure/INDEX.md:124,141) and updates only explanations the eight changes make stale (structure/AGENTS.md:49). structure:check is necessary but not sufficient.


## Audit round 1 (reviewer 01a0fc32-39d3-7aa0-82df-5c56d0ba5ae8, gpt-6.1-sol): GO-WITH-FIXES (blockers=2), both FOLDED
1. #6438 consumer effect (Medium): a blank primary error.message no longer hides response.error.message, so isEncryptedFunctionOutputRejection (src/server/responses/core-opaque-recovery.ts:109) and codexQuotaFailureMessage (src/server/responses/core-codex-account.ts:274) now see the fallback. This is the intended fix. FOLD: extend tests/lib/upstream-error-message-fallback.test.ts with consumer cases — blank primary + fallback rejection string → encrypted rejection true; blank primary + fallback quota text → quota message returned and classified as quota; blank primary + unrelated fallback → not quota; nonblank primary still wins over a conflicting fallback. relay.ts:266 code/type precedence uses its own candidate scan and is unchanged; one assertion that a blank primary message does not change the relay-selected code if cheaply reachable, else recorded as unaffected by inspection.
2. Docs validation (Medium): FOLD: C runs `cd docs-site && bun install --frozen-lockfile && bun run build` (docs-site/AGENTS.md:25-30); the PR also requires the exact-head "docs site build" CI job.
Main judgment: near-pass (both Medium blockers folded; no High/Critical).


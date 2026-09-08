# 000 — Code-mode host contract for routed models: plan

Revision 2 after audit round 1 (gpt-6-astra explorer, VERDICT: FAIL, 8 blockers). Synthesis and
dispositions are in the "Audit round 1" section at the end; the body below is the amended plan.

## Loop-spec

- Loop archetype: satisfy-spec repair (verifier-defined). No optimization loop.
- Trigger: xai/grok-4.6 retrospective (2026-09-07) on a routed native-Responses Codex session. The
  model hit Codex host contracts that OpenCodex neither states before the first call nor explains
  after the failure, then abandoned the right tools for shell heredocs and sleep loops.
- Goal: a routed non-OpenAI model in Codex code mode learns the host's argument shape and waiting
  protocol up front, and when it still trips, the exec result names the rule it broke.
- Non-goals: rewriting model JavaScript; new payload repair (`apply-patch-envelope.ts`,
  `code-mode-helper-compat.ts`, `bridge.ts`, `parser.ts` untouched); OpenAI/ChatGPT destinations
  or compaction requests; Lab; GUI; version bumps; annotation on Anthropic/Google/OpenAI-chat/
  command-code result paths (they have no exec-result seam today). No local test suite, typecheck,
  build, or install in this worktree (user instruction). Merge/release out of scope.
- Verifier: hosted `.github/workflows/ci.yml` on the exact head of each pushed work-phase (PR
  `pull_request` trigger; test shards 1-4 + `gates` typecheck/privacy). Local: NOT RUN.
- Stop condition: PR ready-for-review against `dev` with exact-head CI green and receipt bound.
- Memory artifact: this unit, the bound goalplan
  `.codexclaw/goalplans/code-mode-host-contract-for-routed-models-shared/`, and the PR body.
- Expected terminal outcomes: DONE (PR open, CI green); NOOP ruled out below; BLOCKED if
  GitHub/CI fails after retries; UNSAFE if a change would rewrite JavaScript or widen a fail-open
  write; NEEDS_HUMAN for merge.
- Escalation: main reclaims a slice after two distinct agents fail its packet; pushing a slice to
  a worker requires a P-phase amendment. Every dispatch uses `gpt-6-astra`, reasoning `high`.
- HOTL bounds: write scope is this worktree on `codex/code-mode-host-contract`; push of that branch
  and PR creation are authorized by the user; no token or wall-clock budget was set.

## Incident and live host evidence

Host strings were read from the installed Codex 0.153.2 binaries (`strings -n 8` on `codex` and
`codex-code-mode-host`) and then re-probed live from this session's own code-mode isolate:

| Probe (`tools.apply_patch` argument) | Host result |
|---|---|
| `{ input: "*** Begin Patch…" }` (object) | throws `tool \`apply_patch\` expects a string input` |
| `"*** Begin Patch ***\n…\n*** End Patch ***"` (decorated) | throws `apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'` |
| `"\n\n*** Begin Patch\n…"` (leading newlines) | ACCEPTED, file written |
| `"  *** Begin Patch\n…"` (indented) | ACCEPTED, file written |
| `"…*** End Patch\n\n"` (trailing newlines) | ACCEPTED |
| `import x from "y"` in the isolate | `Unsupported import in exec: <spec>` (host string; capital U) |

So the Grok report's "blank line before the template literal" was not itself the rejection; the
"first line" error fires for a decorated marker, a code fence, prose, or any non-marker first
token. The pre-call sentence and recovery hints below describe exactly that and do not claim the
host rejects surrounding whitespace.

The fourth contract has no error string: a shell `for i in 1..20; sleep 1` inside one
`exec_command` simply blocks the call, while the host's own protocol is to let the call return a
`session_id` and poll with `tools.write_stdin({session_id, chars: ""})`.

After the two apply_patch rejections the model stopped using apply_patch entirely — the pattern
`devlog/_fin/260813_260813-nudge-apply-patch-forbid/` recorded: once the tool feels broken, routed
models fall back to `python3`/`cat <<EOF` writes Codex cannot render as diffs.

## Existing mechanism (extended, not invented)

`src/adapters/exec-tool-result-normalize.ts` owns one pre-call/post-hoc pair
(`CODE_MODE_RESULT_ECHO_SENTENCE` / `EMPTY_EXEC_OUTPUT_MESSAGE`) in one file so wording cannot drift.
Pre-call consumers: `src/adapters/tool-catalog-nudge.ts:8,124`; `src/adapters/cursor/tool-guidance.ts:2,190`;
`src/adapters/responses-code-mode.ts:3,46`. Post-hoc consumers: `responses-code-mode.ts:55`,
`kiro.ts:758-771`, `cursor/tool-result-normalize.ts:96-112`.

NOOP check: `rg -n 'expects a string input|first line of the patch|write_stdin' src` finds only
`code-mode-helper-compat.ts:54` (compiles a helper alias) and `types/tools.ts:50` (name list).
Not a NOOP.

## Design

New exports in `exec-tool-result-normalize.ts` (full text in 010/020):

1. `CODE_MODE_HOST_CONTRACT_SENTENCE` — pre-call: one string argument; the patch opens and closes
   with the bare marker lines (blank lines or indentation around them tolerated; decorated or
   missing marker rejected); no `import`/`require` (globals per the exec description,
   non-exhaustive); `session_id` + `write_stdin` polling.
2. `CODE_MODE_HOST_FAILURE_GUIDANCE` — marker → recovery rows for the four host strings, matched
   case-insensitively.
3. `annotateCodeModeHostFailure(text, {toolName, toolNamespace})` — gated by a new, narrower
   `isCodexCodeModeExecResult` (bare `exec` or its `opencodex-responses` display alias; flat shell
   bridges and foreign MCP namespaces excluded because the four strings originate only in the
   isolate), refuses text already carrying the exported `CODE_MODE_HOST_RECOVERY_PREFIX`, appends
   one recovery line; else `undefined`. Pure, idempotent, byte-identical on the negative path.
   The empty-output repair keeps its wider `isCodexExecBridgeTool` gate.

Cursor keeps its own `RUNTIME_FAILURE_GUIDANCE` table and its `isError` policy byte-identical;
it gains one exec-gated branch that inserts the shared annotation WITHOUT changing `isError`
(audit blockers 2 and 3). Kiro substitutes the annotation only where it would otherwise carry the
raw text, leaving whitespace and failed-wrapper grouping untouched (blocker 1).

Code-mode context per seam: the native routed Responses seam already runs only after the body-level
code-mode gate (`responses-code-mode.ts:35-37`), so its annotation is exact. Kiro has
`codeModeExecName` in scope at the same call site (`kiro.ts:650`) and additionally requires it, so a
structured `exec` or an `exec` beside a shell bridge is never annotated there. Cursor's
`normalizeCursorToolResultText` is reached from six call sites without catalog context
(`protobuf-request.ts:392,842,1062,1097,1158,1272`); threading code-mode context through them is a
larger refactor than this unit, so Cursor coverage is name-based (exact `exec` under the
`opencodex-responses` provider). That is an accepted residual, recorded here and in the
structure doc: on Cursor a structured tool literally named `exec` whose output quotes one of the
four phrases would gain an additive recovery line with no error flip.

Accepted residual: a code-mode exec result that legitimately prints one of the four phrases (e.g.
`cat` of this devlog) gains a recovery line. The line is additive text and never changes error
status; the gate excludes every non-`exec` tool, every shell bridge, and every namespace other than
the exact `opencodex-responses` display aliases.

Marker wording: the live probe shows the host tolerates blank lines and indentation around the
markers and rejects a decorated or missing marker. Every sentence, recovery hint and doc paragraph
says "opens/closes with the bare marker line … blank lines or indentation are tolerated" and never
"the first character must be".

Why prose and not repair: `devlog/_plan/260905_apply_patch_envelope_gap/010_disposition.md`
refused rewriting JavaScript bodies (MODE B). An object argument inside a program has the same
ambiguity. Telling the rule before the call and naming it after the failure is the safe fix.

## Work-phase map (dependency order, PHASE-SPLIT-01)

Each implementation phase ends with an authorized `git push --no-verify` and gets exact-head hosted
CI as its C verifier (audit blocker 5). The PR is opened as a draft at wp1 so `pull_request` CI
exists for every later head, and is marked ready in wp3.

| WP | Doc | Slice | Depends on | C verifier |
|----|-----|-------|------------|-----------|
| wp0 | this file + 010/020/030 | docs-only roadmap | — | audit of the docs |
| wp1 | 010_pre_call_contract.md | shared sentence + three injection sites + tests; push; draft PR | wp0 | exact-head CI on the wp1 head |
| wp2 | 020_post_hoc_annotation.md | shared annotate helper + three result seams + tests; push | wp1 | exact-head CI on the wp2 head |
| wp3 | 030_docs_and_delivery.md | structure + docs-site sync, PR body, ready-for-review, receipt | wp2 | exact-head CI on the final head |

Single PR; no stack (DEV-STACK-OPT-IN-01).

## Accept criteria (goalplan c1–c4)

- c1: pre-call guidance present in all three code-mode injection sites, absent for flat/OpenAI catalogs.
- c2: exec results carrying any of the four host markers are annotated on routed Responses, Kiro (single and grouped), Cursor (text only, `isError` unchanged); non-matching output byte-identical; already-annotated text not doubled on replay.
- c3: PR ready against `dev` with the template body; exact-head hosted CI success; receipt bound.
- c4: each A gate has an independent `gpt-6-astra` audit; `structure/04` and docs-site guide updated.

## Verifiers (PLAN-VERIFIER-REAL-01)

Local execution is forbidden for this unit, so every row is NOT RUN locally and observed on hosted
CI. "Reads the target" is proven by import chains:

- `tests/adapters/tool-catalog-nudge.test.ts` imports `../../src/adapters/tool-catalog-nudge` (line 2) and `exec-tool-result-normalize` (line 7). wp1 target.
- `tests/providers/cursor/cursor-tool-definitions.test.ts` imports `buildCursorToolGuidanceSystemNote` through `../../../src/adapters/cursor/tool-definitions` (lines 6-22), which re-exports `tool-guidance`. wp1 Cursor target.
- `tests/responses/openai-responses-passthrough.test.ts` imports `responses-code-mode` (line 5). wp1+wp2 native target.
- `tests/providers/kiro/kiro-adapter.test.ts` imports `exec-tool-result-normalize` (line 16) and drives `createKiroAdapter`. wp1+wp2 Kiro target.
- `tests/providers/cursor/cursor-toolresult-normalize.test.ts` imports `tool-result-normalize` (line 5). wp2 Cursor target.
- `tests/adapters/exec-tool-result-normalize.test.ts` (NEW, wp2) imports the shared module.
- `tests/test-layout-tooling.test.ts` reads `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.
- `bun run typecheck`, `bun run privacy:scan` — CI `gates` job.

## Enforcement bypass (PLAN-BYPASS-NAMED-01)

Guidance, not enforcement. Tier: none. Executing surface: adapter request translation. Known
bypass: the model ignores the sentence; the host rejects exactly as today. Residual risk: status
quo. Wording: "early warning". Final layer: Codex host validation (unchanged).

## SoT sync targets (SOT-SYNC-01)

- `structure/04_transports-and-sidecars.md` paragraph at ~line 325 ("Native routed Responses code-mode turns also receive…") plus a Decision Log entry (full text in 030).
- `docs-site/src/content/docs/guides/codex-integration.md` "Routed local tools" (~line 331); translated locales untouched.

## Audit round 1 — synthesis (REVIEW-SYNTHESIS-01)

| # | Sev | Disposition |
|---|---|---|
| 1 Kiro grouping clobbers raw text | High | Folded: only the host annotation substitutes; grouped activation test added (020). |
| 2 Cursor false positives / case collisions | High | Folded: Cursor table untouched; exec-gated branch via shared helper; benign-content and case controls added (020). |
| 3 Cursor idempotence | Med | Folded: shared `[recovery: ` guard reached from Cursor; replay test with `isError:false` (020). |
| 4 Global whitelist false | Med | Folded: non-exhaustive list deferring to the exec description (010). |
| 5 No CI before wp3 | Med | Folded: push + draft PR at wp1, push at wp2, ready at wp3 (this file, 030). |
| 6 Elided strings | Med | Folded: full hunks and full Decision Log text (010/020/030). |
| 7 Anchor drift | Low | Folded: anchors refreshed against ec799db26; test import chain corrected. |
| 8 Docs overstate | Med | Folded: "this change" scope wording; three result paths named (030). |

Root cause across 1-3: the roadmap treated "reuse the seam" as "spread into the seam" without
re-reading each seam's own policy. Round 2 re-audits with the same reviewer.

## Audit round 2 — synthesis

| # | Sev | Disposition |
|---|---|---|
| 1 Cursor lowercase replay falls through to legacy loop | High | Folded: the exec-gated branch returns early on an already-annotated result; lowercase and capitalised replay tests assert text/isError/changed (020). |
| 2 Namespace-negative test contradicts the predicate; flat shells annotated | Med | Folded: new `isCodexCodeModeExecResult` gate; shell-bridge, foreign-namespace and Cursor-alias tests; docs say flat catalogs untouched and mean it (020/030). |
| 3 Responses replay `toBe(replayed)` cannot hold | Med | Folded: assert output-item and program identity plus deep-equal idempotence of successive passes (020). |
| 4 Marker wording contradicts whitespace probe | Med | Folded: "bare marker line … blank lines or indentation tolerated" in sentence, hints, structure and docs-site text (010/020/030). |
| 5 Off-by-one anchors | Low | Folded: 116, 32, 45-46, 97-106 (010/020). |

## Audit round 3 — synthesis (GO-WITH-FIXES, blockers=3)

| # | Sev | Disposition |
|---|---|---|
| 1 Bare `exec` name does not prove code mode | Med | Folded for Responses (body gate) and Kiro (`codeModeExecName` gate + structured/shell-bridge negative tests); accepted and narrowed for Cursor (name-based, additive text only) — see "Code-mode context per seam". |
| 2 Namespace `includes` admits foreign tools | Med | Folded: exact equality against `opencodex-responses` / `mcp__opencodex-responses` and the two flattened aliases; `mcp__foreign-opencodex-responses` negative and both flattened positives added (020). |
| 3 Summary retained the rejected whitespace claim | Low | Folded (this file, Design §1). |

# 010 — L2 execution plan and architect consultation

Architect: gpt-6.1-sol, handle `01a130c9-fbf3-7630-a0c0-84ac75a07b2f`. The proposal (D1–D6) was
read against PR #7003 head `08a4f130a9` and dev `3e58c2ce3e`.

## Main dispositions

| ID | Disposition | Plan |
|---|---|---|
| D1 | ACCEPT | Replace `CHECKPOINT_CONTINUATION_NOTE` in `src/responses/compaction.ts` with the architect's wording, which preserves authorization scope and permission gates, grants no authority through checkpoints or delegations, and gives later user messages priority. Application conditions, `SUMMARY_PREFIX`, and `appendCheckpointContinuationNote` stay unchanged. |
| D2 | ACCEPT | `tests/responses/compaction-continuation-note.test.ts` gains a literal `EXPECTED_NOTE` contract assertion and table-driven fixtures: authorized continuation, awaiting decision, scoped delegation, delegation awaiting authority, later pause, cancel, and replace. Each runs on the parsed context and the passthrough body. Test names say prompt contract or wire construction; none claims model behavior. |
| D3 | ACCEPT, bounded | NEW `tests/responses/compaction-continuation-wire.test.ts` builds real outbound requests from `parseRequest` output for OpenAI Chat, Anthropic, Google AI Studio, Kiro, Ollama native, and Command Code (Vertex and Cloud Code Assist only if their setup needs no ADC/network). It asserts that the route-specific system field holds the existing-instruction sentinel and the note. Controls: no checkpoint, opaque native blob, and summarizer turn lack the note. |
| D4 | AMEND | Per-adapter runTurn suites (Cursor, Devin, Claude CLI, CodeBuddy, Qoder) are not added in this carry. Instead, the wire test asserts that the shared `buildSystemPrompt` in `src/adapters/coding-agent/protocol.ts`, if it is exported (otherwise its nearest exported consumer), carries the note from a parsed context. The remaining runTurn routes are reported as uncovered. |
| D5 | ACCEPT | Append `compaction-continuation-note`, `-wire`, and (unused, so omitted) entries onto the existing `responses-main-quota-observation.test.ts` line in `scripts/test-layout/layout.json`. Register the same files in `tests/fixtures/test-layout-expected.json`. Line count stays at 1999. |
| D6 | ACCEPT | Add a "Decoded checkpoint continuation" section to `structure/transports/responses.md` and reflow existing compaction prose to stay within the 600-line limit without losing rules. Link it from `structure/transports/responses-wire-shapes.md`. Fix the authorization wording in `docs-site/src/content/docs/reference/adapters.md`. NEW `structure/decisions/ADR-7003-decoded-checkpoint-continuation.md`. `bun run structure:check` must pass. |

## Commit sequence on `codex/rt284-contrib-carry`

1. `fix(codex): deduplicate unchanged effort clamp observations (#7005)`: author Ingwannu, Co-authored-by Ingwannu.
2. `test(codex): drain quota fixture owners before home removal (#7001)`: author Ingwannu.
3. `fix(responses): frame a decoded ocx1 checkpoint as continuation in the system prompt (#7003)`: author Robin Bially. The layout.json entry is packed onto an existing line.
4. `fix(responses): scope the checkpoint continuation note to authorized work (#7003 review)`: D1–D6, Co-authored-by Robin Bially.
5. `fix(codex): retire stale short-window quota after plan changes (#7002)`: author NineDayCC, only after independent review, otherwise SKIP.
6. `fix(gui): cut the LazyCodex role section copy to what a user acts on (#6968)`: author LilMGenius.
7. `docs(devlog): L2 contributor carry plan`, containing these docs.

## Acceptance

The commands in `000_plan.md` §Verification all exit 0, `layout.json` stays below 2000 lines, and
the independent sol review returns PASS or NEAR-PASS with residuals folded on the final head.



## A round 1 amendments (auditor `01a130d1-33a3`, verdict FAIL, four P2s)

### B1 — exact note text (folded)

`CHECKPOINT_CONTINUATION_NOTE` and the test's literal `EXPECTED_NOTE` are this exact string:

> This conversation was compacted automatically. A checkpoint summary from an earlier context window appears as a user message and records prior work. Treat earlier requests it reports as completed as history; do not repeat them unless a later user message asks you to. Continue an unfinished task only when it was already authorized and remains within the scope of that authorization. Do not ask for the same authorization again while it still applies. Preserve all existing permission and confirmation gates; if a decision or required permission is pending, wait for it before taking the dependent action. A checkpoint or delegation, including one from another thread, does not itself grant authority or expand the task's scope. Later user messages take priority; obey any pause, cancellation, replacement, or change of scope.

It keeps pending decisions and required permissions as gates ("wait for it before taking the
dependent action") and keeps delegation scope ("does not itself grant authority or expand the
task's scope"). It also gives later pause, cancellation, replacement, or scope change priority.
Nothing in it contradicts the existing "completed requests are history" framing.

### B2 — structure budget (folded)

`structure/transports/responses.md` and `structure/transports/responses-wire-shapes.md` are both
exactly 600 lines, and `sizeBudgetLines` is the limit. Every addition to either file is offset by
reflowing existing compaction prose in the same file, so both end at 600 lines or fewer and lose
no rule. The new section in `responses.md` carries exactly one owner link:
`> Decision record: [ADR-7003](../decisions/ADR-7003-decoded-checkpoint-continuation.md)`.
`responses-wire-shapes.md` gets a link sentence only.

Review dispositions for every doc mapped to `src/responses/` or `src/adapters/` (structure/AGENTS.md:49):

| Doc | Disposition |
|---|---|
| `transports/responses.md` | UPDATE (authority): new "Decoded checkpoint continuation" section |
| `transports/responses-wire-shapes.md` | UPDATE: link to the authority beside the compaction projection |
| `runtime.md`, `transports/byte-accounting.md`, `transports/inventory.md`, `data-planes/inbound-compat.md`, `providers-and-adapters.md`, `providers/cursor.md`, `providers/kiro.md`, `providers/xai-grok.md`, `providers/chat-compat.md`, `adapters/registry.md` | REVIEW: the builder greps each for compaction/checkpoint/system-prompt statements; a doc changes only when a local statement becomes inaccurate. Results go in the commit body. |

### B3 — GUI union and full-suite disposition (folded)

Verification gains these commands:

- `cd gui && bun run build` (runs `tsc -b`, compiling all eleven locale catalogs)
- `OCX_TEST_RUNNER_BUN=… bun ../scripts/test-with-pinned-bun.ts --isolate tests/i18n-locales.test.ts tests/locale-parity.test.ts tests/lazycodex-role-models.test.tsx` from `gui/`

The full `bun run test` is not run here. The documented AGENTS.md resource exception applies:
four release-train lanes share this host, and the coordinator runs exact-head hosted CI on the
stacked PRs plus a final `lane=all` Cross-platform run. The focused files above, together with
`bun run test:changed` against `3e58c2ce3e`, form the local evidence. Unrun coverage is reported
as left to CI.

### B4 — commit shape and #7002 (rebutted, with one fold)

The coordinator packet (codex_delegation input) states: "#7003: Ingwannu의 CHANGES_REQUESTED 리뷰
내용을 읽고 요구사항을 별도 커밋으로 해결" (resolve the review in a separate commit). It also allows
"#7002(draft): 직접 리뷰해서 결함 없으면 carry, 아니면 수정 커밋 또는 SKIP 사유 보고". The separate
attributed fix commit (Co-authored-by Robin Bially) therefore follows the brief and stays.

Fold: the independent #7002 review (`01a130d1-34d6`) returned CARRY with no blocking defect, so
#7002 is carried. Its two coverage gaps go into a follow-up commit co-authored by NineDayCC: an
omitted-tertiary variant beside the explicit-null delayed-credential cases, and a seeded
future-reset rotation tuple that a malformed or stale observation must leave intact
(`main-account-hard-lock-retirement.test.ts`).


# 020 — Retain late Chat tool-call index aliases (#3673)

## Loop specification

- Class: C2 adapter repair; spec-satisfaction loop, one implementation PABCD cycle.
- Trigger: an upstream Chat stream introduces a call by ID, associates an index later, then sends index-only fragments.
- Goal: one complete call retains its original ID/name and argument budget ownership.
- Non-goals: guessing associations between unindexed calls, changing other malformed-field tolerance, changing budget limits, transport/core changes, unrelated adapter refactors.
- Verifier: exact-head hosted CI executes the focused cases below plus repository typecheck/full-suite gates. NO local tests, suites, typecheck, or test:changed; commands below are runner-only specifications.
- Stop: all acceptance rows and required hosted jobs pass on the delivered head, review findings resolved, and main proves delivery to dev. A docs-only result does not satisfy implementation criteria.
- Memory artifact: this decade document and main-owned 000/CI evidence ledger in the same unit.
- Outcomes: DONE after proof; NOOP only if current dev already has equivalent behavior and CI proof; otherwise BLOCKED/NEEDS_HUMAN with the concrete missing external evidence. Main controls orchestration and goals.
- Escalation: report upstream to main if the refreshed source no longer matches these contracts; main reclaims after two failed distinct delegates. Further delegated scope must be recorded during P, not improvised in B.
- Resources: local source/refs and supplied PR snapshot are read-only inputs; this planning delegate writes only this document and 030. Implementation write scope is the map below; main owns credentials, publication, CI dispatch, merge and its session-wide resource bound. No paid/provider calls are needed.

## Provenance and stale check

Baseline: `81871b3fa7034250b8d5ba2cbbfde44e40f0e69c`, inspected 2026-09-06 KST.
Source ref `origin/d-source-3673` resolves to `c8240c51d664f7cfb790b6d60679adfe0490b5c9`.
Original author: **Hako <25837994+devswha@users.noreply.github.com>** (`devswha`).
Source patch parent: `6585e6a70f42be8b6c81ff20d4fa0f39f7da03db`.
Snapshot: `.tmp/d-delivery/pr-3673.json` (`headRefOid`, body, comments, checks).
Read-only comparison `git diff c8240c51d^ 81871b3fa --` across the three source-PR paths returned no diff: source patch applies to the same relevant baseline. Recheck at this cycle's P because other lanes may land first.

Preserve author identity when carrying the commit; include `Co-authored-by: Hako <25837994+devswha@users.noreply.github.com>` in the eventual squash description/commit. Main may carry with a cherry-pick or reimplementation; neither is performed by this document writer.

## Exact change map

| Operation | Path | Change |
|---|---|---|
| MODIFY | `src/adapters/openai-chat.ts` | Add first-observed index alias to pending call identity lookup; keep budget key immutable. |
| MODIFY | `tests/adapters/openai/openai-chat-parallel-stream.test.ts` | Port the complete original regression patch, extending T9b and adding collision/budget controls. |
| MODIFY | `docs-site/src/content/docs/reference/adapters.md` | Port the original five-line paragraph under openai-chat. |
| MODIFY | `structure/04_transports-and-sidecars.md` | Append the contract block below in C. |
| NEW | none | Existing test file already appears in both layout manifests; no new helper/module/manifest entry. |

Read dependencies: `tests/helpers/translator-budget.ts`, `src/lib/translator-budget.ts`; reuse `createTestTranslatorBudget`, `withTestTranslatorBudget`, existing `collect`, `sse`, `chunkOf`, and `assembled`. No additional registry or identity map is necessary. Configuration cannot fix missing association state; deletion/NOOP would leave the observed sequence broken.

## Concrete patch contract

The exact original patch is the complete diff `git show c8240c51d664f7cfb790b6d60679adfe0490b5c9 -- src/adapters/openai-chat.ts tests/adapters/openai/openai-chat-parallel-stream.test.ts docs-site/src/content/docs/reference/adapters.md`. Preserve all hunks, including test import/helper changes; do not port just T9b.

Current anchors: `src/adapters/openai-chat.ts:1661` pending interface, `:1856` identity lookup, `:1873` budget opening, `:1912` argument-byte accounting, `:1679` budget closing. Replace the lookup block with:

```ts
if (rawIndex !== undefined && rawIndex !== null
    && (typeof rawIndex !== "number"
      || !Number.isSafeInteger(rawIndex)
      || rawIndex < 0)) {
  return yield* terminateWithError({
    ...invalidToolCallsEvent(rawToolCalls, "stream", pendingUsage),
    message: "upstream response contained invalid tool calls (invalid index)",
  });
}
const indexKey = typeof rawIndex === "number" ? `i:${rawIndex}` : undefined;
const key = indexKey ?? (idDelta
  ? `id:${idDelta}`
  : pendingToolCalls[pendingToolCalls.length - 1]?.key);
let call = key !== undefined ? pendingToolCalls.find(c => c.key === key) : undefined;
if (!call && indexKey !== undefined) call = pendingToolCalls.find(c => c.indexKey === indexKey);
if (!call && idDelta) call = pendingToolCalls.find(c => c.id === idDelta);
```

Add `indexKey?: string` after `PendingToolCall.key`. Immediately after the existing new-call allocation/openCall block, add the source comment and:

```ts
if (indexKey !== undefined && call.indexKey === undefined) call.indexKey = indexKey;
```

Before: the ID+index delta finds the ID-owned call through ID fallback but does not retain its index; the next index-only delta allocates another unnamed call. After: direct key wins, then remembered index alias, then existing ID fallback. The original `call.key` never changes and alias registration does not call `budget.openCall` a second time. First observed index remains authoritative; no second alias is added for a repeated ID on a different index. Keep resolve-before-validation, `sawArgumentsString`, heartbeat emission, overflow conversion, flush and EOF logic unchanged.

## Regression activation and oracle

Port exact fixtures/assertions from the source commit; all paths are reachable through `createOpenAIChatAdapter(...).parseStream(new Response(sse(...)), budget)`.

| Activation | Required observation |
|---|---|
| T9b ID-only `call_b/read/{"p"`, then index 0 + same ID + `:"x"`, then index 0 + `}` | Exactly `call_b/read/{"p":"x"}`; final done; budget activeCalls/currentBytes/overflows all zero. Current T9b at test line 214 ends at ID+index and misses the defect. |
| Two ID-only calls, learn indexes 9 and 4 in reverse order, index-only tails plus ID-only trailing space | Separate read/write calls and exact original fixture args; peak active calls 2, no duplicate owners, final zero retained bytes. |
| Two unindexed calls then unrelated index-only fragments without any ID/index association | Final error and no done; never guess by position. |
| Existing index with conflicting ID | Index ownership wins; neither call rebound. |
| Established indexed calls later share the same ID, followed by ID-only continuation | Existing first-match ID fallback stays intact. |
| Same ID repeats with a second index after index 0 was observed | Index 0 remains the alias; exact fixture completes one call. |
| `{"p":"é"}` split over ID/ID+index/index frames, maxCallArgumentBytes 9 then 10 | At 9: translation_buffer_limit, no tool_call_start, one overflow. At 10: exact completed args, done, zero overflow. Both release retained bytes/calls. |

Optional additional mutation experiment (not a completion prerequisite): run the final regression file against the baseline adapter and observe T9b fail for split/unnamed calls; restore patched adapter and rerun the same file green. Store both outputs; until observed, describe RED as planned rather than proven. Do not disable original tests or change timeouts to mask failures.

Runner-only focused command:

```sh
bun test tests/adapters/openai/openai-chat-parallel-stream.test.ts tests/adapters/openai/openai-chat-hardening.test.ts tests/adapters/openai/openai-chat-eof.test.ts
```

Then hosted typecheck/full test jobs, privacy scan and docs build; `.github/workflows/ci.yml:255` owns test jobs, `:392` gates, `:422` typecheck. Record actual head SHA, run/job URLs and executed job conclusions; intake labels and skipped jobs do not prove tests. Main pushes with `--no-verify` as authorized, bypassing local prepush only. Do not attest that local CI ran.

## Documentation and architecture sync

Apply source paragraph before `## ollama-native` at adapters reference line 52. Reconcile this same-file edit with A's #3568 docs and 030's Cursor section without overwriting either. English is canonical; inspect translated adapter pages for contradictory identity claims, and enumerate any required locale changes in P before widening the map.

Append to `structure/04_transports-and-sidecars.md`:

```md
## Chat streamed tool-call identity

`src/adapters/openai-chat.ts` retains a call's first observed numeric index as an
alias when the call started by ID. Lookup preserves direct-key precedence, then
index alias, then ID fallback. The initial key continues to own all translator
budget reservations and release; learning an alias creates no additional owner.
Unassociated index-only fragments are not guessed onto pending ID-only calls.
`tests/adapters/openai/openai-chat-parallel-stream.test.ts` covers late aliases,
parallel/colliding identities and UTF-8 byte-limit boundaries.
```

## Review blockers and integration exit

Snapshot says MERGEABLE. Source body leaves draft/readiness open: 124 focused passes and 6,152 affected passes are author-reported, not delivered-head evidence; full baseline has reported timeout failures and does not establish green. CodeRabbit's latest comment reports no actionable comments; its docstring coverage warning is not product execution proof. No independent approval or review-thread completeness can be inferred solely from the empty `reviews` array. Main must refresh threads and CI at the candidate head.

This layer follows 010 in the D stack as an integration sequence, not a runtime dependency. After lower-layer edits, main cascades refreshed descendants and revalidates changed heads. Main merges bottom-up, proves merge-commit ancestry on fetched dev, and immediately closes superseded #3673 only after that proof. A new PR's squash must retain the original trailer. This docs-only delivery neither merges nor closes anything.

## Roadmap lock clarification

The implementation cycle certifies its published current-head candidate. Every dev-ancestry and original-closeout obligation remains mandatory in the separate landing work-phase, allowing the owner-requested stack to exist without treating publication as dev integration. Eligible lower layers may land early and are closed immediately after ancestry proof.

## External review amendment: numeric index contract

Only non-negative safe-integer indexes may become an alias. Immediately after reading rawIndex, if it is numeric but not an integer or is negative, terminate through the existing invalidToolCallsEvent/terminateWithError path; do not treat an invalid numeric index as absent and append its data to the last pending call. Other tolerated placeholder fields retain their existing rules. Add reachable negative/fractional numeric-index regressions with two distinct pending calls: one error, no done, no fragment reassignment, and all budget reservations released. Preserve all original positive and collision cases. This is an explicit source-patch amendment, not a claim the original commit already implements validation.

## Safe-integer review repair

The numeric guard uses Number.isSafeInteger: parsed indices beyond the safe range can already have lost identity precision. Add a raw-wire regression containing distinct large integer literals (not JS values rounded before serialization), and retain a positive MAX_SAFE_INTEGER boundary. Capture error/no tool success plus existing reservation-release coverage. The correction must be verified in this same unit; no original source tests are removed.

## Claimed-type boundary update

022 supersedes the earlier non-numeric-index tolerance assumption: only missing/null indexes are absent. Every other claimed value must be a non-negative safe integer; no coercion of strings/objects/bools/arrays. Repeated ID/name/argument-field tolerance is unchanged.

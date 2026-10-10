# Adjacent Kiro result coalescing

Depends on task-input; class C4 for protocol identity. Fix #3734 from recorded Codex code-mode output shape, never by spending live Kiro quota.

## Diff-level change map

- MODIFY src/adapters/kiro.ts pushUser/turn-construction helper: when adding results in immediately adjacent parsed messages, tracked separately from collapsed user turns, combine only adjacent results with identical normalized toolUseId. Append content in exact input order and propagate error if any constituent is error. Preserve images via the adapter's supported representation; ensure no image is dropped or reordered relative to supported content semantics.
- Preserve the pendingToolUses.delete validation: call-a, call-b, call-a remains invalid. Do not globally deduplicate by id or merge across assistant/tool boundaries, intervening ordinary input, or unrelated result.
- MODIFY tests/providers/kiro/kiro-adapter.test.ts and relevant kiro-images.test.ts fixtures for three adjacent results, error later in group, different ids and nonadjacent repeats, text+image preservation. No new fixture uses real call ids or messages.
- MODIFY docs-site/src/content/docs/reference/adapters.md and structure/04_transports-and-sidecars.md with narrow multi-output contract.

Before: pushUser appends each result, wire validation consumes the first matching toolUseId and rejects the next duplicate. After: consecutive same-call outputs become one ordered result before validation. Opaque encrypted output rejection remains unchanged.

## Activation / verifier

CI tests feed one assistant exec call followed by notify/notify/final results; assert one toolResult and ordered content. Mixed error/success reduces to error; unrelated result boundaries cannot be crossed. Same-id nonadjacent repeat still throws matching error. Exercise retained images using existing adapter representation; enforce maximum/shape constraints already owned by Kiro wire. Run existing Kiro adapter/image suites through ci.yml, plus full typecheck/privacy. Saved local log shape is supporting evidence only; live Kiro correctness remains untested and explicitly reported.

## Non-goals

No Kiro account/OAuth/quota changes, no aggressive malformed-history healing, no parser changes beyond prior layer, no global result deduplication.


## Source follow-up folded at roadmap lock

Track adjacency in original message iteration; reset on every non-toolResult message including user/developer/assistant, even if pushUser collapses it into one user turn. Retain Kiro images on the current user image list as the existing wire format requires; do not promise unsupported text/image interleaving in the wire. Preserve Co-authored-by: Yrlan <71253160+yrlan-montagnier@users.noreply.github.com>. Local log metadata contains old Kiro activity and is not a current live reproduction.

## Kiro-cycle P refresh on parent b24ed35a

Parent #3743 is verified and ready, still open as this branch base; fixture prerequisite #3745 is merged. Issue #3734 remains open without an author PR. kiroPayloadMessages currently returns parsed.context.messages unchanged, so tracking adjacency at the top of its loop observes original Ocx message barriers even when a reasoning-only assistant is later skipped or user/developer turns collapse.

Concrete source edits in src/adapters/kiro.ts only: priorCalls values retain rawId alongside wireName; validate each result against that exact raw id after normalizing for wire lookup. This rejects different raw ids sharing a replacement/truncation result without banning legitimate paired non-wire ids. Track adjacentRawToolResultId, reset it for every non-toolResult before any early continue; for matching adjacent raw id and last user turn/last wire result, append text content and images, set status error if any constituent isError. Otherwise retain pushUser and final conversation validation. No global dedup, cross-turn merge or normalizer change.

MODIFY tests/providers/kiro/kiro-adapter.test.ts only for regressions: parse a real Codex custom_call plus three adjacent custom outputs (optionally preceded by the parent external task input), assert one ordered result; error remains sticky and images survive including image-only later output; single-result control; A/B/A and user/developer/assistant/reasoning-only barriers reject. Raw-id controls cover pipe/underscore, whitespace, truncation and case mismatches; exact raw pairs still normalize and merge. Keep every orphan/encrypted and catalog test. No new test/layout files.

MODIFY docs-site/src/content/docs/reference/adapters.md Kiro section and structure/04_transports-and-sidecars.md with this bounded contract. Preserve Co-authored-by: Yrlan <71253160+yrlan-montagnier@users.noreply.github.com>. Resolve roadmap review thread PRRT_kwDOS-0Gi86fozIF only after the raw identity fix is verified.

Local evidence limit: saved Kiro conversation data and OCX diagnostic artifacts were inspected for field shapes only; no current Codex multi-output Kiro trace was available. No raw message, id or credential was emitted, and no live Kiro request was made. Synthetic CI fixtures are protocol regression evidence, not a field-success claim.

Dispatch: main owns adapter/docs; bounded worker owns only kiro-adapter.test.ts. Independent A/C reviewers inspect raw identity, original-message adjacency, error/image propagation and unchanged encrypted rejection. Full runtime CI is remote only, including existing Kiro image/adapter tests; live Kiro is forbidden.

## Resumed P after verified guidance parent b7e67d84d

The separate task-guidance cycle is complete, parent3743 P1 is resolved and CI34014313740 is green. Its verified head was merged into this preserved Kiro branch before implementation. Prior Euler review is folded below and must be rechecked before B.

A contiguous group is finalized before any non-toolResult (including skipped reasoning-only assistant), before a different raw id, and after the loop. Track only local bookkeeping: rawId, reference to the fresh KiroToolResult, count, raw text parts and whether this group carried images; never put these fields on wire objects. A single-result group keeps the exact existing normalized text/fallback. For 2+ results, preserve ordered raw text parts except successful empty-exec wrappers, append images and keep any isError sticky. If the whole group has meaningful text, use those parts and remove any first-chunk empty fallback. Preserve whitespace text parts when meaningful text exists. If all text is empty, retain one existing fallback; use the neutral KIRO_EMPTY_TOOL_RESULT_MESSAGE when images or an error flag make an empty-success exec hint inappropriate. Failed exec wrappers are meaningful failure information and remain raw text in multi-result groups even when the incoming isError flag is false; preserve existing FAILED_EXEC_OUTPUT_MESSAGE for a single result. No new normalizer or message template.

Read evidence: normalizeEmptyExecToolResultText distinguishes EMPTY_EXEC_OUTPUT_MESSAGE from FAILED_EXEC_OUTPUT_MESSAGE, and failed wrappers can arrive with isError=false. The wire validator requires at least one nonblank text part for each result; finalize groups before that unchanged validator. Keep the encrypted-content throw ahead of every grouping branch, and enforce exact raw id for every result, not only on coalescing.

Additional regressions: later image-only/empty/success-empty wrapper does not inject placeholders into an already-populated result; initial empty then real text removes the empty hint; all-empty groups retain a valid nonblank result; multi-result failed wrapper retains its failure signal; later encrypted adjacent result still rejects; whitespace between meaningful chunks survives. Existing single empty/failed exec normalization tests must pass unchanged.

## Resumed A dispositions

Accept whitespace concern: collect a nonzero-length raw text part when trim is empty OR the shared normalizer did not classify it as EMPTY_EXEC_OUTPUT_MESSAGE. This preserves whitespace between/before actual text while discarding only true empty-success wrapper text; failed wrappers are never in that drop category. Finalization decides whether the aggregate has meaningful text.
Rebut the need for duplicated tool-name bookkeeping: create the first fresh wire result using the EXISTING normalizeEmptyExecToolResultText(text,{toolName,toolNamespace}) call before registering the group. A one-result group is never rewritten at finalization, so its exact precomputed fallback is retained; no normalization without identity occurs. Multi-result finalization replaces that initial content only with raw aggregate parts (or neutral empty text for image/error groups). Tests pin the existing single-result behavior and no bookkeeping keys on wire.

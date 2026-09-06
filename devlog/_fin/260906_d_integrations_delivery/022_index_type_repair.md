# 022 — Reject claimed invalid index types

## Loop specification

Class C2/C3 bounded parent repair. Source: current #3702 at d6bfb044a; late reviews PRRT_kwDOS-0Gi86fl4vM and fl4vC. Goal: a present invalid index cannot be mistaken for an absent index and routed to the last pending call. Non-goals: changing repeated ID/name/argument placeholder tolerance, parsing numeric strings, new adapters or unrelated Logs work. Remote/CI verification only; no local tests/typecheck. Same session resource bounds apply. Main owns Git/FSM/integration; one worker may edit only the adapter, its parallel-stream test and structure04. Main reclaims after two failed delegates.

This additive repair preempts unfinished Logs planning. No previous work-phase completion marks or final criteria were removed. Detailed review synthesis is in scratch. Resume Logs after this full cycle and cascade.

## Exact change map

MODIFY src/adapters/openai-chat.ts, before all key matching:

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
```

Before: only invalid numbers reject; present strings/objects/bools become no indexKey and may select the last pending call. After: only missing/null is absent; every other claimed index must be a non-negative safe integer. The existing terminateWithError closes all budget reservations before the error is yielded. Keep the alias/key precedence and immutable reservation keys unchanged. No new fields/enums/dependencies.

MODIFY tests/adapters/openai/openai-chat-parallel-stream.test.ts: retain all Hako and safe-integer cases. Update expected diagnostic wording. Add labeled table cases for numeric string, empty string, true/false, object and array, with pending complete JSON calls so a silent fallback could otherwise produce success; assert one terminal502, no tool/done event and released reservations. Include explicit missing/null positive continuation through a later valid numeric alias. Use tuple wrappers for array-valued cases so test.each cannot mistake an index array for argument tuples.

MODIFY docs-site/src/content/docs/reference/adapters.md: specify non-negative safe integers; explicitly reject non-numeric values and negative/fractional/unsafe numbers; missing/null remain absent-index placeholders. Do not call valid JSON numbers malformed JSON.

MODIFY structure/04_transports-and-sidecars.md: align the same index contract and source/test ownership.

MODIFY 020_tool_aliases.md: carry the corrected guard and compatibility boundary. Annotate 021's former non-numeric-placeholder policy as superseded by this repair; retain its historical source snapshot.

## Verification and exit

- Independent plan and implementation review; original source authorship retained.
- Exact-head pinned remote typecheck/full suite/docs build, hosted CI registration and no unresolved findings. Full final integrated CI remains mandatory under c-2; build readiness is not merge permission.
- Existing numeric/unsafe/UTF-8/collision cases remain green; new claimed-type cases actually observe pending allocations before early failure, and null/missing positive cases still assemble one correct tool.
- Cascade new parent into Cursor with a merge preserving both authors' commits and both structure sections; fast-forward the still-unpublished Logs branch to updated Cursor. Verify both ancestry edges. Do not mark the updated Cursor head verified until its own new evidence exists.
- Main returns to parent for the repair receipt/D, then resumes original Logs planning. Shipping #3702 still requires strict merge verification and actual dev ancestry before source #3673 closes.

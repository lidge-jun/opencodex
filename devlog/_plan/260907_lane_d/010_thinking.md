# 010 Thinking ordering
MODIFY src/claude/outbound.ts ensureBlock/closeOpenBlock and reasoning done.
Before: thinking start/deltas are emitted immediately; done closes thinking then red.
After: retain already-budgeted thinking text, defer its start/index/delta until close;
reasoning done emits red blocks before flushing pending signed thinking. Preserve text
and tool order, hidden env.txt non-disclosure, genuine signature and budget release.
MODIFY tests/claude-integration/claude-outbound.test.ts: compare collected SSE against
literal expected content and JSON for combined envelopes with preceding deltas,
multiple summary parts/red blocks, text prefix, signed-only, red-only. Check sequential
non-overlapping block indices and cancellation/overflow existing assertions.
Independent Astra audit must resolve streaming latency and allocation implications.

Verification: NOT RUN locally by user instruction; focused tests execute in final top-head Cross-platform CI.

## A audit fold-back
Astra Dirac found two blockers: unmatched-item reordering and closure memory overlap.
Track bounded reasoningItemKey separately from part identity; flush on changed explicit
item identity, and close unrelated pending thinking before another item's red blocks.
Only same identity (including both omitted) reorders red before pending thinking.
Retain thinkingBuf through signature emission as before;
queued frame budget stays authoritative, never weakened. Add near-limit valid control,
shared-budget collector control, overflow/cancel regressions. Deferred thinking is an
accepted visible-latency tradeoff; text/tool frames remain live with incremental-reader
coverage. Late done after a different emitted block cannot reorder earlier content.

Re-audit Dirac: VERDICT PASS, blockers=0. Accept tight artificial budget capacity reduction; retain original overflow assertions and production limits.

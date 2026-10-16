# Decisions

Soundness reviews by gpt-6-sol reviewers, notes in the lane worktree .tmp/lane-e/review-*.md (scratch, not committed). Every PR merges cleanly into dev, and the cumulative stack simulates cleanly with git merge-tree. Carry order is 5629 -> 5659 -> 5646 -> 5633 -> 5489: #5646 first so the WebSocket row #5633 adds is never exposed to the 2xx third-send gap.

| Item | Verdict | Decision |
|---|---|---|
| #5629 Devin approximate retry delays | SOUND-WITH-FIXES | Carry; fix the stale "~ prevents re-parsing" comment in src/adapters/devin/cloud-direct/chat.ts and reject a repeated approximation marker (retry after ~1 minute ~30 seconds) with a negative parser case. |
| #5659 code-mode goal helpers | SOUND-WITH-FIXES | Carry; add the original guard-input assertion, an unrelated-name rejection and bare-goal precedence case; update stale authorization comments in src/types/tools.ts. Closes #5495. |
| #5646 stop failover once the replacement is spent | SOUND-WITH-FIXES (pair) | Carry first of the pair. Closes the shared resend-safety gap (CodeRabbit's #5633 2xx finding). |
| #5633 WebSocket retryOnReset replacement | SOUND-WITH-FIXES (pair); UNSOUND alone | Carry after #5646; drop the duplicate settleOperatorReplacement import in passthrough-dispatch.ts; rewrite structure/transports/responses-failover.md so the 2xx gap reads as settled. Partial for #4191 (not in this lane's list; not claimed). |
| #5489 undeclared zero-output tool failover | UNSOUND as submitted, salvageable | Carry with fix: non-streaming classification must not hop after a replayUnsafe heartbeat; add a non-streaming E2E proving no second dispatch; sync structure/runtime.md, structure/transports/responses-failover.md. Covers only the Responses path of #5407, so #5407 stays open. |
| #5221 sub-agent own-model identity | UNSOUND | Exclude. Routed raw-body repair never personalizes the neutral catalog line, native parent -> routed worker stays wrong, fenced identity sentences can be rewritten, new test is unregistered. |
| #5217 | not fixable in bounded effort | Exclude; needs a destination-aware identity design across catalog, parser and passthrough. |
| #5494 DeepSeek combo adapter_eof | NEEDS-REPRO | Exclude. Current dev already hops a zero-output adapter_eof; the final 502 and cooldown 503 follow existing rules; wire capture needed to separate upstream truncation from a relay/adapter terminal loss. |
| #5369 responses-state spill growth | not a defect | Exclude. Reporter's own re-measure stays under the 1 GiB / 1000-entry / 24 h bounds; the remaining unreferenced-file footprint is a design question for snapshot-omitted in-memory owners. |


## Closure claims (audit fold)

The PR says Closes #5495 only. #5407 (Responses path covered, Claude Code/Anthropic path not), #5217 and #4191 are not claimed. Listed issues #5407 and #5217 are reported to the coordinator as unfixed with findings, as the lane packet allows ("fixed ... or excluded with findings"). Supersede claims: #5629, #5659, #5646, #5633 and #5489 are superseded only when their whole net contribution is on the branch; #5489 is carried whole (its issue coverage is what is partial). #5221 is excluded and not superseded.

# Adjacent Kiro result coalescing

Depends on task-input; class C3. Fix #3734 from recorded Codex code-mode output shape, never by spending live Kiro quota.

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

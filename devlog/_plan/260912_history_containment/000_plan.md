# History containment and continuation review

This unit carries the paginated-history refusal from #4313 onto current dev, evaluates #4086 and #3663 as separate product slices, and keeps unresolved #4311/#3522 acceptance explicit.

Loop: satisfy-spec HOTL. Trigger: delegated history lane. Scope: this worktree, three source PRs, two issues. No local product tests/build/typecheck/install; no merge, native stack, release, service/config changes, native ordinal allocation or damaged-history rewriting. Git/gh credentials already available are the only external scope. No user time/token/agent cap.

Verification: source/diff review now; final cumulative tip GitHub hosted CI later. Local suites NOT RUN. `git diff --check` checks patch whitespace only, not runtime behavior. Stop: reviewable carry PRs and final-tip hosted evidence plus explicit unresolved acceptance, or actual capability failure recorded without fabricated approval.

Evidence: .tmp/history-lane/ and this unit. Security drafts stay in scratch. Escalation: actual tool denials/access failures are recorded; independent work continues. Main implements; read-only reviewers cannot change source. Architect native role is absent from the exposed schema; no registration/config changes authorized or attempted. The user explicitly authorizes supported inherited-model independent design review and reflection plus a separate A reviewer; both are dispatched without claiming a native architect role.

## Work phases

0. Docs-only roadmap, lock the source-pinned diff designs below.
1. Containment carry #4313: rollout guards, injection compensation, focused regression source, eight locale guides and owning structure docs.
2. Continuation slice #4086 disposition/carry: custom-tool replay guard and HTTP/WebSocket regressions. Independent of containment; branch from dev if adopted.
3. Experimental relay #3663 disposition: security/owner review and injection overlap. A carry is conditional on justified safe amendments; new unpublished security details remain scratch. If not acceptable, preserve exact blockers for parent rather than silently dropping the slice.
4. #3522 evidence disposition and final hosted CI verification/repair. Diagnostics #3790 already landed; no generic diagnostic rewrite. Same-process Windows recovery remains unproven absent genuine evidence.

## Acceptance

#4311 containment only: ordinal/history_mode records and migratable stores refuse external relabel; config/profile/journal preserved on refusal and compensation failure remains visible. Legacy writes preserve descriptor identity. Native writer support and damaged recovery remain open.
#4086: replay miss on selected stateless/lowered-custom destination returns previous_response_not_found before dispatch; replayed complete history remains paired and reasoning preserved. Native continuation semantics stay intact.
#3663: authenticated owner-bound relay must not mix credentials/accounts; explicit feature gating and existing injection refusal coexist. Maintainer security approval is a separate merge gate.
#3522: current issue comments govern; healthy separate-process probes do not prove same-process recovery.

## Delivery topology

Use ordinary independent dev PRs for unrelated slices. Only a later repair of one slice depends on its own carry. Shared file edits do not by themselves imply dependency. Parent alone merges. Preserve source authors using Co-authored-by trailers. Readiness remains draft until final hosted and review evidence is recorded.

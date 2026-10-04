# Translated Responses pre-header reset retry

A translated Responses request currently refuses a connection reset before headers even when its provider enables `retryOnReset`. Carry public PR #6525 through the existing request-wide grant and send accounting, with direct regression coverage for recovery legs and a real loopback disconnect.

- Archetype: satisfy-spec; trigger: next-release replacement of public PR #6525.
- Goal: one focused ordinary draft PR against `dev`, preserving the source behavior and authorship.
- Class: C3 transport repair, with C4 care for the replay/send-budget contract.
- Non-goals: adapter-owned fetch recovery, translated post-header recovery, merge, source closure, release/version changes, installed runtime or account changes, paid/live requests, native GitHub stacks.
- Verifier: focused handler and retry tests, typecheck, structure/privacy/layout/ratchet gates, docs build, independent review and current-head hosted CI inspection. Full/changed local suites are excluded by the explicit concurrent-lane resource contract.
- Stop: attributed replacement published and attached; source coverage accounted; focused gates green; applicable review findings fixed; hosted CI inspected with missing/native/live evidence disclosed and draft retained as needed.
- Artifacts: this unit; ignored `.tmp/next-release-retry/` contains raw evidence. New security material stays only in scratch.
- Outcomes: DONE is publication under those criteria; unresolved behavior or verification remains explicit, never described as passing.
- Escalation: scope changes beyond replay wiring; any denied publication; no new authority inferred.
- Resources: local checkout, git/gh for this lane, gpt-6.1-sol leaves, fake upstreams and ephemeral loopback only. No user token/time budget was set; use bounded commands, no shared process killing or lock bypass.

## Source and baseline

Source: #6525, commit `49c5c7012f1f27d781079231dde92562ced68594`, author Yuxin Qiao <104957188+Yuxin-Qiao@users.noreply.github.com>. Its single commit has 14 files and 10 handler cases. No source reviews/inline comments or native stack membership at inspection. Source common ancestor is `358b8ffd4c7f95237dadee1e9a5b4fedb671f4f4`; refreshed dev/base is `0818ea1812a028e1c14cd0b0511b44863407bc52`.

One cohesive work phase: plan/audit → carry and refine wiring/tests/docs → check/review → publish. No separate independently useful implementation units require a roadmap cycle.

## Existing owners and necessity

Reuse `request-resend-gate.ts`, `reset-replay.ts`, `request-send-budget.ts` and `upstream-retry.ts`; do not add a parallel retry policy or budget. Configuration alone cannot fix the missing callback; deleting the refusal would lose the safety boundary. `adapter-dispatch.ts` owns both generic send sites; public provider prose and `structure/transports/responses-failover.md` describe them. See the diff plan in `010_retry.md`.

## Consultation

V1 leaf surface, requested model gpt-6.1-sol. Architect handle (recorded in local evidence); proposal and first reflection received. RETRY-D01 shared gate, D02 external accounting, D03 exact caps with prepaid handling, D04 docs are accepted. D05 unreachable reset-then-recovery scenario was replaced by terminal-replacement and spent-grant-on-rebuild scenarios; final same-architect reflection ALIGNED on D01–D05 with no design gaps. The six reservation sites and prepaid last-slot handling are explicitly recorded in 010. Main owns the executable plan and all decisions. Documentation coverage is independently inspected by leaf (recorded in local evidence).

Independent A reviewer (recorded in local evidence) returned VERDICT: PASS with no blockers, confirming all source files/cases and reachable tests accounted. Main accepts the verdict. Baseline typecheck, structure/privacy, 561-page docs build and 77,944 link checks passed.

Implementation and focused verification are complete; see `011_verification.md` for source coverage, the combo accounting decision, current publication base and evidence limits. Publication targets an ordinary draft PR; hosted current-head results are reported in its Verification section.

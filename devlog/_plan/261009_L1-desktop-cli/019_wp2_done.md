# 019 — wp2 done (PR A #6802)

**Conclusion.** The CLI now recognizes a Desktop-supervised runtime without an ownership claim and stops recommending a
competing service. PR #6802 (head 1718fcad8b, rebased on dev fd2032050a) carries evidence, projection, GUI and docs.

**Evidence.** 332 focused tests pass (receipt), typecheck/lint/GUI tsc/build/ratchet/structure/privacy/docs build pass;
live read-only check on the reporting Mac matches the expected output; independent review PASS after two fix rounds
(found: live wording without liveness, stale supervision across login probe, override pid binding, untranslated
guidance, ownership race after the final probe, custom-local precedence).

**What did not improve / risks.** Windows still reports `unsupported`. The fix reaches users whose CLI is updated; the
2.81.0 runtime's own startup probe still lacks the field until the Desktop app updates (the override covers updated CLIs).
Hosted CI was pending at D.

**Next.** wp5 command guards stacked on this branch (020 + 003); then wp3 launcher from dev.

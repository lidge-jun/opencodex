# 261012 Windows health recovery (#6671) — roadmap

Issue: lidge-jun/opencodex#6671. A supervised proxy (Windows 2.77.0, bundled Bun 1.4.0)
stayed alive and kept its port listening while `/healthz` went unanswered for 20 s and
longer. Every supervisor this repository installs restarts the proxy only when the
process exits, so nothing recovered it until an operator killed it.

Owner direction on the issue (lidge-jun): "a safe fix would be an opt-in external liveness
recovery with bounded failures, ownership checks and no request replay." Ingwannu: process
recovery must not imply automatic replay of ambiguous turns.

| Doc | Content |
|---|---|
| 010_source_findings.md | Where each supervisor judges liveness, with file:line |
| 020_design.md | Opt-in out-of-process health sentinel: policy, runner, gates |
| 030_root_cause_and_reporter_checklist.md | Stall candidates and what to collect on the Bun 1.4.2 release |

Work phases (goalplan `resolve-the-recovery-gap-in-lidge-jun-opencodex`):

1. wp0 — this roadmap (docs only).
2. wp1 — implement 020 with platform-independent tests.
3. wp2 — independent review, rebase on `origin/dev`, PR to `dev`, exact-head CI (Windows legs included), handoff to the merge thread.

Out of scope: the Rust desktop supervisor (analysis only, see 010), CI runner stalls (#4956,
another thread), any change to a live service on a maintainer machine.

What a Windows runner cannot prove: the original stall. CI can prove the sentinel's
spawn/probe/terminate path on a real Windows process; it cannot reproduce the production hang.


## Status after wp0

Roadmap locked after four independent design audits (dispositions in 020). The design is
recorded as an owner document in `structure/ops/service-health-recovery.md`. wp1 carries the
implementation and its tests; the two residuals for maintainer review are the probabilistic POSIX
kill binding and the absence of an installed-service restart test.

# Recovery fixture home isolation

The recovery fixture changed HOME and OPENCODEX_HOME but inherited the test runner's
explicit CODEX_HOME. The production home resolver prioritizes that explicit value, so
the detached child could share the parent test's Codex namespace. This is a confirmed
fixture-isolation defect, not proof of the earlier intermittent startup failure's cause.

`tests/update/update-stop-first.test.ts` now reuses `createIsolatedTestEnvironment` for
the case root and child environment. A negative-inheritance test checks its private Codex
directory, preserved real-home guard, unchanged parent input and absent service state.
The actual child environment is also checked with the production Codex home resolver.

Runtime selection, runtime overrides, bundled dependency, all timeouts, diagnostics and
reap-before-removal ordering are unchanged. No production code or port-probe code changes.
The port-probe investigation is separately owned by the coordinating work.

Independent plan and implementation review: Kant PASS, read-only. Initial preparation
commit `b37841448816107c856171277dff0464032d282e` was local-only and left the three
existing PR heads unchanged. The user later ended cross-task coordination. This follow-up
now forms the fourth layer of the independently integrated stack described in040, and
requires its own new exact-head remote CI before merge. No local test, typecheck, build,
lint or scan was run. Integration does not change the reviewed test patch or prove the
cause of any historical startup failure.

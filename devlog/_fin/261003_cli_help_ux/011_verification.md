# wp1 verification and remaining full-suite failure

The help foundation is implemented and independently reviewed. Root text remains
byte-identical, nested context help resolves, declared help is honest, and flag
help retains safe parent fallback. The focused regression added first failed on
the old parser (4 failures); the corrected source passes 85 focused tests, plus
one final explicit-detail regression. Independent review covered all 13 changed
files and probed all 74 declared capabilities: PASS, no actionable findings.

Main checks: typecheck, structure, generated skill surface, privacy and docs build
pass. Layout tests:18 pass. Changed-import graph:1,036 pass,1 skip,0 fail across
42 files. Docs:561 pages,77,926 internal links. Eleven real isolated-home CLI
scenarios confirmed stdout/stderr, exits, equivalent forms, repeat/plain output
and no state writes; QA receipt is retained locally.

`bun run test` did NOT pass. Its parallel lane reported35,806 pass,107 skip,4 fail;
subsequent serial lanes completed but do not erase those failures. Three failures
in `tests/update/update-restart-lease.test.ts` reproduce both in isolation here
and in an unchanged `git archive` of4b98328dca (4pass/3fail in each). They concern
parent/child service-authority path disagreement and mutation leases. No affected
service production or test file is changed in this PR.

The fourth failure is EISDIR in the initial snapshot of
`tests/codex-integration/injection-model-suggest-routes.test.ts`, before its tested
request. Test/harness/direct dependencies match the baseline. One diagnostic
isolated run passes (1pass/12assertions); this does not establish its cause or
clear the full-suite failure. No skip, quarantine or retry-as-fix was introduced.
No exact-baseline hosted workflow was returned by the run lookup; do not describe
this as a proven environmental failure or claim broad validation passed.

CLI scope checks meet wp1 acceptance. PRs stay draft while broader evidence is
unresolved; wp4 owns each published head's CI and any task-regression repair.
Raw logs live in `.tmp/cli-ux/wp1-*`; QA artifacts are under the session's ignored
evidence directory. This record deliberately preserves the failing gate.

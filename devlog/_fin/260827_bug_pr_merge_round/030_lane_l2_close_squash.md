# L2 — close + squash-merge

Member: #2663.

## #2663 — bridge code-mode helpers through exec

528 added / 68 deleted across 12 files, author Eleven-is-cool, marked review-ready with
all five checks green. It compiles clean (`TYPECHECK_OK`, see 000).

Files: `src/bridge.ts`, a new `src/responses/code-mode-helper-compat.ts`,
`src/responses/custom-tool-compat.ts`, `src/server/responses-custom-tool-repair.ts`,
`src/server/responses/core.ts`, `src/types/tools.ts`, plus six test files including two
new ones (`legacy-shell-compat.test.ts` +93, `responses-custom-tool-repair.test.ts`
+126) and a substantial extension of `responses-undeclared-tool-guard.test.ts`.

Why L2 and not L1: the change is broad enough that its value is in the squashed
summary, and it touches `src/server/responses/core.ts` — the shared request path.
Landing it as one reviewed commit with a written rationale gives the history a single
revert point, which a 12-file merge commit from a contributor branch does not.

Why it lands at all: the tests are real (they exercise the repair and guard paths, not
just the happy path), it compiles at its head AND in the merged tree, and the defect
class — a provider emitting a bare helper call instead of the code-mode `exec` wrapper
— is the same class #2694 tried and failed to address.

Do NOT cite "CI is green" for this PR. It ran the same five non-compiling checks as
#2694 (CodeRabbit, enforce-target, hygiene, label, resolve-pr); none of them build or
test anything. See 005, correction 3. The full suite on the merged tree is the only
behavioral evidence this PR will have, so it is mandatory before the squash.

## Sequencing consequence

Landing this changes the answer for #2694. Re-evaluate #2694 only after this is on dev:
if the general bridge already handles the bare `exec_command` case, #2694 becomes NOOP
and closes with a pointer to this sha.

## Gate

Shared runtime is touched, so the full suite must be green before the squash lands.
Run it on `ssh lidge-ai` via `ocx-run`. Then close #2663 with a comment naming the
squashed dev sha and crediting the author.

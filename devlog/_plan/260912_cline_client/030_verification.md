# Independent audit and final hosted tip

Depends on surfaces. Audit all acceptance rows against final source and tests; use a fresh inherited read-only subagent (no local tests/build/install, no user data or writes). Fold correct findings into code and docs in this cycle; add further cycles if a new implementation unit is needed. Security analysis stays in .tmp/cline.

MODIFY only files implicated by concrete findings. git diff --check is whitespace evidence, never test evidence. Commit scoped source and docs; git push --no-verify origin HEAD. Create ordinary PR with base dev (or actual parent branch if audited split), filling Summary/Verification/Checklist and linking #4214 without claiming unresolved acceptance. No original PR exists; no carried author identity invented.

Read current head/base/reviews and CI workflow event/ref. Track final cumulative SHA through hosted Cross-platform CI; record run URL/ID, actual head and check results. Do not cancel runs or modify workflow/protection. Fix attributable final failures and repeat at the resulting head. No suite can be hidden in a receipt helper; receipt can capture permitted source checks or read-only GitHub CI verification, labeled accurately.

MODIFY .tmp/cline/handoff.md immediately after each deliverable: worktree/branch, PABCD cycle/phase, PR URL/full head SHA/order, issue disposition, remaining acceptance, attribution, hosted run evidence, NOT RUN local checks and unresolved reviewer findings. Final completion requires all recorded criteria; CI pending is not success. Parent performs all merges and decides issue closure.

Verification P resumes 029's next direction. Concrete private audit repair plan is .tmp/cline/repair-plan.md; final source proof must include strict recovery metadata and history reads. Two accepted independent findings are being corrected before publication. This cycle retains all original CI, source, rollback and handoff criteria.

Source review also found the shared export dialog described every download as a single native file. The Cline branch now uses localized two-document merge instructions and download announcement, and suppresses the irrelevant missing-key hint. Other clients retain their existing copy. A rendered component regression in client-config-panel.test.tsx covers this conditional branch on hosted CI. This is a correctness fix to the existing export surface, not a new export mechanism.

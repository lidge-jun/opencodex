# WP12 — #340 verify + merge #393 (110)

PR #393 `fix(gui): portal select dropdowns to avoid clipping` closes issue #340
(Claude settings Search/Vision Sidecar dropdowns clipped by container boundary).
State: draft=true, MERGEABLE/UNSTABLE (windows-latest CI pending at plan time;
other jobs green).

Files (GUI-only): `gui/src/select-position.ts` (+98 new),
`gui/src/pages/ClaudeCode.tsx` (+3), `gui/src/styles.css` (+2),
`gui/src/ui.tsx` (+74/-17), `gui/tests/select-position.test.ts` (+117 new).

GUI boundary: user explicitly authorized this GUI merge (#393/#340 in scope).
Approach: portal the select dropdown out of the clipping container and position
it with `select-position.ts` (flip-up near viewport bottom).

Actions:
1. Wait for windows-latest CI (re-check). Require all green.
2. Verify: `bun run build:gui` + `bun run lint:gui` green; inspect
   select-position test coverage; render-grounding at ~320px/736px if feasible.
3. A-gate: Sol reviewer confirms portal cleanup on unmount, flip logic, no
   z-index/focus regressions.
4. `gh pr ready 393` then `gh pr merge 393 --squash` to dev; #340 closed.

Terminal: DONE = merged SHA + #340 closed. BLOCKED if windows CI fails.

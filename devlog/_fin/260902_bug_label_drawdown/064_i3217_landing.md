# 064 — i3217 landing

- PR #3224 `fix(responses): keep the reserved functions group intact for codex-spark (#3217)`, branch `codex/260902-i3217-spark-functions-namespace`, head `21b73c22b`.
- Admin squash-merge → `d23eab43a` on `dev`; `git merge-base --is-ancestor d23eab43a origin/dev` exit 0.
- #3217 closed as completed with the cause, the SHA, and the interim install path.
- Root cause was proven, not inferred: a tap on a dev proxy built from this tree recorded the flattened outbound group and the `namespace:"exec"` answer; the same tap with the fix recorded the group intact and a bare `exec` answer, and the `codex exec` turn ran `pwd` (0 `execexec`, previously 25 per minute).
- Audit: reviewer (xai/grok-4.6) pass; residual "no stream:false case" closed in B before C.
- Checks: focused set 267 pass / 0 fail (receipt), `bun run test:changed` 5794 pass / 0 fail across 301 files, typecheck and privacy:scan clean. Red-without-fix proven for both new tests.
- Trailing CI on `dev` for `d23eab43a` tracked in `regaudit2`.


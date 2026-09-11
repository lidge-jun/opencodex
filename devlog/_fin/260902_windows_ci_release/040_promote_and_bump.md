# 040 — Promote and bump

Preconditions: dispatch CI green on the dev tip incl. Windows; service-lifecycle.yml green on the
same SHA; regression audit recorded. Read `scripts/release.ts` before running (it accepts only
main/preview and pushes even without --publish). Use a dedicated clean worktree with root + gui
`bun install`. Promote dev → preview (prerelease) → main (stable) per the helper; if a gate fails
after the bump push, rerun once then manual `release.yml` with `expected-sha`.

Proof: `npm view @bitkyc08/opencodex dist-tags --json` + `gitHead`, `gh release view`,
`git ls-remote` for preview/main tips. Then `scripts/bump-dev-version.ts` for the next minor on
dev via PR, admin merge, is-ancestor proof.

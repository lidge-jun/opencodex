# wp1 — #4202: global pnpm installations cannot self-update

Work-phase 1 of the L4 lane. Base: `origin/dev` after #4226 and #4227 landed. Carried source:
PR #4203 by `oliver-mee`, head `e74c6e54d`, two commits on base `f94dd88f1`.

## What the issue asks for

`ocx update` on a pnpm global installation forwards npm-only flags (`--allow-scripts=bun`,
`--no-audit`, `--no-fund`) to pnpm, which rejects them. The failure lands **after** the proxy has
already been stopped. #4202 asks for either a pnpm-native global update path or a safe actionable
error raised before the proxy is stopped.

## Keep-set, verbatim from the packet

31 of the carry's 36 files. Kept: `bin/ocx.mjs`, `src/cli.ts`, `src/cli/launcher-context.ts`,
`src/config/pending-teardown.ts`, `src/lib/bun-runtime.ts`, `src/lib/package-tree-integrity.ts`,
`src/service.ts`, every file under `src/update/`, the seven carried tests, the two test-layout maps,
and `docs-site/src/content/docs/getting-started/installation.md`.

Dropped, because L4 does not own them: `README.md`, `structure/01_runtime.md`,
`structure/06_docs-and-release.md`, `docs-site/src/content/docs/getting-started/for-agents.md`,
`docs-site/src/content/docs/reference/cli/lifecycle.md`.

`git diff f94dd88f1..e74c6e54d` restricted to the keep-set is 3676 lines and
`git apply --check` reports no conflict against the rebased branch: no keep-set path moved on
`dev` between the carry's base and the current tip.

## The blocking finding this work-phase must fold in

`Ingwannu` (repository owner) requested changes on #4203:

> In src/update/transactional-install.mjs, verifyInstallTree now delegates to
> dependencyPackageDir/createRequire.resolve. That resolution can find dependencies in ancestor
> node_modules outside the candidate package tree. […] A candidate missing its own bundled Bun or
> sentinel dependency must not pass merely because an ancestor installation supplies one; otherwise
> staging/boot recovery can call a non-self-contained candidate healthy and discard or replace the
> known-good copy.

The finding is structural, not stylistic. In the carry both exported verifiers are the same
function: `verifyInstallTree` and `verifyPnpmInstallTree` each call
`verifyInstallTreeWithDependencyRoot`, which resolves `bun` and the sentinel deps through
`createRequire(...).resolve`. Node's resolution walks the ancestor directory chain, so for a global
npm layout a candidate at `<prefix>/lib/node_modules/@bitkyc08/opencodex` can satisfy its bun
requirement from `<prefix>/lib/node_modules/bun`, which belongs to a different package.

Three decisions consume that boolean, all on the npm path:

- `transactional-install.mjs:198` accepts the staged tree (D2, before the swap).
- `transactional-install.mjs:241` re-verifies the live tree after the swap and decides rollback.
- `transactional-install.mjs:121`, inside `bootRestoreProbe`, decides that the live tree is healthy
  and **reaps every backup**, which is the only known-good copy.

So an over-permissive verdict is not cosmetic: it can accept a stage that cannot start, then delete
the backup that would have recovered it.

## Plan

1. Apply the keep-set diff unchanged.
2. Split the verifier in `src/update/transactional-install.mjs` into two real implementations that
   share the manifest checks but not the dependency-resolution policy:
   - `verifyInstallTree` (npm, and every caller above) returns to the strict pre-carry rule: a
     sentinel dependency counts only at `<packageDir>/node_modules/<name>/package.json`, and the
     bun size gate reads only `<packageDir>/node_modules/bun`. Ancestor resolution cannot satisfy it.
   - `verifyPnpmInstallTree` keeps resolver-based discovery, because pnpm legitimately exposes
     dependencies through a virtual store, a package-root symlink, or a hoisted group root, but adds
     the ownership check the review asked for: the resolved dependency must live under a dependency
     root that this package instance owns — its own `node_modules`, its realpath's `node_modules`,
     or the `node_modules` that encloses the package when that root carries pnpm's own metadata
     (`.pnpm` or `.modules.yaml`). An ancestor root with no pnpm evidence is refused.
3. Regression test at `tests/update/update-tree-ownership.test.ts`, registered in
   `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`, covering the
   three cases the review named: a candidate missing its own bun with an unrelated ancestor bun
   present, a truncated candidate bun with an intact ancestor bun, a legitimate pnpm virtual-store
   and hoisted layout, and the `bootRestoreProbe` decision — the probe must restore the backup
   rather than reap it when the live tree is not self-contained.
4. Commit with a `Co-authored-by` trailer for `oliver-mee`, push with `--no-verify`, open the PR
   against `dev` with `Closes #4202`.

## Diff level

`src/update/transactional-install.mjs` ~60 lines changed on top of the carry; one new test file;
two one-line map registrations. Everything else is the carry verbatim.

## Not run

`bun test`, `bun run test`, `bun run test:changed`, `bun run typecheck`, `bun run build:gui` and
`bun install` are NOT RUN by operator instruction. Hosted CI on the exact pushed head is the only
product evidence this round accepts.

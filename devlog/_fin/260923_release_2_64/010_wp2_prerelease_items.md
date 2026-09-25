# 010 — wp2: pre-release items

## A. tauri-plugin-shell 2.2.1 on dev

Dependabot opened #5525 against `main`, the default branch. `dev` is the integration
branch, so the same commit is carried to `dev` and reaches `main` through promotion.

Branch `codex/260923-tauri-plugin-shell-2.2.1` from `origin/dev` in a scratch worktree:

```bash
git fetch origin pull/5525/head:refs/remotes/origin/pr-5525
git switch -c codex/260923-tauri-plugin-shell-2.2.1 origin/dev
git cherry-pick -x d6dea8f246944677c8ce80264c66095b562e3deb
```

Resulting diff (exactly two files, four lines):

```diff
--- a/desktop/src-tauri/Cargo.toml
+++ b/desktop/src-tauri/Cargo.toml
-tauri-plugin-shell = "=2.2.0"
+tauri-plugin-shell = "=2.2.1"
--- a/desktop/src-tauri/Cargo.lock
+++ b/desktop/src-tauri/Cargo.lock
 name = "tauri-plugin-shell"
-version = "2.2.0"
+version = "2.2.1"
 source = "registry+https://github.com/rust-lang/crates.io-index"
-checksum = "bb2c50a63e60fb8925956cc5b7569f4b750ac197a4d39f13b8dd46ea8e2bad79"
+checksum = "69d5eb3368b959937ad2aeaf6ef9a8f5d11e01ffe03629d3530707bbcb27ff5d"
```

The lock hunk was produced by the dependency tool, not by hand, and the dependency list
of the package is unchanged, so no other lock entry moves.

PR to `dev`, filled from the repository template, with a `Co-authored-by` trailer for
the Dependabot author because the description names the carried PR. Push with
`--no-verify`, then dispatch the full lane on the PR branch:

```bash
gh workflow run ci.yml --ref codex/260923-tauri-plugin-shell-2.2.1 -f lane=all
```

A pull-request event alone would also run `desktop shell` (`desktop/**` matches both the
`ci` and `native` filters in `.github/workflows/ci.yml`), but the dispatched lane=all run
also builds the macOS bundle and the widget, which link the same crate graph.

Acceptance:

- `desktop shell` (`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`),
  `platform-macos` and `widget` jobs succeed at the exact PR head in the lane=all run,
  and the `ci` aggregate succeeds.
- Merge with `gh pr merge <n> --admin --squash --match-head-commit <head>` after a clean
  `git merge-tree` against the current `origin/dev`.
- After merge, `git show origin/dev:desktop/src-tauri/Cargo.toml` pins `=2.2.1`.
- #5525 is closed with a note once `main` carries the bump (wp4), because Dependabot
  targets `main` and would otherwise stay open.

## B. Security reviews of the unreviewed batch

`MAINTAINERS.md` asks for explicit security review of changes to GitHub Actions workflows,
release automation and credential handling. Seven merged PRs had no review record:

| Review | PRs | Surface |
|---|---|---|
| S1 | #5471 | PR quality gate script run by a `pull_request_target` workflow |
| S2 | #5456, #5653 | Bun batch runner; `ci.yml` and `release.yml`, release preflight |
| S3 | #5469 | privacy-scan gating in `ci.yml` |
| S4 | #5024, #5654, #5655 | request-owned account routing; remote workspace helper protocol |

Each review is read-only against the merged code on `dev` and is written to scratch
space, not to this unit. Disposition rules:

- A blocker or major finding counts only after a second, independent reviewer reproduces
  it from source (file and line, concrete trigger). A finding the second reviewer cannot
  reproduce is rebutted with the reason recorded in scratch. The second reviewer also
  states whether the batch introduced it and whether it reaches a release artifact.
- A confirmed blocker or major gets a focused fix PR to `dev`, designed at diff level in
  its own numbered doc (011, 012, ...), reviewed the same way and merged at a green exact
  head before the candidate is fixed in wp3. If a fix cannot be made inside this round,
  the round stops as BLOCKED rather than releasing. Once a fix has shipped, its doc is the
  public record; until then the doc describes only the change and its tests.
- Minor and informational findings are recorded for follow-up and do not gate the release.

This unit's D summary states only which reviews ran and whether any finding gated the
release; details of an unfixed weakness never enter the tracked tree.

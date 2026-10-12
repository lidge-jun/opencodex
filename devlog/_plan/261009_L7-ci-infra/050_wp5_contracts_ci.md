# 050 — wp5: #6723 CI — catalog-async contracts workflow and Rust diagnostics

PR title: `ci: add portable catalog-async contract checks and a Windows liveness diagnostic`
Branch `codex/l7-catalog-async-contracts-ci`, worktree `.tmp/lanes/L7-ci-infra-5`, after
wp4. Opened as **draft**. Credit: `Co-authored-by` mashfromband (commit identity from the source PR).

## File change map (from #6723 head `9149843fc6`)

| Path | Kind |
| --- | --- |
| .github/workflows/catalog-async-contracts.yml | NEW |
| scripts/diagnostics/windows-version-control/{Cargo.toml,Cargo.lock,README.md} | NEW |
| scripts/diagnostics/windows-version-control/src/{main.rs,control.rs,fixture.rs,process.rs} | NEW |
| scripts/diagnostics/windows-version-control/tests/async_contracts.rs | NEW (ACL, abort and catalog contracts; depends on wp1 and wp4 exports) |
| tests/ci-workflows/cold-spawn-warmup.test.ts, tests/helpers/cold-spawn-warmup.ts | #6723 warm-up attribution hunks, if not already needed by wp4 |
| structure/ops/cross-platform-ci.md, structure/ops/docs-and-release.md, structure/catalog.md | workflow sentences only |

## Security review (required before ready)

Workflow facts from r3: `permissions: contents: read` (:22-23), actions pinned to full SHAs
(:35, :41), `persist-credentials: false` (:37), no `pull_request_target`, no secrets, no
untrusted interpolation found. The A reviewer re-reads the YAML and every `run:` step,
the Cargo dependency set and lockfile sources, and confirms the Windows controller does not
run in CI (`async_contracts` only). The hygiene gate's `unsponsored_surface` label needs a
maintainer decision; L7 records the review and leaves the PR in draft.

## Acceptance

- Local (cargo present at `~/.cargo/bin/cargo`; `cargo-nextest` is not installed, so use the
  workflow's command): `cargo test --locked --manifest-path scripts/diagnostics/windows-version-control/Cargo.toml --test async_contracts -- --test-threads=4`;
  `cargo fmt --check --manifest-path scripts/diagnostics/windows-version-control/Cargo.toml`
  (requires the `rustfmt` component; if absent, record it and rely on CI); `bun run structure:check`.
- Docs scope: the Bun coverage references written by wp1/wp4 stay. wp5 adds Rust coverage
  sentences only inside its declared files (`structure/ops/cross-platform-ci.md`,
  `structure/ops/docs-and-release.md`, `structure/catalog.md`).
- Hosted: the new workflow green on Linux/macOS/Windows at exact head, plus Cross-platform CI.

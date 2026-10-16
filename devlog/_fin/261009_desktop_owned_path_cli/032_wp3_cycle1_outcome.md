# 032 — wp3 cycle 1 outcome: PR 1 review fixes

PR 1 (#6816) head a1326ccccd. Fix commits: 9c7a9e86fc (R1–R5, S1–S2 by W6 `01a11fc0-569d` and W7 `01a11fc0-57aa`), bcbf48d (exact unprotected-root test on Windows), 1f948d295f (structure doc, 600/600), a1326ccccd (R3 regression: every enabled reconcile observes the current bundle).

## Reviews

| Reviewer | Round 1 (bcbd0363be) | Final |
|---|---|---|
| Code (`01a11fad-f914`) | FAIL: R1–R3 P1, R4–R5 P2 | 1f948d295f: R1–R5 resolved, new P1 (stored record skipped bundle observation); a1326ccccd: **PASS** |
| Security (`01a11fad-f9e1`) | FAIL: S1–S2 P1 (inherited ACLs on private files; rc rewrite dropped ACLs) | 1f948d295f: **PASS** (macOS ACL return conventions, Linux xattrs, Windows owner/protected DACL/NULL DACL/allowed SIDs, icacls absolute path without shell and with timeout, fixed log codes) |

## Evidence

| Check | Result |
|---|---|
| macOS `cargo fmt --check` / `clippy --all-targets -D warnings` / `cargo test` | 0 / 0 / 246 passed, 2 ignored |
| macOS `cargo test real_shell -- --ignored` | 1 passed (real zsh and bash) |
| Windows 11 `mini` `clippy --all-targets -D warnings` / full `cargo test` | 0 / 188 passed (includes native DACL checks, NULL DACL refusal, root/child reopen) |
| `bun test` desktop CLI, update and startup surface | 43 pass |
| A11 compiled check (AM-13): host standalone CLI from `scripts/build-standalone.ts`, shim rendered by `render_shim_for_compiled_cli`, `claudeCode.enabled:false` (native route), fake `claude` printing protected names only, cwd `.env` with `ANTHROPIC_BASE_URL` | Shim + exported `ANTHROPIC_AUTH_TOKEN` → present; compiled CLI directly (control) → absent; shim + exported `ANTHROPIC_BASE_URL` → present; shim with `.env`-only `ANTHROPIC_BASE_URL` → absent. A11 verified. |

The A11 check initially failed to render the shim under `/tmp`: on macOS `/tmp` is a symlink, and the file writer refuses symlinked ancestors, as designed. The check ran under a regular directory instead.

## Still open (wp4)

PR 2 review findings (security P1: record reader does not check owner/permissions/symlinks; code P2: FIFO record blocks the reader), rebase of both PRs onto `dev` after #6807 (merged 32abcc363d) and #6809, PR 1 GUI screenshot, exact-head CI, admin merges.


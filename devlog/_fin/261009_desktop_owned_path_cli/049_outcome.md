# 049 — wp4 outcome: both PRs on `dev`

## Landed

| PR | Squash on `dev` | Exact-head evidence |
|---|---|---|
| #6816 Desktop owns the `ocx` terminal command on PATH | b89bbfb083 | head 2103c18b4f (rebased on #6820 bb36029ef9). Cross-platform CI 37922442745 success on attempt 2: `macos 1/2` failed on the inherited codex-prompt-lock contender deadline (fixed on `dev` by #6808) and `windows 8/9` on an AUTH-11 15 s runner timeout; only those two jobs were rerun. Service lifecycle 37922442829 success on all three hosts. Combined tree `dev`+#6808+#6816: typecheck, structure:check, ratchet and layout guards pass. |
| #6818 Package launchers hand off to the Desktop `ocx`; status/doctor report PATH selection | this PR | Retargeted to `dev` after #6816 and rebased with `--onto`; final evidence is recorded on the PR. |

Admin squash merges under the maintainer instruction to integrate through admin review on `dev`. Code and security reviews passed for both PRs (031, 032 and the PR 2 rounds recorded in 040).

## Late fix in wp4

The CI-only failure of `disabled pending cleanup warns without selecting a target` (Linux `test 4/4`, `windows 9/9`) came from the test, not the reader. It reads a macOS record on every host, so Linux ran the macOS-only `ls -lde` ACL probe and Windows reported NTFS modes the POSIX owner/mode check rejects; both returned `record-unsafe`. The test now passes the same host-safe stats seam the handoff suite already uses and hands the read to the diagnostics. Verified on macOS and on Windows `mini` (13 pass, 2 skip).

A `dev` regression from #6811 (`ocx stop` failing with `realpath ENOENT` when `~/.codex` is absent) held PR 1's Service lifecycle jobs red until lane L2 landed #6820.

## Criteria

| Criterion | Evidence |
|---|---|
| c1 app-only install gets `ocx` on PATH (macOS, Windows; deb unchanged) | #6816 Rust installer, shim and PATH writers; cargo tests on macOS (246) and Windows (191) |
| c2 Desktop `ocx` first in a new login shell; Windows user PATH order | rc-block ordering tests, `real_shell` ignored test (zsh, bash), HKCU Path order tests |
| c3 launcher handoff with recursion guard and escape hatch | #6818 `ocx-launcher-desktop-handoff.test.ts`, real-launcher smoke |
| c4 foreign-file refusal, idempotence, opt-out cleanup | Rust record/journal tests and TS record-reader safety tests |
| c5 local gates and exact-head CI | typecheck, structure:check, focused bun tests, cargo test/clippy, privacy:scan; CI above |
| c6 independent sol code and security review PASS | 032 and 040 |
| c7 admin squash merge with docs | b89bbfb083 and this PR, docs-site installation and CLI reference |

## Not verified here

Packaged-app click-through of the CLI page, fish on a real login, the Linux deb path, and Windows terminal pickup after a real registry write in a fresh session are left to release QA. No release, version bump, or promotion was done.

# 040 — wp4: land both PRs

wp4 takes PR 1 (#6816) and PR 2 (#6818) from review-complete to merged on `dev`. It fixes PR 2's review findings, rebases both PRs over lane L1's merged and pending launcher work, adds the GUI screenshot PR 1 needs, waits for exact-head CI, and admin-merges in stack order.

## Current state

- PR 1 head a1326ccccd + devlog commit 1cf9eada5c: code and security review PASS; merges cleanly into `origin/dev` (32abcc363d, after #6807).
- PR 2 head 53c2de3241 on the old PR 1: code review NEAR-PASS (P2), security review FAIL (P1). Against current `dev` it conflicts only in `structure/runtime.md` (with #6807); `bin/ocx.mjs`, `installation.md` and `service-and-sidecars.md` auto-merge.
- #6809 (L1) is open at f8fa8c5465 and also edits `bin/ocx.mjs`; it is rebasing onto #6807.

## PR 2 fixes

| # | Finding | Fix | Test |
|---|---|---|---|
| P2-S1 (security P1) | The record reader follows symlinks and accepts a record or directory writable by others, so a same-machine attacker who can write there chooses what `ocx` executes | POSIX: `lstat` `~/.opencodex-desktop` and `cli.json`; both must be owned by the effective uid, neither may be a symlink, and neither may have group or other permission bits (`mode & 0o077 === 0`, matching the writer's 0700/0600). Open with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, then `fstat` the descriptor and require a regular file with the same `dev`/`ino` as the `lstat`. Any failure is `record-unsafe` (new issue code, handled like the other errors: AM-2 message, no handoff). Windows: refuse when the directory or the record is a reparse point (`lstat().isSymbolicLink()` or a junction); ACL ownership is not read in the launcher hot path. The Desktop writer hardens and verifies this directory's protected DACL on every launch (031 S1), and the residual is stated in PR 2 | Unit tests on a temp HOME: mode 0666 record, 0777 directory, record symlink, directory symlink, foreign owner (skipped unless running as root, with a printed reason), each → `record-unsafe` and no spawn; valid 0700/0600 → `ready` |
| P2-C1 (code P2) | A FIFO at `cli.json` blocks `openSync` forever | Covered by `O_NONBLOCK` + regular-file check above | Subprocess test with `mkfifo` and a 2-second timeout → `record-unsafe` or `record-invalid` returned promptly |

The diagnostics (`status`/`doctor`) use the same reader and report `record-unsafe` as FAIL with the path.

## Rebase and order

1. PR 1: rebase `codex/desktop-owned-path-cli` onto the latest `origin/dev` (clean today), push, and wait for exact-head CI.
2. PR 2: rebase `codex/desktop-cli-handoff` onto the rebased PR 1, resolve `structure/runtime.md` by keeping #6807's text and re-applying this PR's single-row change at zero line growth, re-run the launcher, managing-cli, handoff and diagnostics tests, then push.
3. If #6809 lands first, PR 2 rebases again over it; `bin/ocx.mjs` anchors are `const codexCliUpdateInspection` and the mise `if`.

## PR 1 screenshot

PR 1 changes `gui/`, so `enforce-target` requires a screenshot. Start an isolated proxy from PR 1's tree (`OPENCODEX_HOME` and `HOME` in a temp directory, an unused port), open the dashboard in headless Chrome with a user agent that contains `OpenCodexDesktop/2.82.0` so `isDesktopShell()` is true, and capture the sidebar showing "Terminal command" next to the Desktop update row. Upload the image to the `pr-assets` branch and link it by commit SHA in PR 1's description (AGENTS.md). Also attach the rendered `cli.html` screenshot from wp1.

## Merge

1. PR 1: all non-policy checks pass on its exact head, both reviews PASS, merge-tree clean → admin squash merge with `--match-head-commit`; mark ready first.
2. PR 2: retarget to `dev`, rebase so PR 1's commits drop out, push, both reviewers re-check the fix commits and return PASS, exact-head CI → admin squash merge.
3. After both: update the goalplan criteria with evidence, write `049_outcome.md`, and close the goal.

## C checks

PR 2 focused tests (handoff, diagnostics, launcher runtime/source, managing-cli, status JSON, doctor, layout), `node --check bin/ocx.mjs`, typecheck, structure, privacy, ratchet; the real-launcher smoke from 021; exact-head CI for both PRs; merge SHAs on `dev`.


## Reflection (same architect, 01a11f35): MISALIGNED → dispositions

These replace the matching parts above.

- **Windows: no package-launcher handoff.** Reading the current owner and DACL from the Node launcher needs a PowerShell/.NET or native helper call on every `ocx` invocation, and trusting the writer's last verification does not cover a launcher that runs before Desktop or after Desktop refused an unsafe state. On Windows the reader still runs for `status`/`doctor` diagnostics, but `planDesktopCliHandoff` returns "continue" (no handoff) on `win32`. The Windows path to the Desktop CLI is the user `Path` entry from PR 1, which puts the Desktop install directory ahead of `%APPDATA%\\npm` in new shells. PR 2's description and the installation page say so. Test: on a simulated `win32` platform a valid record produces no spawn.
- **POSIX reader order and checks.** Safety checks run before any JSON parsing or disabled/pending interpretation: `lstat` of `~/.opencodex-desktop` must be a real directory (not a symlink), owned by the effective uid, `mode & 0o077 === 0`; `lstat` of `cli.json` must be a regular file, not a symlink, same owner, `mode & 0o077 === 0`; open with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`; `fstat` must report a regular file with the same `dev`/`ino`, owner and mode bits as the `lstat` (replacement between `lstat` and `open` fails). macOS extended ACLs: `/bin/ls -lde <dir> <file>` (absolute path, no shell, 1-second timeout) must list no ACL entries; any entry or a failed or timed-out check → `record-unsafe`. Linux: a POSIX ACL shows up in the group bits (mask), which the mode check already refuses; no extra call. Platform/kind, path rules, 64 KiB, disabled-over-pending stay as before. `.d.mts` issue union and the diagnostics' issue list gain `record-unsafe`.
- **Tests.** Added: directory symlink, record symlink, 0666 record, 0777 directory, record replaced between `lstat` and `open` (simulated through the injected fs seam), FIFO with a 2-second timeout, macOS ACL entry on the directory and on the record (`chmod +a` on temp paths; skipped off macOS with a printed reason), valid 0700/0600 → `ready`.
- **Rebase review.** After auto-merging `bin/ocx.mjs` with #6807 (and #6809 if it lands first), compare the proof factory, the maintenance/update exceptions and #6807's PATH Bun fallback against both parents, then rerun the launcher runtime/source, handoff, managing-cli and smoke checks.
- **Merge gate for these two PRs.** Every check on the exact head passes, policy checks included (`enforce-target`, PR hygiene); a queued policy check is rerun and waited for instead of being treated as an exception. `--match-head-commit` and a fresh `merge-tree` against the latest `dev` immediately before each merge.
- **Screenshot.** Taken from PR 1's merge-candidate GUI build; the PR text says the Desktop shell was simulated with a user-agent override, so it shows the sidebar entry only, not Tauri navigation.
- **Close-out.** `049_outcome.md` records the post-merge `dev` CI result and the remaining packaged/native QA items (packaged click-through, fish, Linux deb, Windows terminal selection after a real registry write).


## Audit (independent, 01a11f6b): NEAR-PASS

Folded: Windows returns "continue" before any record read or target check, with tests for valid, unreadable and unsafe records; reader fixtures are written with explicit 0600 files in 0700 directories, and foreign ownership is also tested through the injected stat seam; the FIFO test passes only when the reader returns a refusal within the time limit (a timeout is a failure); Windows handoff expectations, the installation page and the CLI reference are updated together; the screenshot is embedded as an image in PR 1's description; after PR 1's squash, PR 2 is rebased with `git rebase --onto origin/dev <old PR 1 head>` and re-reviewed and re-tested on its final head. Current red checks (PR 1 `enforce-target` for the missing screenshot and `test 2/4`; PR 2 `ci`) are inspected and fixed or rerun before any merge.


## B finding: no child-process kill in the desktop shell

PR 1's CI (`test 2/4`) failed `tests/clients/desktop-exit-ownership.test.ts` "no file in the shell kills the runtime process": the shell sources must not contain `.kill()`, and the `icacls` timeout in `cli_command_windows.rs` killed its child. The invariant stays. The Windows hardening is rewritten to set the DACL natively instead of running `icacls`: build an ACL with `InitializeAcl` and `AddAccessAllowedAceEx` (`OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE` on directories) for the token user SID (full control), SYSTEM and Administrators, then `SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, ...)`, then the existing native verification. No child process, no trusted executable path, no timeout. Tests on `mini` stay as they are (hardened root, unprotected root, NULL DACL, extra Everyone ACE, root/child reopen). The security reviewer re-checks this change.


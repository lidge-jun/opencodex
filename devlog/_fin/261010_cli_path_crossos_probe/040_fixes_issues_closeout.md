# 040 — wp4: fixes, issues and closeout

Each defect found in wp2/wp3 becomes a PR to `dev` (focused tests on the host where it reproduces, exact-head CI,
independent Sol review) or an issue when it needs a design decision. PR branches are cut from `origin/dev` in
`.tmp/lanes/<lane>` inside this worktree. PRs follow `.github/PULL_REQUEST_TEMPLATE.md`; issues use the matching
`.github/ISSUE_TEMPLATE/*.yml` headings.

## Known before the probes

| ID | Finding | Evidence | Disposition |
|---|---|---|---|
| F1 | `cli_command_record::tests::final_save_before_journal_deletion_is_cleaned_on_reopen` failed once on Linux with `lock-busy` (1 of 4 full `cli_command` runs on lidge; isolated 5/5 pass). `lock()` (`cli_command_record.rs:536`) takes `flock(LOCK_EX\|LOCK_NB)` once. Hypothesis at the time (never confirmed): a child forked by a parallel test briefly shares the lock's open file description until exec, so a drop-then-reopen sees the lock still held. | lidge cargo log | Superseded after wp2: not reproduced in 60 runs and no lock holder captured, so no PR and no issue (see "After wp2") |
| F2 | Windows has no Desktop-supervision detection: #6802 authority, #6809 refusals and #6818 handoff never engage, so a package `ocx stop`/`service install`/`update` can act against a Desktop-owned runtime | 020 W7/W8 | Issue (feature proposal): Windows process-identity proof for the Desktop child (parent PID + image path via `QueryFullProcessImageNameW`/toolhelp snapshot), equivalent to the Linux `/proc` checks |
| F3 | Machine Path npm (nvm4w, Program Files nodejs) always beats the HKCU entry; Desktop reports `partial` but the npm `ocx` stays selected and, without a handoff, can be far older than the Desktop | 020 W3/W4 | Issue or docs PR depending on W4 evidence |

Further rows are appended from the probe results. Closeout records PR/issue links, head SHAs, CI run ids, review
verdicts and the host revert table.

## Reflection dispositions

- F1 stays a hypothesis until wp2 captures the lock holder (010 dispositions); the PR follows that evidence.
- F2 is about supervision only; the Windows handoff being PATH-only is a separate, deliberate design choice and is
  described as such.
- F4 (candidate): on Linux, a package launcher that cannot run names no Desktop CLI because `findDesktopCli` is
  macOS-only (`src/lib/bun-path-runtime.mjs:79`), even though the deb ships `/usr/bin/ocx`.

## After wp2

- F1: not reproduced in 60 runs; no PR. Mentioned in the closeout as an unexplained single failure.
- F4: confirmed (`Bun binary missing after install attempt.`); follow-up rather than a fix, see 019.
- F5 (new, fixable): `real_shell_selects_desktop_shim_on_temp_home` requires exactly two stdout lines from
  `bash -l -i`, which fails on stock Ubuntu for any sudo-group user because `/etc/bash.bashrc` prints the sudo hint.
  PR: emit sentinel-prefixed lines (`printf 'OCX-PATH:%s\nOCX-OUT:%s\n' ...`) and assert on those lines only.

## After wp3

| ID | Disposition |
|---|---|
| F2 | Confirmed live (029 W7/W8). Issue (feature proposal): Windows Desktop-supervision detection from `Win32_Process`-equivalent facts (parent PID, both image paths under the install directory, session, creation time, two agreeing snapshots), so #6802 authority and #6809 refusals apply; PATH-only handoff stays a separate decision. |
| F3 | Superseded by F7: on mini the Desktop `ocx` does win in new terminals. |
| F4 | Holds on Linux and Windows; folded into the F2 issue as a related follow-up (name the Desktop CLI in launcher failure text off macOS). |
| F6 | PR: compute the expected rendered path with `windowsEnvIndirectBatchValue` in the three assertions. |
| F7 | Issue (bug): `machine-path-conflict` false positive; evaluate Machine `Path` as a fresh logon environment does (e.g. `CreateEnvironmentBlock` with `bInherit = FALSE`) instead of `ExpandEnvironmentStringsW` in the Desktop process. |

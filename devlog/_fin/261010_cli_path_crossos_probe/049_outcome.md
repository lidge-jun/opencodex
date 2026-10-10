# 049 — Outcome: the desktop-owned CLI path on Linux and Windows

The macOS-built CLI path work (#6802, #6807, #6809, #6812, #6816, #6818) was probed on real hosts: Ubuntu 24.04 (`lidge`)
and Windows 11 build 26200 (`mini`). Every tested Linux path works, including the deb path and real fish/bash logins. On
Windows the PATH writer and new-terminal pickup work, but nothing in the CLI recognises the Desktop as the runtime's
supervisor, and the Desktop's own conflict check reports a false positive. Two test defects that only appear off CI were fixed by #6852 and #6851, merged into `dev` as f2b143baf8 and c35392169c.

## Findings matrix

| Surface | Linux (lidge) | Windows (mini) |
|---|---|---|
| PATH installer (#6816) | works: dev deb in a disposable overlay, `linux-deb` record, shim, five rc blocks exact (019 L3-L6) | works at module level: per-machine install eligible, real HKCU write keeps `REG_EXPAND_SZ`, broadcast settles `notifyPending`, removal restores the raw value byte for byte (029 W3, W6); packaged launch unverified (single instance with the user's live Desktop) |
| New shell / terminal pickup (release QA) | works: real fish login, `fish -l -i`, bash login and `bash -lc` select the shim; non-interactive fish keeps `/usr/bin/ocx` by design (019 L7) | works: Terminal tab with `--reloadEnvironment`, Explorer-launched and Task Scheduler `cmd` select the Desktop `ocx` first (029 W4) |
| Conflict diagnosis | — | broken: `machine-path-conflict` false positive (029 W5) → #6854 |
| Package launcher handoff (#6818) | works for npm-global, `bun link`, linuxbrew shapes; escape hatch; unsafe records refused (019 L8) | by design: PATH-only, no handoff (029 W7) |
| status / doctor / resolve (#6802, #6818) | works with and without a live Desktop, `supervisor.kind: desktop` (019 L9) | broken: `supervisor: unsupported` with a live Desktop child; status/doctor recommend `ocx service repair/restart` (029 W7) → #6853 |
| Refuse-to-compete (#6809) | works: `start` and `service install` refuse; `stop` warns by design (019 L10) | inactive (same cause) → #6853 |
| PATH-Bun fallback (#6807) | works with Bun 1.4.2; failure text names no Desktop CLI (019 L11, F4) | works with Bun 1.4.2; same F4 (029 W10) → follow-up in #6853 |
| Bun preflight (#6812) | — | product path not exercised live; three tests failed on a profile-located Bun → fixed by #6852 |
| Rust `cli_command` tests | 60/60 after one unexplained first-run `lock-busy` (F1, no issue); ignored real-shell test broken on Ubuntu → fixed by #6851 | 27/27, coordinator-reported (raw output not retained) |
| Opt-out via the CLI page | unverified (no GUI operator) | unverified |

## Delivered

| Item | Link | Head / state | Review | CI |
|---|---|---|---|---|
| F5 real-shell test reads marked lines | https://github.com/lidge-jun/opencodex/pull/6851 | `d785fb1b02`; merged as `c35392169c` | Sol 01a122ad: NEAR-PASS → NEAR-PASS → PASS | exact head green: Cross-platform CI 37997020161 (incl. `desktop shell`), Service lifecycle 37997020131, React Doctor 37997020261, `enforce-target`/`hygiene` |
| F6 preflight assertions follow env-indirect rendering | https://github.com/lidge-jun/opencodex/pull/6852 | `f53bf8de1f`; merged as `f2b143baf8` | Sol 01a122ad: NEAR-PASS (body) → PASS | exact head green: Cross-platform CI 37996684810 including Windows shards (changed files passed in `windows 1/9` and `windows 4/9`); `windows 2/9` failed once in the unrelated `claude-desktop-first-party` certificate test and passed on a single-job rerun; React Doctor 37996684793 |
| Windows Desktop supervision (F2, F4) | https://github.com/lidge-jun/opencodex/issues/6853 | open, `enhancement` | — | — |
| `machine-path-conflict` false positive (F7) | https://github.com/lidge-jun/opencodex/issues/6854 | open, `bug` | — | — |

The issues were created through the GitHub connector with bodies identical to what the forms render (`gh` was
unauthenticated and the forms are web-only); the branches and commits were also created through the connector from
locally tested files whose blob hashes were compared before each PR was opened.

## Host state at closeout

- lidge: all probe paths, overlays, namespaces and the probe user gone; `open-codex` still 2.61.0; the user's proxy
  still on `127.0.0.1:10100`; `~/.opencodex-desktop` never created on the real root.
- mini: HKCU `Path` text and kind equal the pre-probe baseline; no probe scheduled tasks, staging directory, temp
  clones or Desktop record; Desktop and sidecar PIDs unchanged. Three of this probe's hung `schtasks /Query` calls
  were stopped. An empty `~/nul` created during the probe window by a Git Bash `2>nul` was removed. A separate CPU
  stress experiment (`ocx-winprobe-tools/eperm.sh`) from another workflow was running and was left alone.

## What did not improve

F1 (one `lock-busy` in the first Linux `cli_command` run) stayed unexplained: 60 later runs passed and no lock holder
was captured, so the fork-inheritance hypothesis is neither confirmed nor refuted. The packaged Windows launch and the
CLI page actions remain unobserved on both platforms.

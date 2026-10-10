# 000 — Cross-OS probe of the desktop-owned CLI path

## Objective

Find out whether the desktop-owned CLI path and install work on `dev` behaves on Linux and Windows the way it was
designed and tested on macOS, and turn every gap into a PR to `dev` or an issue.

The work under test, all squash-merged on `dev` by 2026-10-09:

| PR | Commit | Surface |
|---|---|---|
| #6802 | 01acdc8874 | `ocx status`/`doctor`/`resolve` treat a Desktop-supervised runtime as the authority (`src/service/desktop-supervision.mjs`) |
| #6807 | 32abcc363d | package launcher falls back to a validated PATH Bun; lifecycle version-skew notice (`bin/ocx.mjs`, `src/lib/bun-path-runtime.mjs`) |
| #6809 | 63d87f6370 | `service`/`update`/`start`/`stop` refuse to compete with a Desktop-supervised runtime |
| #6812 | 3b9fc865fa | Windows launchers preflight the selected Bun before baking it in |
| #6816 | b89bbfb083 | Desktop owns the `ocx` terminal command on PATH (`desktop/src-tauri/src/cli_command*.rs`) |
| #6818 | 3618baac41 | package launchers hand off to the Desktop `ocx`; `status`/`doctor` report PATH selection |

The macOS proof is recorded in `devlog/_fin/261009_desktop_owned_path_cli/049_outcome.md`. That note leaves four
items to release QA: packaged click-through of the CLI page, fish on a real login, the Linux deb path, and Windows
terminal pickup after a real registry write. It also records that #6818 deliberately does not hand off on Windows
and that `desktop-supervision.mjs` returns `unsupported` on `win32`, so the #6802/#6809 authority and guards are
inert there.

No release contains #6816 yet: v2.81.0 was published 2026-10-08, before the merge. On Linux the installer probe runs
a Desktop built from `dev` inside a disposable overlay root on lidge. On Windows a second Desktop cannot run beside
the user's live single-instance 2.77.0, so the installer is exercised at module level (`perform_in` with a real
HKCU write) and the packaged launch is recorded as unverified.

## Hosts (baseline 2026-10-10)

| Host | OS | Relevant state |
|---|---|---|
| `ssh lidge` | Ubuntu 24.04.4, x86_64, the login user, bash | `open-codex` 2.61.0 deb owns `/usr/bin/ocx`; Desktop not running; no `~/.opencodex-desktop`; no zsh/fish/docker/xvfb; passwordless sudo; cargo 1.95, webkit2gtk-4.1 2.52.6; bun `/usr/local/bin/bun`; GNOME session on seat0 |
| `ssh mini` | Windows 11 build 26200, the interactive user | OpenCodex Desktop 2.77.0 per-machine MSI at `C:\Program Files\OpenCodex`, running in console session 1 with its `ocx` sidecar; npm `ocx` via nvm4w at `C:\nvm4w\nodejs` which is in both Machine and User Path; bun in `~\.bun\bin`; cargo/rustc; Windows Terminal; no Visual Studio found by vswhere |

## Constraints

- All repository work happens in `.tmp/lanes/cli-path-crossos` (branch `codex/cli-path-crossos-probe`); the main
  checkout is not touched. Fix branches are cut from `origin/dev` in `.tmp/lanes/<lane>` inside this worktree.
- Remote hosts: probe in temp directories and throwaway users where possible, never uninstall an existing tool,
  back up before any persistent write, and log every mutation with its exact revert command in
  `.tmp/host-changes.md` (worktree scratch, summarised in 040).
- Sol subagents do the host lanes and reviews; `create_thread` is not exposed in this session.
- Authorised: PRs to `dev` and issues. Not authorised: merge, release, version bump, deploy, messaging.

## Work-phase map (dependency order)

| Phase | Doc | Depends on | Closes with |
|---|---|---|---|
| wp1 | this file + 010/020/030/040 | — | roadmap reviewed |
| wp2 Linux probe | 010 | wp1 | Linux matrix with lidge evidence |
| wp3 Windows probe | 020 | wp1 | Windows matrix with mini evidence |
| wp4 fixes, issues, closeout | 040 (030 is the release-QA checklist both probes fill) | wp2, wp3 | PRs with exact-head CI, issues, reverts |

wp2 and wp3 touch different hosts and no shared files, so they run in parallel lanes.

## Outcome vocabulary

Each probe row ends as **works** (observed on the host), **broken** (observed failure, with the command and output),
**by design** (behaviour matches a documented decision, e.g. Windows `windows-path-only`), or **unverified** (with
the reason it could not be observed).

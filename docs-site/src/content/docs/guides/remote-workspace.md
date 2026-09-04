---
title: Remote Workspace
description: Keep Codex, Claude Code, Pi, and their logins on one OCX Hub while OCX-only computers provide the workspace and build environment.
---

Remote Workspace lets one OpenCodex Hub run your coding agents while another computer supplies the
project files, commands, tests, and build compute. A phone or third computer can control the session
through the Hub dashboard.

```text
Phone browser -> Computer 1 OCX Hub -> encrypted channel -> Computer 2 OCX Executor
                 Codex / Claude / Pi                       project and commands
                 logins and sessions                      no coding CLI login
```

The Executor needs OpenCodex only. It does not need Codex, Claude Code, Pi, a ChatGPT login, or a
provider API key. It opens an outbound WebSocket to the Hub, so the Executor needs no public port or
router port-forward.

:::caution[Private dogfood]
Remote Workspace is currently implemented on its feature branch and is not yet part of a stable
release. Linux supports file tools and conditionally supports sandboxed commands. macOS and Windows
have file tools, while Windows additionally uses the separately built Rust Executor helper described
below for sandboxed commands. macOS command execution is deliberately disabled until OCX can revoke
every descendant without importing a broad Seatbelt system profile. On supported command platforms,
commands are advertised only after a real confinement probe succeeds. Missing helpers, replaced
helper bytes, unsupported OS policy, and restricted containers degrade to file tools only.
:::

## Set up the Hub

Computer 1 owns every coding-agent login and model session. Install and log in to whichever agents
you want to use there, then run OpenCodex as a Hub:

```bash
ocx config set runtimeRole hub
ocx gui
```

Use an authenticated HTTPS deployment when opening the dashboard from a phone or another computer.
See [Remote Hub Deployment](/guides/remote-hub/) for the supported management-ingress and Tailscale
pattern. Do not publish an unauthenticated local dashboard port.

Codex Remote Workspace uses current App Server permission profiles. If the Hub's selected Codex
configuration still sets legacy `sandbox_mode` or `sandbox_workspace_write`, the dashboard reports
Codex as unavailable instead of starting with a weaker boundary. Migrate that Codex profile before
using the feature; do not configure both the legacy sandbox and a permission profile.

## Pair an Executor

1. Open **Remote Workspace** in the Hub dashboard.
2. Select **Create pairing code**.
3. On Computer 2, change into the project directory you want to expose.
4. Copy the generated **Linux / macOS terminal** or **Windows PowerShell** command for that computer.
   It pairs the current directory and keeps
   `ocx remote-workspace agent` connected in that terminal.

The equivalent manual flow is:

```bash
cd /path/to/project
printf '%s\n' 'ONE-TIME-CODE' | ocx remote-workspace pair 'https://your-hub.example' \
  --pairing-code-stdin --root "$PWD"
ocx remote-workspace agent
```

On Windows PowerShell, use the command shown in the dashboard. The equivalent manual form is:

```powershell
$pairingCode = 'ONE-TIME-CODE'
$pairingCode | ocx remote-workspace pair 'https://your-hub.example' `
  --pairing-code-stdin --root (Get-Location).Path
if ($LASTEXITCODE -eq 0) { ocx remote-workspace agent }
```

The current OCX Bun executable is added as one read-only file to the Linux sandbox automatically. If
the project needs a user-installed toolchain outside the system paths, pair it explicitly without
exposing the rest of the home directory:

```bash
printf '%s\n' 'ONE-TIME-CODE' | ocx remote-workspace pair 'https://your-hub.example' \
  --pairing-code-stdin --root "$PWD" \
  --toolchain-root "$HOME/.nvm/versions/node/v24/bin"
```

For private dogfood on Windows, build the memory-safe native Executor helper once from the
checked-out OpenCodex source:

```bash
bun run build:remote-workspace-helper
```

The ordinary pair command discovers that release build automatically. An explicitly reviewed helper
at another location can be selected with `--executor-helper <absolute-file>`. OCX stores its SHA-256
digest in the local device record and verifies the bytes again before every probe and command; after
rebuilding or updating the helper, pair the Executor again. The helper is not uploaded to the Hub.
Official packages must use the signed Windows release helper rather than asking end users to build
Rust source; that distribution step remains a release gate for this feature branch.

The one-time code is read from standard input, not command-line arguments. Pairing creates a local
device signing key and a device-scoped bearer. The Hub stores only its hash and never receives the
real Executor path. Stop the foreground agent with Ctrl+C; running it again reconnects the same
device.

Check local enrollment without printing secrets:

```bash
ocx remote-workspace status
```

## Start a remote coding session

In the dashboard choose:

1. the online computer;
2. one locally approved workspace folder;
3. Codex, Claude Code, or Pi from the Hub; and
4. an access mode.

**Read only** is the default and exposes directory listing and file reading. The write option is
shown as **Edit files and run commands** only when that Executor passed a command-sandbox probe;
otherwise it is shown as **Edit files only**. The dashboard shows two separate locations so it is
clear that the model and login remain on the Hub while workspace operations run on the selected
computer.

Send prompts from the Hub dashboard on Computer 1, Computer 3, or a phone. The session cannot switch
to another computer or folder silently. If the Executor disconnects, the session enters
**Executor offline** and never falls back to the Hub's filesystem.

**Stop** remains available while a prompt is running. It interrupts the Hub coding-agent turn,
cancels an active Executor command, and prevents a late response from reopening the stopped
session.

## Restart and reconnect behavior

The Hub persists bounded session metadata and a small recent event snapshot. After a Hub restart,
an unfinished session waits for its original Executor. Once that device reconnects, the next prompt
resumes the original Codex thread, Claude Code session, or Pi session ID.

Claude Code creates its durable history on the first completed prompt. If the Hub stops before a
new Claude session has completed any prompt, there is no conversation to resume; start a new
session instead.

A changed capability manifest does not silently weaken an existing session. Start a new session if
the Executor loses command containment or its available tools change. Revoking a computer closes its
socket and stops sessions bound to it.

## Security boundaries

- Provider credentials and coding-agent history remain on the Hub.
- Executor private keys, device bearer, and real root paths remain in its owner-only OCX state.
- Pairing-code failures are limited per kernel-observed peer on every listener. Ten failed codes in
  ten minutes return a generic `429` with `Retry-After`; the Hub retains only bounded, expiring
  hashes of those source identities. Tailscale Serve users share the management listener's loopback
  bucket because a direct local caller could forge its identity header.
- Each work session uses an Ed25519-signed ephemeral P-256 ECDH handshake and ordered
  AES-256-GCM messages.
- A socket is not shown as online until both sides agree on its current capability manifest.
- Reconnection may remove a capability when its local sandbox is unavailable, but never adds a
  capability outside the grant recorded at pairing.
- Every request is bound to one model thread, device, root, access mode, and capability set.
- Paths are relative, canonicalized, bounded, and rejected on symlink, junction, or parent-directory
  escape. Windows device names, alternate data streams, and trailing-dot/space aliases are denied.
- Executor operations are serialized, opened file identities are rechecked, and write hashes are
  checked again immediately before atomic replacement. Replacing an approved root requires pairing
  it again, and toolchain roots are revalidated before each command.
- File reads/writes reject hard-linked files. Before command execution, OCX scans at most 250,000
  workspace entries and disables the command path if any non-directory entry has multiple links;
  path sandboxes cannot prove whether the other name for that inode is outside the approved root.
- Linux commands run through bubblewrap with one writable workspace, cleared environment, private
  process namespaces, the current OCX Bun executable as one read-only file, bounded output
  and timeout, and network disabled by default. Hosted CI also cancels a detached-background-process
  attempt and verifies that it cannot write after cancellation.
- macOS advertises file tools only. A process group cannot contain a descendant after it calls
  `setsid()`, and importing a broad Apple Seatbelt system profile merely to start a command would
  expose unrelated host-service authority. The native helper therefore rejects both its probe and
  direct command requests until OCX has a narrow, revocable descendant-containment owner.
- Windows commands start suspended in a capability-free AppContainer and are attached to a
  kill-on-close Job Object before the first instruction is resumed. A unique AppContainer SID
  receives temporary modify access only to the workspace and read/execute access to approved
  toolchains; the sanitized environment maps writable profile paths into the workspace, and OCX
  removes those grants after the job.
- The Windows native probe must write inside a disposable workspace, read and modify a pre-existing nested
  workspace file, fail to read or write an adjacent sentinel, and fail to reach a live loopback
  listener. The macOS hosted probe instead proves that command execution remains explicitly
  unavailable. Binary existence alone never enables `workspace.exec`.
- The pinned native helper must be outside every approved writable workspace. OCX checks this both
  before advertising command support and immediately before each command, so workspace code cannot
  replace the binary that enforces its next sandbox.
- Stopping a session cancels an active Executor command and cleans up the Hub model process and
  loopback tool bridge. Windows stops the owned npm-wrapper process tree rather than leaving its
  Node child behind; Linux and macOS force-stop a CLI only if it ignores the graceful stop window.

The Hub intentionally sees prompts and model output because it runs the coding agent. End-to-end
encryption protects the Executor RPC transport from an intermediate relay; it does not make the Hub
blind to its own model conversation.

## Current scope

Remote Workspace does not copy or synchronize credentials to other computers. It is separate from
Remote Hub provider routing and from any future hosted compute or Super Sync product. A production
release still requires signed Windows helper packaging, native CI proof on the exact binaries,
independent maintainer review, and a real three-computer acceptance run.

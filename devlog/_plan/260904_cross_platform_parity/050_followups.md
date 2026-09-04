# 050 - Follow-ups this unit deliberately does not do

## Linux Claude-Code auto-connect via a shell env file (deferred after audit round 2)

`020` originally proposed this and it collected six blockers in one audit round.
They are recorded in `020` because the pattern matters more than any single
finding: it is not a platform guard to delete, it is a credential-bearing file
lifecycle on a new platform.

What the unit has to specify before any code:

- Where the Linux branch computes `modelEnv` and `auto`, which today exist only
  AFTER the darwin early return (`src/server/system-env.ts:436-438` vs `:372`).
- Ownership and cleanup for graceful stop, toggle-off, uninstall, and stale or
  crash recovery. `revertSystemEnv` returns immediately off darwin (`:488-490`),
  toggle-off follows the same path (`:483-485`), and `cleanStaleSystemEnv`
  delegates to it (`:521-536`), so a written file would currently have no
  reaper and could keep pointing at a stopped proxy.
- A result type both callers can read: they append
  `.catch(() => ({ injected: false }))` (`src/cli/index.ts:443,537`) and
  `SystemEnvResult` is not exported.
- Real permission enforcement. `writeFileSync(..., { mode: 0o600 })` sets the
  mode at creation only and does not tighten an existing 0644 file.
- GUI capability semantics. The control is gated on `autoConnectSupported`
  (`gui/src/pages/claude-autoconnect.ts:10-13`,
  `claude-code-sections.tsx:88-92`), so a new API field alone changes nothing
  visible.
- An update to `tests/claude-shell-hook.test.ts:180-184`, which asserts the exact
  source shape `reconcileShellHook(systemEnv.injected)` twice.
- The security review AGENTS.md requires: the file can contain
  `ANTHROPIC_AUTH_TOKEN` (`src/server/system-env.ts:95-100`), so this writes a
  bearer token to a new platform's disk.

## Legacy name-form scheduler task migration (deferred after audit round 2)

`030` ships the decode fix alone. Migrating a task whose `<UserId>` is name form
needs an authoritative name-to-SID resolution requiring equality with the current
user's SID - the idea is sound, and audit round 2 confirmed a mojibaked name
resolving to a foreign account is safely rejected by SID inequality. What is
missing is the specification: the resolver API, a trusted execution channel
(`LookupAccountNameW`, or a static trusted command taking the name strictly as
DATA so it cannot become an injection surface), strict SID validation, and
fail-closed rules for prefixed, duplicated and mixed `<UserId>` elements of the
kind `src/service.ts:2117-2136` already guards. Tests must cover
mixed-current/foreign, duplicate, prefixed, metacharacter, and failed-lookup
cases.

## Env injection on Windows

`injectSystemEnv` / `revertSystemEnv` (`src/server/system-env.ts:372,489`) stay
darwin-only; the Linux half is the entry above. A Windows port writes
`ANTHROPIC_AUTH_TOKEN` into `HKCU\\Environment`,
moving a bearer token from a per-boot launchd domain into a persistent registry
hive readable by every process in the session. AGENTS.md routes credential
handling to explicit security review, and that is a maintainer decision.

The design it would need: a backend interface (`get`/`set`/`unset`) with launchd,
registry, and shell-file implementations, preserving the tracking file, the
user-wins lever rule, ownership-mismatch refusal, and resumable partial rollback
described in `001`. On Windows the registry write must be followed by a
`WM_SETTINGCHANGE` broadcast with `lParam="Environment"`, or only newly spawned
processes see the change. `setx` is the naive route but truncates at 1024
characters.

On Linux there is no single equivalent at all: `systemctl --user set-environment`
reaches only systemd-spawned units, `~/.profile` reaches login shells,
`~/.bashrc` reaches interactive non-login shells. That is the honest reason it
never shipped. `devlog/_fin/260723_issue_triage/030_fix_287_linux_autoconnect.md`
already scoped it.

## WSL2 credential bridge for meta-muse

`010` refuses on Windows with an accurate message instead of reading a WSL2
pointer at `\\\\wsl$\\<distro>\\home\\<user>\\.config\\muse\\auth.json`. Doing that
properly needs distro enumeration, Linux-user mapping, and a reachability probe,
none of which were measured. A guess would ship an unverified credential path,
which is exactly what `meta-muse.ts` refuses to do everywhere else.

## Linux credential reader for meta-muse (blocked on a measurement)

Audit round 1 rejected the drafted Linux reader: the pointer interface
(`src/oauth/meta-muse.ts:58-60`) has no path field and no inline-key field, so a
reader would have been written against invented schema. `010` therefore ships a
truthful Linux REFUSAL instead.

What unblocks it is a measurement, not a decision. Someone with a Linux Muse Code
install needs to record, from a real `~/.config/muse/auth.json`:

- the exact `storage` value the CLI writes there;
- whether the secret is inline in the pointer, in a sibling file, or in a keyring;
- if file-backed, the exact field naming that file, and the file's permissions;
- whether the CLI honors `XDG_CONFIG_HOME` on Linux.

With those four facts `002` gets an evidence section and the reader is a small,
safe phase. Without them it is a guess wearing a validator.

## Unifying the two schtasks decoders

`003` records that `service.ts:902` (`decodeSchtasksOutput`) and
`service-manager-probe.ts` use different decoders for the same command's output.
Latent, not active: `/query /xml` emits UTF-16, which both handle. Worth
unifying on `decodeWindowsTextBytes`, but it is not the reported defect and
changing a decoder used across the service path deserves its own unit.

## PowerShell counterpart for ocx-restart.sh

`scripts/ocx-restart.sh` has no `.ps1` counterpart, so a Windows agent session has
no detached-restart helper and a proxy started during a turn dies with the turn.
Small and self-contained (`Start-Process -WindowStyle Hidden`, then poll
`runtime-port.json`), but it is a developer script outside the runtime and does
not belong in a stack about user-facing platform parity.

## Structured reasons across the uninstall path (deferred, not mechanical)

`ocx uninstall` decides whether a shell-hook refusal is benign by matching the
literal strings `"not macOS"` and `"not installed"` (`src/cli/index.ts:1242-1244`).
An earlier draft put a `skip` discriminant in `020`; audit round 3 removed it and
round 4 confirmed the reason.

It is not mechanical. The union has to distinguish benign ABSENCE from genuine
FAILURE - `no HOME` and `read/write failed` must never become benign skips - and
four exact `toEqual` assertions pin the current return objects
(`tests/claude-shell-hook.test.ts:63,79,107,173`), so every one of them changes
with it.

It belongs with the port that needs it: the Linux env-file unit above is what
introduces a second backend and therefore a second reason vocabulary. Doing it
standalone changes call-site semantics and four tests to buy nothing.

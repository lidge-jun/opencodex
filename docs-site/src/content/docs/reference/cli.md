---
title: CLI Reference
description: Command dispatch, exit codes, and links to every ocx command family.
---

The opencodex CLI is `ocx`. It dispatches on the first command name, with documented aliases such
as `setup`/`init`, `restore`/`eject`, and `models`/`model` reaching the same operation. Unknown
commands and invalid command shapes are errors.

Run `ocx`, `ocx help`, `ocx --help`, or `ocx -h` for the same compact command index,
grouped into Start here, Common tasks, Explore, and More help.
Use `ocx help --all` or `ocx --help --all` for the full top-level reference, including
the detailed command variants omitted from the compact index.
Run `ocx help <command>`, `ocx <command> --help`, or `ocx <command> -h` for a command
registered in the help table; `ocx <command> help` also remains supported. Help and version
commands are read-only: they do not start, stop, install, uninstall, or rewrite Codex or
opencodex state.

## Nested help

Family help such as `ocx help models` preserves the family's usage and details, then
lists known declared child paths with summaries. These lists describe declared children;
they do not guarantee exhaustive runtime coverage. Alias help retains the alias's own usage
and details and points to its canonical family: `ocx help model` leads to `ocx help models`.
Models help also links the curated `models context` topic separately from declared capabilities.

Help accepts a path with more than one command word:

```bash
ocx help models context
ocx models context --help
ocx model context --help
ocx help account list
ocx help account main
```

The first three forms show the same context-cap topic, including the `model` alias:

```text
ocx models context <status|value <tokens> [--set-all]|provider <name> on [--value <tokens>]|provider <name> off|all <on|off>> [--json]
```

`ocx models context status --json` reads the current settings. `value <tokens>` sets the
default for future toggles; adding `--set-all` applies it to all routed providers.
`provider <name> on` enables a provider cap, optionally with `--value <tokens>`; `off`
disables it. `all on|off` changes all routed providers together.

Declared capability topics such as `account list` show their summary, known flags and
details, with a pointer to parent help. This metadata does not cover every operand or runtime
subcommand, so a topic can show `Command: ocx ...` without claiming a complete `Usage:` grammar.
A prefix such as `account main` lists its declared children and marks that coverage as incomplete.
An undeclared explicit topic (`ocx help <path>`) exits 1 with a concise detailed-help-unavailable
message and a known-parent or full-reference pointer on standard error. Standard output stays
empty, and no full help banner is printed. Missing detail does not establish whether the runtime command is valid.
Appended `--help`/`-h` preserves existing command-help behavior: when detailed metadata is unavailable,
it displays known parent help successfully, without executing the command.

In the Bun CLI head, bare `help` is recognized only at the root or immediately after the root
command. Use `--help` or `-h` for nested paths. Later values such as the `help` in
`ocx alias set demo help` remain command arguments. An exact `--` ends head help scanning,
so `ocx claude -- --help` preserves the arguments for command dispatch.

## Recovering from command typos

Unknown root commands and unresolved explicit help paths exit 1 with a short diagnostic and
navigation guidance on standard error, leaving standard output empty. Close typos can receive
conservative suggestions drawn from visible command names and the current help family's documented
children. Suggestions are guidance only: the CLI never executes them or retries the command.

| Input | Guidance |
| --- | --- |
| `ocx modles` or `ocx help modles` | Suggests `ocx help models`. |
| `ocx help account lisst` | Suggests `ocx help account list` within the account family. |
| `ocx help qzxv` | Offers `ocx help --all` without guessing a command. |
| `ocx help models qzxv` | Reports unavailable detailed help and points to the known models family. |

The Bun CLI rejects an unknown root before shim auto-restore or other command preflight.
Recognized commands retain their existing preflight; hidden commands and the internal runner
remain valid dispatch targets but are excluded from discovery and suggestions. Appended flag-help
fallback, capability JSON, and provider-specific error handling retain their existing behavior.

## Command families

### `ocx provider`

`ocx provider`, `ocx help provider`, `ocx provider help`, `ocx provider --help`, and
`ocx provider -h` show the same provider help, with command syntax, examples, preset/custom
guidance, and declared topic pointers. Successful help prints to standard output and exits 0.
Bare `ocx provider` still follows ordinary command preflight; explicit head-help forms exit
before that preflight. An unknown provider action prints its diagnostic and provider help
to standard error, leaves standard output empty, and exits 1.

### `ocx alias`

`ocx alias list [--json]` shows effective user and built-in aliases. Use `ocx alias set <provider>[/<native-model-id>] <alias>` and `ocx alias rm <provider>[/<native-model-id>]` to edit them. Native model ids may contain additional slashes because the selector splits only at the first slash. Enable shipped defaults with `ocx alias defaults on|off [--provider <name>]`.

### `ocx remote-workspace`

`ocx remote-workspace pair <hub-url> --pairing-code-stdin --root <absolute-path>` enrolls the local
computer as an OCX-only Executor. Repeat `--root` to approve more folders and use `--name` to
override the hostname. Repeat `--toolchain-root <absolute-directory>` to expose a user-installed
Node, Rust, Go, or other toolchain directory read-only inside the command sandbox. On macOS and
Windows private-dogfood builds, `bun run build:remote-workspace-helper` creates the Rust helper that
the pair command discovers automatically; `--executor-helper <absolute-file>` selects another
explicitly reviewed build and pins its digest in local Executor state.
`ocx remote-workspace agent` maintains the outbound encrypted connection;
`ocx remote-workspace status [--json]` reports the Hub, device, roots, and advertised capabilities
without printing its bearer or private key. See [Remote Workspace](/guides/remote-workspace/).

- [Lifecycle](/reference/cli/lifecycle/) — setup, proxy and service lifecycle, health, diagnostics,
  catalog sync, the dashboard, and updates.
- [Providers, accounts, and models](/reference/cli/providers-accounts/) — provider configuration,
  authentication, credential pools, quota, custom models, visibility, selected models, and context
  caps.
- [Agents, routing, and integrations](/reference/cli/agents/) — multi-agent controls, combos,
  observability, admission keys, protocol paths, client integrations, runtime settings, validated
  configuration, and read-only Codex CLI update inspection.

## Headless behavior

Management commands round-trip the live proxy's management API, using the recorded runtime port and
identity checks rather than maintaining a second configuration path. A stopped or unreachable proxy
is represented as HTTP 503 and produces a nonzero CLI exit. Commands explicitly documented as
offline configuration operations can instead validate and edit the config file without a live
proxy.

`ocx system codex-cli-update check` needs no live proxy and makes no package-registry request. It
inspects bounded provenance metadata for the configured install candidate, including its redacted
executable location and ownership evidence. Trusted published-launcher context authenticates that candidate snapshot,
not a successful Codex execution. Because this one-shot command never executes Codex, environment and persisted candidates
remain report-only (`managed: false`, normally `selection_unattested`) and `selectionAttested` remains `false`.
The JSON report exposes `candidateAvailable`, `candidateVersion`, `candidateSource`, and `selectionAttested`.
Inspecting the configured candidate requires a trusted published-launcher context;
a direct Bun/source launch has no such proof, ignores ambient and persisted candidate state, and may report
`candidate_unavailable` on POSIX or `windows_inspection_deferred` on Windows. On Windows this first slice performs no candidate or configuration filesystem I/O:
only a proof-captured absolute environment candidate can receive lexical app-bundle or version-manager labels;
every other Windows candidate fails closed. The command does not install or repair software, execute
Codex or npm, control a running process, or write configuration/cache state.

For Windows x64 installation observation, see [the `attest` command](/reference/cli/agents/#explicit-installation-observation-on-windows-x64). Without explicit paths it observes the selected candidate identified from the proof-bound launcher snapshot; it does not grant update authority or attest runtime selection.

List or status is the default where unambiguous. Use `--json` only on leaves that support it, and
`ocx observe logs --follow --jsonl` for a streaming request-log feed. Theme, language, navigation,
and other purely visual browser state have no CLI equivalent; Cloudflare Tunnel setup is outside
this command set.

## Liveness probe ceiling override

`ocx health`, `ocx status`, `ocx account *`, `ocx login codex`, and `ocx ready` find the running
proxy through a short liveness probe: 750 ms per attempt by default, and 1500 ms with retries for
stop and start decisions. On hosts where a security layer (a content filter or an EDR-style network
extension) adds a fixed cost to every loopback connection, those ceilings can expire before a
healthy proxy answers, so these commands report the proxy as down while
`curl http://127.0.0.1:10100/healthz` succeeds.

Set `OCX_PROBE_TIMEOUT_MS` to raise the ceilings on such hosts, for example
`OCX_PROBE_TIMEOUT_MS=5000 ocx status`. The value is whole milliseconds from 1 to 30000. The
override only raises: the 750 ms default and the 1500 ms stop/start budgets keep their floors, so
`1000` lengthens only the default probe. Unset, empty, fractional, negative, zero, or larger values
are ignored and the shipped ceilings apply.

On Windows the proxy also raises its own process to ABOVE_NORMAL priority when it starts, which
reduces scheduling delays on a host saturated by other NORMAL-priority work (antivirus scans,
encoders, emulators) without guaranteeing the probe stays under these ceilings at extreme load.
The boost applies to the proxy process only — work it spawns still runs at NORMAL — and a
CPU-heavy proxy can itself delay NORMAL-priority applications. The change is best-effort; set
`OCX_DISABLE_PRIORITY_BOOST=1` in the proxy's environment to leave the priority unchanged.

## Exit codes and confirmation

Successful commands exit 0. Invalid usage, unknown commands or resources, failed API operations,
and unavailable required services exit nonzero. `ocx health` specifically exits 0 only when the
proxy is healthy and 1 otherwise, so it can be used as a service probe. Scripts should test the exit
code instead of scraping human-readable output.

Many management commands share these mappings; other CLI families retain their own exit contracts:

| Code | Cause |
|---|---|
| 0 | success |
| 2 | local usage refusal in management handlers; also unsupported `doctor --json` |
| 64 | invalid arguments to `capabilities`, `ready`, or `resolve`, before their discovery/request work |
| 4 | HTTP 404 — the named account, provider, key, or route does not exist |
| 5 | HTTP 409 — conflict; a lock is held or state changed underneath |
| 1 | everything else, including transport failure and other HTTP errors |

Exit 0 means no error was reported. Preview verbs (for example `ocx storage cleanup` without `--yes`) also exit 0 without mutating. A saved setting can still carry a skipped or incomplete apply result; read the receipt and stderr warnings.

Destructive removal, import, credit-consumption, and update operations that advertise confirmation
require `--yes` in non-interactive use. The flag is an explicit opt-in; omitting it must not silently
confirm the action.

`ocx storage cleanup` goes further: without `--yes` it runs the preview and prints what *would* be
freed, then exits 0 having changed nothing. There is no interactive confirmation for any of these —
a prompt an automated caller can answer is not a safety boundary, so the flag is the boundary.

## Driving the CLI from an agent

Discover progressively, without starting a proxy:

```bash
ocx help
ocx help models
ocx help models preset show
```

Read the corresponding chapter in the repository's `skills/ocx/references/01_management_surface.md`
or one of the public command-family pages above. Full `ocx help --all` is an
escape to the top-level reference. A broad machine inventory is optional:

```bash
ocx capabilities --json
ocx capabilities --mutating-only --json
ocx capabilities --route '/api/providers/{provider}/model-costs' --json
```

Route lookup matches the literal declared template, not concrete provider IDs or
an HTTP method. A miss exits 4 and does not prove that a runtime command is absent.
Declarations include local commands as well as management commands; only the
latter need a live target. Before live operations, run `ocx ready --json` and
`ocx status --json`, inspect the target and `versionSkew.relation`, and resolve
version mismatch. `unknown` does not confirm matching builds. Offline help,
local configuration and local Lab inspection do not require startup.

Output flags are per command. `doctor` rejects `--json` with exit 2; `v2` has no
JSON output contract. Even for JSON-capable management commands, API failures
normally use stderr prose with optional `reason:` and `hint:` lines, not a JSON
error envelope. Keep stdout, stderr and exit status separate.

Coverage is measured by named workflows, not by shared route prefixes. Existing
model presets, visibility, account controls and routing-profile reads do not imply
support for discovered-model display-name edits or routing-profile writes.
Session-only consent actions and browser presentation remain separate boundaries.
Access-key creation and rotation-start return plaintext credentials: agents must
hand those steps to a human-operated terminal outside the session and accept only
non-secret IDs and confirmation. Never ask for credentials in chat or bypass a
session-only action with another API client.

## Recent behavior changes

These are corrections to commands that previously misreported their own results:

- `doctor` and `sync-cache` now exit non-zero on failure. They previously printed a failure and
  exited 0, so a script could not tell success from failure.
- Client errors from `account` map HTTP 404 to exit 4 and HTTP 409 to exit 5, instead of collapsing
  everything into 1.
- `ocx restore back --json` now honors its output flag, which it previously accepted and ignored.
  This does not make `--json` a global option for every command.
- `ocx logs --model` now actually filters. It was accepted and silently ignored, so the output
  looked filtered while showing every row.
- `ocx storage` gained `cleanup`, `trash`, and `policy` subcommands. A bare `ocx storage` still
  prints the storage report, as it did when it was an alias of `ocx observe storage`.

## Version and internal dispatch targets

`ocx --version`, `ocx -v`, and `ocx version` print one script-friendly version line and exit.

Two dispatch targets are intentionally omitted from normal help: `__refresh-version [preview]`
refreshes the update-notification cache in a detached process, and
`__gui-update-worker <job-id> [latest|preview] [restart]` runs a dashboard update job. They are
implementation details, not stable user-facing commands. The dashboard records the worker PID,
recovers an active job whose worker died, treats older PID-less active records as stale after ten
minutes, and protects a live worker from concurrent updates.

## Capability argument validation

`ocx capabilities` rejects unknown arguments, repeated flags and blank `--route` values with exit 64. A valid route with no declared capability exits 4.

## Integer option values

Integer options such as `--limit` require decimal whole numbers within JavaScript safe-integer bounds. Digit separators such as `1_000` and `1,000` are accepted. Empty values, hexadecimal, exponent notation and fractions are rejected before a request is sent.

## Windows JSON configuration files

`ocx config validate <file>` and `ocx config import <file> --yes` accept UTF-8 JSON with or without a leading BOM, including stdin (`-`). This supports UTF-8 exports from Windows PowerShell and editors. UTF-16 input is not accepted.

## Default alias listing

`ocx alias --json` is equivalent to `ocx alias list --json`. The output flag can precede or follow an explicit alias action.

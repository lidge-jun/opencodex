---
title: CLI Reference
description: Command dispatch, exit codes, and links to every ocx command family.
---

The opencodex CLI is `ocx`. It dispatches on the first command name, with documented aliases such
as `setup`/`init`, `restore`/`eject`, and `models`/`model` reaching the same operation. Unknown
commands and invalid command shapes are errors.

Run `ocx help` (or `ocx --help` / `ocx -h`) for top-level usage. Run `ocx help <command>`,
`ocx <command> --help`, or `ocx <command> -h` for a command registered in the help table. Help and
version commands are read-only: they do not start, stop, install, uninstall, or rewrite Codex or
opencodex state.

## Command families

### `ocx alias`

`ocx alias list [--json]` shows effective user and built-in aliases. Use `ocx alias set <provider>[/<native-model-id>] <alias>` and `ocx alias rm <provider>[/<native-model-id>]` to edit them. Native model ids may contain additional slashes because the selector splits only at the first slash. Enable shipped defaults with `ocx alias defaults on|off [--provider <name>]`.

- [Lifecycle](/reference/cli/lifecycle/) — setup, proxy and service lifecycle, health, diagnostics,
  catalog sync, the dashboard, and updates.
- [Providers, accounts, and models](/reference/cli/providers-accounts/) — provider configuration,
  authentication, credential pools, quota, custom models, visibility, selected models, and context
  caps.
- [Agents, routing, and integrations](/reference/cli/agents/) — multi-agent controls, combos,
  observability, admission keys, client integrations, runtime settings, validated configuration, and
  read-only Codex CLI update inspection.

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
`candidate_unavailable`. On Windows this first slice performs no candidate or configuration filesystem I/O:
only a proof-captured absolute environment candidate can receive lexical app-bundle or version-manager labels;
every other Windows candidate fails closed. The command does not install or repair software, execute
Codex or npm, control a running process, or write configuration/cache state.

List or status is the default where unambiguous. Use `--json` for structured snapshots and
`ocx observe logs --follow --jsonl` for a streaming request-log feed. Theme, language, navigation,
and other purely visual browser state have no CLI equivalent; Cloudflare Tunnel setup is outside
this command set.

## Exit codes and confirmation

Successful commands exit 0. Invalid usage, unknown commands or resources, failed API operations,
and unavailable required services exit nonzero. `ocx health` specifically exits 0 only when the
proxy is healthy and 1 otherwise, so it can be used as a service probe. Scripts should test the exit
code instead of scraping human-readable output.

The specific codes are set in one place, so every management command agrees:

| Code | Cause |
|---|---|
| 0 | success |
| 2 | usage error — bad, missing, or unknown arguments; nothing was sent |
| 4 | HTTP 404 — the named account, provider, key, or route does not exist |
| 5 | HTTP 409 — conflict; a lock is held or state changed underneath |
| 1 | everything else, including transport failure and other HTTP errors |

Exit 0 means no error was reported. Preview verbs (for example `ocx storage cleanup` without `--yes`) also exit 0 without mutating. A command never prints an error and exits 0.

Destructive removal, import, credit-consumption, and update operations that advertise confirmation
require `--yes` in non-interactive use. The flag is an explicit opt-in; omitting it must not silently
confirm the action.

`ocx storage cleanup` goes further: without `--yes` it runs the preview and prints what *would* be
freed, then exits 0 having changed nothing. There is no interactive confirmation for any of these —
a prompt an automated caller can answer is not a safety boundary, so the flag is the boundary.

## Driving the CLI from an agent

`ocx capabilities --json` is the machine-readable index of every command, the management routes it
drives, its flags, and whether it mutates state. Start there rather than parsing help text:

```bash
ocx capabilities --json
ocx capabilities --mutating-only --json
ocx capabilities --route /api/logs
```

An unmatched `--route` exits 4 rather than reporting empty success. The repository ships a fuller
operating guide at `skills/ocx/`, whose surface map is generated from the same table.

## Recent behavior changes

These are corrections to commands that previously misreported their own results:

- `doctor` and `sync-cache` now exit non-zero on failure. They previously printed a failure and
  exited 0, so a script could not tell success from failure.
- Client errors from `account` map HTTP 404 to exit 4 and HTTP 409 to exit 5, instead of collapsing
  everything into 1.
- `--json` is honored in any argument position, including `ocx restore back --json`, which
  previously accepted the flag and ignored it.
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

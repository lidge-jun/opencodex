# `ocx-go` migration ledger — schema and initial entries

Status: spec (implementation not started)
Governing decision: `docs/adr/0010-ocx-go-native-runtime-line.md`

## Purpose

The ledger is the single source of truth for what `ocx-go` can actually do. It
replaces `go/internal/ocxcli/deferral.go` (`deferredSurfaces`), which encoded
TypeScript delegation as a normal path. No ledger entry authorizes delegation;
every unsupported surface is an explicit native-unsupported result.

## Consumers (one data source, no drift)

The ledger is generated into, or read by, all of:

- `ocx-go capabilities --json` — machine-readable support table.
- `ocx-go help` — every public command, with support status.
- The zero-JavaScript dashboard capability page.
- Exit-69 / HTTP-501 error text and codes.
- Documentation generation.

No consumer maintains its own copy of support state.

## Entry schema

```
Surface      []string  // argv prefix, e.g. ["service"], ["observe","logs","rebuild-index"]
Kind         enum      // command | subcommand | route | capability
Status       enum      // supported | unsupported
Platforms    []string  // ["linux"] | ["linux","darwin"] | ["all"]
UnsupportedCode string  // stable machine code, e.g. "go_runtime_unsupported"
TargetBehavior  string  // what the native implementation will do
Oracle          string  // how equivalence/acceptance is proven (T1..T5 or matrix)
Milestone       string  // migration milestone this entry is retired in
Acceptance      string  // the evidence required to flip Status to supported
```

Rules:

- `Status: supported` with no acceptance evidence is a spec violation; the
  ledger test fails.
- An entry is **removed or flipped** when its acceptance passes; entries do not
  accumulate justification prose.
- `UnsupportedCode` for a given surface is stable across releases; changing it is
  a breaking change documented in release notes.

## Initial unsupported set (from the legacy registry)

Whole commands currently legacy-owned (`cli.go` `TypeScriptOwned`) become ledger
entries, not delegation:

| Surface | Target behavior | Notes |
|---|---|---|
| `setup` (`init`) | native noninteractive provider/model/default setup (`provider add`, `provider set-default`) | interactive first-run is a later milestone |
| `restore` (`eject`) | native Codex Design-B journal rollback + catalog restore | requires the write coordinator substrate |
| `recover-history` | native historical-row relabel over Codex resume DB | sqlite migration; separate milestone |
| `uninstall` (`remove`) | native per-OS service/shim/hook teardown + restore | needs T4 platform lanes |
| `service` | native service manager (systemd/launchd/Task Scheduler) | T4 platform lanes |
| `tray` | native Windows tray | deferred; windows native-unsupported |
| `connect` | native hub connect / pairing / rotate | remote path; separate milestone |
| `login` | native provider login (**key auth first**, OAuth later) | key slice may land early |
| `update` | explicit verified artifact upgrade (no self-update in preview) | Q119 |
| `account` | native account management | OAuth/pool — later milestone |

Subcommand seams inside Go-owned families (`observe`, `logs`, `storage`,
`system`, `account`, `connect`, `models`, `lab`, `config`, `codex-shim`) become
per-verb ledger entries with the same shape.

Additionally, these non-command capabilities are ledger entries from day one:

| Capability | Target behavior | Notes |
|---|---|---|
| `dash.providers` .. `dash.lab` (10 pages) | zero-JS native HTML pages | "complete dashboard" only when all are supported |
| `dataplane.chat_completions` | native `/v1/chat/completions` inbound | not public in core preview |
| `dataplane.adapters.<x>` | native conversion for non-first adapters | anthropic/google/kiro/cursor/command-code/ollama/mimo |
| `auth.oauth` / `auth.forward` / `auth.local` / `auth.keychain` | native auth modes | key-auth only in core preview |
| `routing.combo` / `routing.profile` / `routing.alias` / `routing.pattern` / `routing.namespace` | native routing semantics | fail closed until each has a matrix |
| `codex.inject.provider_table` / `codex.inject.desktop_authless` / `codex.inject.websocket` / `codex.inject.nonloopback` | native injection branches | loopback Design B only first |
| `codex.sync.provider_discovery` | native upstream discovery | config-derived catalog first |
| `update.self_replace` | native self-update | not in preview |

## Unsupported code vocabulary

Two surfaces, two code families, unified by the `go_runtime_unsupported` root:

- CLI: exit `69` (`EX_UNAVAILABLE`) with `"error": "<code>"` in `--json`.
- HTTP: `501` with a stable `code` in the error envelope.

Proposed root codes (to be finalized in implementation):

```
go_runtime_unsupported                 // generic surface not yet native
standalone_go_unsupported              // request shape outside the strict subset
standalone_go_model_not_configured     // model not exactly registered
standalone_go_ambiguous_model          // model registered by >1 provider
standalone_go_response_state_unavailable // previous_response_id evicted/restart
standalone_go_conflict_ownership       // CODEX_HOME owned by another runtime
standalone_go_configuration_invalid    // persisted config fails validation
standalone_go_configuration_permissions // private perms cannot be established
```

The open question of whether to merge the CLI and HTTP vocabulary into one enum
is deferred to the implementation slice; both must share the root.

## Ledger test

A Go test enforces:

1. Every public command/verb appears exactly once (bijection with the registry).
2. Every `unsupported` entry has non-empty `UnsupportedCode`, `TargetBehavior`,
   `Oracle`, `Milestone`, `Acceptance`.
3. No entry references the delegation seam or the legacy runtime.
4. Every `supported` entry references acceptance evidence.
5. The ledger's `supported` set equals the set of surfaces the CLI actually
   dispatches natively (no surface claims support it cannot provide).

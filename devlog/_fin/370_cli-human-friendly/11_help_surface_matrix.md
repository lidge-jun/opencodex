# Help Surface Matrix

Status: Phase 1 research artifact, documentation-only.

This file records the current `ocx` command-line help surface before any CLI behavior patch. It intentionally separates:

- safe read-only probes: top-level help, subcommand help, unknown commands, and version/json candidates;
- code-derived behavior: side-effecting commands such as `service install`, `service stop`, `codex-shim install`, `start`, `stop`, `sync`, and `uninstall`;
- future recommendations: implementation candidates for later PABCD cycles.

## Probe Method

Project root:

```bash
/Users/jun/Developer/new/700_projects/opencodex
```

Safe probe shape:

```bash
bun run src/cli.ts <args>
node bin/ocx.mjs <args>
```

Code surfaces inspected:

```bash
/Users/jun/Developer/new/700_projects/opencodex/src/cli.ts
/Users/jun/Developer/new/700_projects/opencodex/src/service.ts
/Users/jun/Developer/new/700_projects/opencodex/src/codex-shim.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/cli-help.test.ts
/Users/jun/Developer/new/700_projects/opencodex/README.md
/Users/jun/Developer/new/700_projects/opencodex/docs-site/src/content/docs/reference/cli.md
```

Important safety note: lifecycle commands can mutate local state. The matrix does not rely on executing `start`, `stop`, `sync`, `uninstall`, `service install/start/stop/uninstall`, or `codex-shim install/uninstall` without a help flag.

## Current Dispatch Facts

- `src/cli.ts` owns top-level argument parsing, help text, and command dispatch.
- `--help`, `-h`, and a trailing `help` token are recognized only after a top-level command, via `hasHelpFlag(args.slice(1))`.
- `ocx help <command>` does not show command-specific help today. It falls through to the top-level `help` command.
- Unknown commands normally exit 1, but `ocx <unknown> --help` exits 0 and prints top-level help because the help check runs before the switch default.
- `--version`, `-v`, and `version` are not recognized.
- `status --json` is accepted as extra ignored text and prints the human status, not JSON.
- `service remove` and `codex-shim remove` are supported in code, but top-level help omits both remove aliases.

## Top-Level Help And Global Flags

| Command | Current result | Exit | Side-effect risk | Docs coverage | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `ocx` | Prints top-level help. | 0 | None. | README/docs-site describe command list. | Keep; expand with quick start and diagnostics in a later patch. |
| `ocx help` | Same as top-level help. | 0 | None. | README/docs-site mention help lightly or indirectly. | Keep; later make `ocx help <command>` useful. |
| `ocx --help` | Same as top-level help. | 0 | None. | docs-site documents short help. | Keep; make more human-friendly later. |
| `ocx -h` | Same as top-level help. | 0 | None. | Not consistently called out. | Keep as global alias. |
| `ocx --version` | `Unknown command: --version`, then top-level help. | 1 | None. | Not documented. | Add one-line version output in a later low-risk patch. |
| `ocx -v` | `Unknown command: -v`, then top-level help. | 1 | None. | Not documented. | Add alias to one-line version output; do not copy agbrowse's help-like version behavior. |
| `ocx version` | `Unknown command: version`, then top-level help. | 1 | None. | Not documented. | Optional alias to the same one-line version output. |
| `node bin/ocx.mjs --help` | Same top-level help as source CLI. | 0 | None. | Package bin path is implicit. | Keep parity with `ocx --help`. |
| `node bin/ocx.mjs --version` | Same unknown-command behavior as source CLI. | 1 | None. | Not documented. | Fix alongside `ocx --version`. |

## Subcommand Help Coverage

Pattern observed for every listed top-level command:

- `ocx <command> --help` exits 0 and prints short subcommand usage.
- `ocx <command> -h` exits 0 and prints the same short subcommand usage.
- `ocx help <command>` exits 0 but prints top-level help instead of subcommand help.

| Command family | Current `--help` result | `ocx help <command>` result | Exit | Side-effect risk with help | Docs coverage | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| `init` | `Usage: ocx init`; one-line interactive setup description. | Top-level help. | 0 | None. | README/docs-site cover. | Add examples and provider/auth pointer later. |
| `start` | `Usage: ocx start [--port <port>]`; one-line proxy/model-sync description. | Top-level help. | 0 | None. | README/docs-site cover. | Add port fallback, blocking behavior, and service interaction. |
| `stop` | `Usage: ocx stop`; one-line stop/restore description. | Top-level help. | 0 | None. | README/docs-site cover. | Clarify service-stop and native restore side effects. |
| `restore` | `Usage: ocx restore`; restore without stopping. | Top-level help. | 0 | None. | README/docs-site cover. | Keep paired with `eject`; explain when safer than stop. |
| `eject` | `Usage: ocx eject`; restore without stopping. | Top-level help. | 0 | None. | README/docs-site mention alias. | Keep as alias but make help discoverable. |
| `recover-history` | `Usage: ocx recover-history --legacy-openai`; explicit legacy recovery warning. | Top-level help. | 0 | None. | README covers recovery flow. | Preserve guard; add stronger "only if" warning in future help. |
| `uninstall` | `Usage: ocx uninstall`; remove service/shim/config and restore native Codex. | Top-level help. | 0 | None. | README covers. | Add destructive-state warning in future help. |
| `remove` | Same as `uninstall`. | Top-level help. | 0 | None. | README/docs-site under-document this alias. | Either document alias or hide from top-level intentionally. |
| `status` | `Usage: ocx status`; check proxy status. | Top-level help. | 0 | None. | README/docs-site cover. | Candidate for first `--json` contract later. |
| `ensure` | `Usage: ocx ensure`; ensure proxy/config/cache current. | Top-level help. | 0 | None. | README covers; docs-site sparse. | Explain autostart/shim relationship. |
| `login` | `Usage: ocx login <provider>`; OAuth/API-key login. | Top-level help. | 0 | None. | README/docs-site cover OAuth providers. | Add provider list or pointer. |
| `logout` | `Usage: ocx logout <provider>`; remove stored login. | Top-level help. | 0 | None. | README/docs-site cover. | Clarify provider names and credential scope. |
| `sync` | `Usage: ocx sync`; fetch models and inject into Codex config. | Top-level help. | 0 | None with help. | README/docs-site cover. | Clarify model discovery and config mutation when run. |
| `sync-cache` | `Usage: ocx sync-cache`; refresh Codex model cache. | Top-level help. | 0 | None with help. | README mentions indirectly; docs-site sparse. | Add docs-site entry if kept public. |
| `gui` | `Usage: ocx gui`; open dashboard. | Top-level help. | 0 | None with help. | README/docs-site cover; docs-site says omitted from short help but current top-level includes no `gui` row in printed usage. | Align docs and actual help list. |
| `service` | `Usage: ocx service <install|start|stop|status|uninstall>`. | Top-level help. | 0 | None with help. | README/docs-site cover. | Expand nested help; add/remove alias mismatch. |
| `codex-shim` | `Usage: ocx codex-shim <install|status|uninstall>`. | Top-level help. | 0 | None with help. | README/docs-site cover. | Expand nested help; add/remove alias mismatch. |
| `update` | `Usage: ocx update [--tag latest|preview]`; preview tag note. | Top-level help. | 0 | None with help. | README/docs-site cover. | Clarify restart-after-update and invalid tag behavior. |

## Nested Service And Shim Surface

These rows are code-derived unless explicitly marked as `--help` probes. Direct lifecycle execution is not part of this documentation-only phase because it can install/start/stop/uninstall local services or shims.

| Command | Current result | Exit | Side-effect risk | Docs coverage | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `ocx service --help` | Prints `Usage: ocx service <install|start|stop|status|uninstall>`. | 0 | None. | README/docs-site cover basic family. | Add nested help for each service subcommand. |
| `ocx service -h` | Same as `--help`. | 0 | None. | Not explicitly documented. | Keep. |
| `ocx service install` | Code installs and starts launchd/systemd/Task Scheduler service; may require auth token for non-loopback hostname. | code path exits 0/1 depending environment | High mutation. | README/docs-site cover. | Help should state mutation, auth precondition, log path. |
| `ocx service start` | Code starts installed service. | code path exits 0/1 depending environment | Starts background service. | README/docs-site mention service start indirectly. | Add explicit nested help. |
| `ocx service stop` | Code stops service, stops tracked proxy, restores native Codex. | code path exits 0/1 depending environment | Stops service and changes Codex config. | README/docs-site cover service family. | Help should distinguish from top-level `stop`. |
| `ocx service status` | Code prints platform service status plus diagnostics log path. | code path exits 0/1 depending environment | Read-only. | README/docs-site cover examples. | Candidate for `--json` later if doctor/status schema exists. |
| `ocx service uninstall` | Code stops service, stops tracked proxy, uninstalls service, restores native Codex, removes state/token files. | code path exits 0/1 depending environment | High mutation/destructive local state. | README/docs-site cover. | Help should warn and mention `remove` alias. |
| `ocx service remove` | Code aliases `uninstall`, but help text omits it. | code path exits 0/1 depending environment | High mutation/destructive local state. | Under-documented. | Either document alias or remove from user-facing surface later. |
| `ocx service restart` | Falls into default usage path in `src/service.ts`. | 1 by code path | None if unsupported. | Not documented. | Decide later: add real restart or explicitly suggest `ocx service stop && ocx service start`. |
| `ocx service logs` | Falls into default usage path in `src/service.ts`. | 1 by code path | None if unsupported. | Not documented, but service status exposes log path. | Candidate: `service logs` could print/tail `serviceLogPath()`, or docs should point to path. |
| `ocx codex-shim --help` | Prints `Usage: ocx codex-shim <install|status|uninstall>`. | 0 | None. | README/docs-site cover. | Add nested help and mention `remove` alias if retained. |
| `ocx codex-shim install` | Code installs wrapper/launcher for `codex`; may write shell/cmd/ps1 shims. | code path exits 0/1 depending environment | Mutates user command path/shim files. | README/docs-site cover. | Help should state what is installed and how to undo. |
| `ocx codex-shim status` | Code reports shim status. | code path exits 0/1 depending environment | Read-only. | README/docs-site examples. | Candidate for machine-readable status later. |
| `ocx codex-shim uninstall` | Code removes shim files. | code path exits 0/1 depending environment | Mutates shim files. | README/docs-site cover. | Help should mention `remove` alias. |
| `ocx codex-shim remove` | Code aliases `uninstall`, but help text omits it. | code path exits 0/1 depending environment | Mutates shim files. | Under-documented. | Either document alias or hide intentionally. |
| `ocx codex-shim restart` | Falls into default usage path in `src/cli.ts` nested switch. | 1 by code path | None if unsupported. | Not documented. | Probably reject; shim is not a long-running process. |

## Missing Or Candidate Commands

| Command | Current result | Exit | Side-effect risk | Docs coverage | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `ocx restart` | Unknown command, then top-level help. | 1 | None. | Not documented. | Decide whether top-level restart should mean `stop && start`; risky because `start` blocks. Prefer `service restart` or docs guidance first. |
| `ocx restart --help` | Prints top-level help and exits 0 because unknown commands with help bypass the unknown-command error. | 0 | None. | Not documented. | Fix help routing later so unsupported commands do not look successful without explanation. |
| `ocx doctor` | Unknown command, then top-level help. | 1 | None. | Not documented. | Strong candidate for read-only diagnostics aggregate. |
| `ocx doctor --json` | Unknown command, then top-level help. | 1 | None. | Not documented. | Future machine-readable diagnostics candidate. |
| `ocx logs` | Unknown command, then top-level help. | 1 | None. | Not documented. | Consider top-level alias to service/proxy log locations, or explicitly keep under `service logs`. |
| `ocx logs --help` | Prints top-level help and exits 0. | 0 | None. | Not documented. | Same unknown+help routing gap. |
| `ocx usage` | Unknown command, then top-level help. | 1 | None. | Not documented. | Do not add unless product has a clear usage/quota surface; avoid ambiguity with ChatGPT account pool usage. |
| `ocx commands` | Unknown command, then top-level help. | 1 | None. | Not documented. | Low value if top-level help is improved. |
| `ocx status --json` | Prints human status; ignores `--json`. | 0 | Read-only. | Not documented. | Add JSON only after schema is planned; current behavior is unsafe for agents to parse as JSON. |
| `ocx start --port bad --help` | Prints start help and exits 0; invalid option is not validated when help is present. | 0 | None. | Not documented. | Acceptable if help wins; document parser policy later. |
| `ocx update --tag bad --help` | Prints update help and exits 0; invalid tag is not validated when help is present. | 0 | None. | Not documented. | Acceptable if help wins; document parser policy later. |

## Documentation Coverage Gaps

- README lists most top-level commands, but not a first-class `--help`, `-h`, `--version`, or `--json` contract.
- docs-site CLI reference documents service/shim families, but current nested help is too short to support agentic usage without reading docs.
- docs-site currently says `ocx gui` is omitted from the short `ocx help` listing. In the source snapshot inspected for this matrix, top-level usage also omits `gui`, while `gui --help` exists and README lists it. This should be reconciled during the help rewrite.
- `remove` aliases are implemented for top-level uninstall, service uninstall, and codex-shim uninstall, but help/docs coverage is inconsistent.
- `sync-cache` is a public command in source help but sparse in public docs.
- No public docs promise `ocx status --json`; therefore later JSON work should introduce a schema and tests rather than silently changing undocumented behavior.

## Recommended Later PABCD Slices

1. Version and help routing slice:
   - add one-line `ocx --version`, `ocx -v`, and possibly `ocx version`;
   - make `ocx help <command>` equivalent to `ocx <command> --help`;
   - make unknown-command help behavior explicit instead of accidental.
2. Grouped human help slice:
   - reorganize top-level help into first-run, runtime, auth, service/shim, diagnostics, and recovery groups;
   - keep plain text and script-friendly output.
3. Nested lifecycle help slice:
   - add service/shim subcommand help without executing lifecycle operations;
   - document mutation risk in help text.
4. Diagnostics/JSON planning slice:
   - design `status --json` schema and possible `doctor` read-only aggregate;
   - ensure output excludes secrets and has stable exit behavior.

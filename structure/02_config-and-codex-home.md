# Config And Codex Home SOT

## Codex home

`src/codex/paths.ts` resolves Codex state from `CODEX_HOME` when set and valid, otherwise from
`~/.codex`. An unset `CODEX_HOME` falls back to `~/.codex`, including WSL discovery. An explicitly
set path that is unreadable or not a directory is an error, not a fallback: silently using a
different home than the operator named would write provider state where nobody is looking for it.
The managed files are:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/opencodex-journal.json
$CODEX_HOME/models_cache.json
$CODEX_HOME/.opencodex-native-main-profiles/
```

Never assume macOS-only paths. Windows, service installs, and app-launched Codex can all depend on
the resolved `CODEX_HOME`.

Service install-state ownership uses this same resolver. In WSL, an unset `CODEX_HOME` may resolve
to the single discoverable Windows Desktop home; recording Linux `~/.codex` instead would make a
later repair or uninstall look foreign even though the service and runtime were started from the
same environment. An explicit `CODEX_HOME` remains authoritative, and existing foreign ownership
records are never migrated implicitly.

[Decision Log]
- 목적과 의도: Keep service ownership metadata aligned with the Codex home the proxy actually uses.
- 기존 구현 및 제약 조건: The runtime performed narrow WSL Windows-home discovery, while service state used `CODEX_HOME || ~/.codex`.
- 검토한 주요 대안: Bake `CODEX_HOME` into every service, migrate old state automatically, or reuse the runtime resolver.
- 선택한 방식: Resolve service install and comparison state through the existing runtime Codex-home resolver.
- 다른 대안 대신 이 방식을 선택한 이유: It preserves explicit overrides and the existing WSL ambiguity rules without rewriting user environment or foreign state.
- 장점, 단점 및 영향: New installs and same-environment repairs agree with runtime targeting; genuinely foreign or ambiguous state remains fail-closed.

SQLite-backed thread state may live outside `CODEX_HOME`. The one resolver in `src/codex/paths.ts`
uses Codex's precedence: root `sqlite_home` in the effective `config.toml`, then
`CODEX_SQLITE_HOME`, then the effective `CODEX_HOME`; relative SQLite homes resolve from the current
working directory. History jobs resolve the database and its hashed backup identity together at
call time, and admission/residue checks consume the same database path. Storage retention still
owns the Codex-home tree separately and does not gain deletion authority over an external SQLite
root from this resolver alone. Durable service launchers preserve an explicitly supplied
`CODEX_SQLITE_HOME` so a background service resolves the same split state as the installing shell.
An absent `config.toml` or absent root `sqlite_home` permits the environment/home fallback. Any
other read failure, malformed TOML, wrong-typed or blank `sqlite_home` is indeterminate and fails
closed so history code cannot select a different database by accident. This strict parse is scoped
to SQLite ownership; the tolerant root-string helper used by injection and catalog reads is unchanged.

[Decision Log]
- 목적과 의도: Make every history safety check and mutation address the SQLite database Codex actually opened.
- 기존 구현 및 제약 조건: History code rebuilt `CODEX_HOME/state_5.sqlite`, while Codex supports a config or environment-selected SQLite root for split Windows/WSL layouts.
- 검토한 주요 대안: Copy the database into CODEX_HOME, teach only the writer about the override, or centralize the call-time target.
- 선택한 방식: Add one Codex-compatible SQLite resolver, fail closed when its authoritative config is unreadable or its present `sqlite_home` cannot be parsed as a non-empty string, and share it across history jobs, provider defaults, admission, and residue classification.
- 다른 대안 대신 이 방식을 선택한 이유: A writer-only override would let ownership checks authorize one database while the mutation touched another.
- 장점, 단점 및 영향: Split-home history remains correct and backup identities stay database-specific; storage cleanup of an external root remains out of scope.

Native-main profile ownership is bound to the real `CODEX_HOME`, not to an OpenCodex instance.
Its encrypted vault, transaction journal, recovery marker, and referenced quarantine files live in
the owner-only `.opencodex-native-main-profiles` directory. The unchanged
`.opencodex-native-profile.lock.sqlite` beside that directory serializes every process sharing the
home. Only plaintext login staging is instance-local under
`$OPENCODEX_HOME/native-main-profile-staging`; a stage from one instance is invalid in another.
These paths and the OS keyring are owner-only: the operating-system account that owns them is the
trust boundary and already has direct access to active native credentials. OpenCodex detects and
fails closed on file identities that change during an operation, but it does not claim isolation
from a malicious process already running as that same trusted OS account.

Startup and the periodic stage cleaner do not acquire the profile transaction lock when both the
stage registry and this instance's staging tree are proven absent. This keeps an unused profile
subsystem from fencing native traffic or creating lock contention. Presence, an unsafe entry type,
or any observation error still takes the locked sweep and fails closed; the fast path is based only
on proven absence, never on an unreadable path.

[Decision Log]
- 목적과 의도: Keep zero-profile and zero-stage installations out of the native-profile transaction path without weakening staged-credential cleanup.
- 기존 구현 및 제약 조건: Every live server swept stages at startup and every minute, and a failed sweep closed the global native-main gate even when no stage artifact existed.
- 검토한 주요 대안: Disable native-main ownership entirely when the vault is empty, add a stale-lock deletion command, or skip only the stage sweep when both artifact paths are absent.
- 선택한 방식: Preserve owner and claim protection, but bypass `sweepStages()` only after proving the registry and staging tree are both absent.
- 다른 대안 대신 이 방식을 선택한 이유: Physical credential ownership remains cross-process safe, while an inert optional subsystem can no longer create the reported lock/recovery catch-22.
- 장점, 단점 및 영향: Fresh installs avoid the SQLite profile lock; any present or uncertain stage state retains the existing locked fail-closed cleanup and recovery behavior.

The native-write coordinator is keyed by the canonical `CODEX_HOME` in the effective-user runtime
namespace. A pathname alone is not authority: SQLite can expose a zero-byte file before its first
schema write, and a terminated process can leave that remnant behind. Eligibility treats the file
as non-authoritative only after an immutable SQLite read proves version zero with no tables, the
filesystem identity remains unchanged, and the file has been settled for at least one second; a
fresh zero-byte creator stays on the coordinated path so its lock cannot be bypassed. `ocx doctor` inspects the
coordinator with immutable read-only SQLite flags so diagnosis never creates WAL/SHM sidecars. It
distinguishes absent, zero-byte, unversioned, rowless, valid, unsupported, changed, unsafe, and
unreadable states and prints the exact path. Explicit recovery is available only after the proxy is
stopped and only for a proven zero-byte state. The command revalidates the same private
regular-file identity under a non-blocking SQLite write lock and moves it to a same-directory
backup; it never deletes or auto-adopts legacy routed residue.

[Decision Log]
- 목적과 의도: Recover a crashed zero-byte coordinator without mistaking SQLite's normal creation window for stale authority.
- 기존 구현 및 제약 조건: Eligibility treated every existing pathname as coordinated, while initialization correctly refused a missing row over routed residue; catalog sync could therefore succeed before config injection failed permanently.
- 검토한 주요 대안: Delete zero-byte files automatically, initialize a new row over residue, require a manual filesystem command, or add observe-only classification plus explicit guarded quarantine.
- 선택한 방식: Treat only a settled, identity-stable, immutably verified zero-byte database like the existing legacy-uncoordinated boundary; keep fresh creators coordinated, diagnose all other database states immutably, and expose an opt-in zero-byte-only same-directory backup move with identity, ownership, sidecar, liveness, and SQLite-lock checks.
- 다른 대안 대신 이 방식을 선택한 이유: Automatic deletion or adoption can race a live creator or erase transition evidence; a guarded backup preserves evidence and makes the operator action reproducible.
- 장점, 단점 및 영향: A stale zero-byte file no longer wedges sync, valid/unrecognized databases remain fail-closed, and recovery requires the proxy to be stopped before `ocx sync` retries injection.

OpenCodex never overrides an explicit `CODEX_HOME`. On Windows, `ocx doctor` and `ocx status`
nevertheless diagnose the high-confidence Orca dual-home case: both `CODEX_HOME` and
`ORCA_CODEX_HOME` select Orca's `orca/codex-runtime-home/home`, while the ChatGPT/Codex app uses the
default `%USERPROFILE%\\.codex`. Sync and restore output always prints the exact target Codex home;
display and JSON paths redact the OS username. The diagnostic tells users to invoke OpenCodex with
the app home explicitly rather than silently claiming that an unrelated app was configured. If a
service was installed under the Orca home, it must first be uninstalled from that original Orca
environment and then reinstalled under the app home; changing only the current shell cannot migrate
the recorded service ownership.

[Decision Log]
- 목적과 의도: Make multi-home injection truthful without taking ownership of user environment variables.
- 기존 구현 및 제약 조건: CODEX_HOME is an intentional override, but Orca exports it for its own bundled runtime and the Windows app reads a different home.
- 검토한 주요 대안: Rewrite CODEX_HOME automatically, warn for every custom home, or detect only the Orca-owned signature and report the target path.
- 선택한 방식: Preserve the override, add a narrow Windows/Orca diagnostic, and qualify sync/restore success output with the effective home.
- 다른 대안 대신 이 방식을 선택한 이유: It fixes the silent failure while avoiding destructive or noisy behavior for intentional custom homes.
- 장점, 단점 및 영향: Orca users get an actionable warning; other multi-home products remain unchanged until they have an equally reliable signature.

`atomicWriteFile` uses a temp file named `{path}.ocx.{pid}.{seq}.tmp` (process ID + incrementing
sequence number) to avoid collisions when concurrent writers (e.g. `ocx stop` and the proxy's own
shutdown handler) both restore Codex config simultaneously. The temp is renamed atomically into place.

Windows secret-file hardening resolves the effective token SID through an absolute, trusted
PowerShell path before granting the owner and removing inherited broad ACL entries. The normal
path obtains System32 from `GetSystemDirectoryW`. Windows ARM64 Bun builds that cannot execute
`bun:ffi` use a narrower ACL-only fallback to the fixed protected default installation path
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`. The fallback never applies to UAC or
Task Scheduler launch, never consults environment variables or `PATH`, and fails closed when the
fixed executable is absent.

Direct PowerShell children rely on the process launcher's `windowsHide`/hidden-host mechanism and
must not also receive the PowerShell CLI pair `-WindowStyle Hidden`. On affected Windows 11 systems,
Bun 1.3.14 exits that direct invocation before the command runs, which turns a valid SID or process
lookup into `EACLIDENTITY` or a failed sync. This does not apply to `Start-Process -WindowStyle
Hidden` inside an already-running PowerShell script, nor to .NET/VBS process-window settings.

[Decision Log]
- 목적과 의도: keep trusted Windows identity and process probes console-less without triggering Bun's direct PowerShell `-WindowStyle Hidden` failure.
- 기존 구현 및 제약 조건: the calls already used `windowsHide: true` or a hidden VBS host, but redundantly passed PowerShell's window-style CLI option; the same option remains valid inside `Start-Process` and must not be removed there.
- 검토한 주요 대안: decode the generic failure specially, retry after failure, remove all hidden-window controls, or remove only the redundant direct CLI pair.
- 선택한 방식: retain trusted executable resolution, non-interactive flags, timeouts, and process-level hiding; remove `-WindowStyle Hidden` only from direct PowerShell argv.
- 다른 대안 대신 이 방식을 선택한 이유: the command executes on affected Bun/Windows combinations, no console window is introduced, and working elevated/detached child-process behavior stays unchanged.
- 장점, 단점 및 영향: SID, process-owner, tray, update, and sync probes share the compatible launch contract; a future call must use launcher-level hiding rather than reintroducing the PowerShell CLI pair.

[Decision Log]
- 목적과 의도: Preserve required Windows ACL hardening on the bundled Windows ARM64 runtime without weakening executable trust.
- 기존 구현 및 제약 조건: The effective-SID query depended on the shared `GetSystemDirectoryW` FFI resolver; Bun 1.3.14 Windows ARM64 has no working `bun:ffi`, so config mutation reached `EACLIDENTITY` before PowerShell could start.
- 검토한 주요 대안: Restore `USERDOMAIN\\USERNAME`; trust `SystemRoot`, `WINDIR`, or `PATH`; weaken required ACL writes; broaden the shared elevation resolver; or add a fixed-path fallback only for the non-elevated SID query.
- 선택한 방식: Keep FFI authoritative, then allow only Windows ARM64 to use the existing default `C:\Windows\System32` PowerShell binary for the SID query when that exact file exists.
- 다른 대안 대신 이 방식을 선택한 이유: Names and environment paths are caller-controlled, required secret writes must not silently skip ACLs, and elevation has a larger authority boundary that should remain FFI-only.
- 장점, 단점 및 영향: Default Windows ARM64 installations can start and harden secrets; non-default Windows roots continue to fail closed until Bun exposes a trustworthy native system-directory API without FFI.

Response-state loading performs a bounded recovery pass for interrupted snapshot writes. It only
matches regular files named `responses-state.json.ocx.<pid>.<sequence>.tmp`, waits at least 15
minutes, and skips the current or any live PID. Eligible files are truncated before unlinking so a
matching stale path is unlinked without following it. Path-based truncation is intentionally avoided:
a same-user replacement could otherwise turn cleanup into a write through a symlink. Unrelated
temporary files, symlinks, directories, and young/active writes are never touched; directory entries
are consumed incrementally and at most 512 stale files are attempted per process start.

[Decision Log]
- 목적과 의도: Bound disk and conversation-state retention after abrupt process termination.
- 기존 구현 및 제약 조건: Ordinary write failures clean up immediately, but a killed process cannot run that path and Windows may temporarily lock files.
- 검토한 주요 대안: Delete every `.tmp`, rely on manual cleanup, or recover only exact response-state remnants with age and PID guards.
- 선택한 방식: Run a capped, best-effort, unlink-only sweep on lazy response-state startup.
- 다른 대안 대신 이 방식을 선택한 이유: It repairs known remnants without broad authority over unrelated temp files or active writers.
- 장점, 단점 및 영향: Old dead-PID files are reclaimed automatically; locked or conservatively classified files remain for a later retry.

## Config surface

`src/types.ts` is the shape and `src/config.ts` is the loader; neither is reproduced here. What
matters for maintainers is which groups exist and who resolves them:

| Group | Keys | Resolution rule |
| --- | --- | --- |
| Listener | `port`, `hostname` | The listener owns the port; `runtime-port.json` reports where it actually landed. |
| Routing | `defaultProvider`, `providers`, per-provider `selectedModels` | Explicit `provider/model` wins over `defaultProvider`. |
| Catalog | `disabledModels`, `customModels`, `modelCacheTtlMs`, `providerContextCaps`, `contextCapValue`, `codexAccountNamespaces`, `codexAccountPickerEnabled` | Catalog state is derived; config only records intent. The picker flag is an explicit visibility override, while selector mappings remain the durable exact-routing contract. |
| Retained state | `appOwnedMemoryBudgetMb` | Process-wide eviction target for app-owned logs, caches, blobs, and continuation payloads. Default 256 MiB, valid 64..4096; pinned state may temporarily exceed the target, but every pin-capable store has a finite local cap and their documented aggregate stays below `APP_OWNED_WORST_CASE_PINNED_BYTES` (512 MiB). Neither value caps RSS or native runtime memory. |
| Transport | stream mode, timeouts, proxy settings, `websockets`, `emptyCompletionRetry` | `streamMode` persists in config.json; Windows services need a persisted input, and macOS uses it for explicit eager-relay opt-in. Empty-completion replay is an explicit top-level opt-in because its second upstream request may be billable. |
| Credentials | `apiKeys` | Data-plane only; never admitted to `/api/*`. |
| Lifecycle | `codexAutoStart`, shim/start behavior, resume-history sync, storage cleanup | Startup safety reads these; see [`05_gui-and-management-api.md`](05_gui-and-management-api.md). |

Env values are resolved through `src/config.ts`, so a config value naming an env var never persists
the secret itself.

## Config injection

`src/codex/inject.ts` writes one of two forms. The choice is not cosmetic: it decides whether Codex
keeps its native provider id, which decides whether existing thread history still resolves.

**Loopback (default).** A single marker-owned root override, no provider table:

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
```

Codex keeps the native `openai` provider id, so new threads stay under that identity instead of
being re-tagged. History that an earlier legacy injection re-tagged as `opencodex` is migrated back
to `openai` once, as restore machinery — a no-op when there is nothing to migrate. A user-owned root
`openai_base_url` is preserved instead of overwritten, and that case also blocks managed sub-agent
defaults rather than fighting the user for ownership.

**API auth header (non-loopback).** The built-in `openai` provider cannot carry the
`x-opencodex-api-key` env header, so this form re-tags the root provider and appends the table:

```toml
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://<host>:<port>/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENCODEX_API_AUTH_TOKEN"
```

Root TOML keys must be written before the first `[table]`. Re-injection strips the stale form of
both shapes — opencodex blocks, injected root base-url overrides, stale root context-window
overrides, and stale catalog paths — before rewriting, so switching between forms leaves no residue.

Native Codex sub-agent defaults are a separate, explicit opt-in. When
`syncCodexSubagentDefaults` is true and `injectionModel` is set, injection writes marker-owned
`agents.default_subagent_model` and, when configured,
`agents.default_subagent_reasoning_effort`. Unmarked values are user-owned and must never be
overwritten. Disabling the option and fallback restore remove only marker-owned values; journal
restore must preserve later user edits while stripping those managed values.

If the root config selects a provider other than `openai` or `opencodex`, injection must leave the
config byte-for-byte unchanged and skip profile creation/updates and history migration. External
provider managers own that routing configuration, and replacing their provider id can hide
otherwise intact Codex sessions. This ownership check must run before catalog/cache refresh,
journal creation, and the background history migration guardian.

`ocx sync` and `ocx restore back` run the injector's non-writing preflight before provider
discovery or catalog/cache replacement. Deterministic config and ownership refusals therefore
leave the existing catalog and cache untouched, and their concrete messages are emitted on stderr.
The real injection still revalidates under its normal write boundary after catalog convergence;
the preflight is an early no-write guard, not an authorization token for a later write.

[Decision Log]
- 목적과 의도: Prevent a refused Codex config injection from degrading a previously usable model catalog and make the refusal actionable from the CLI.
- 기존 구현 및 제약 조건: Catalog discovery and replacement ran before injection, while the injector alone owned the authoritative TOML transforms and write-coordination eligibility checks.
- 검토한 주요 대안: Roll back catalog and cache bytes after a later refusal, duplicate a partial TOML validator in the CLI, or run the injector's existing planning path without committing before discovery.
- 선택한 방식: Add a non-writing mode to the injector and call it before catalog work; keep the normal injector call as the final under-lock authority check.
- 다른 대안 대신 이 방식을 선택한 이유: Post-hoc rollback can overwrite a concurrent catalog writer, and a second validator would drift from the real refusal rules. Reusing the injector keeps one policy path and avoids compensating writes.
- 장점, 단점 및 영향: Deterministic refusals preserve catalog/cache bytes and print their reason on stderr. A concurrent state change can still make the final injection refuse, but catalog and injection retain their existing independent revalidation and serialization boundaries.

`supports_websockets = true` is appended to the provider table only when `websocketsEnabled(config)`
returns true.

## Codex-home diagnostics

Some Codex-home conditions are reported rather than repaired, because repairing them would overwrite
a deliberate user choice:

- Bundled-plugin marketplace state on Windows (`src/codex/plugins-doctor.ts`), surfaced by
  `ocx status`.
- Project-level Codex config that bypasses managed routing
  (`src/codex/project-config-warnings.ts`), surfaced by `ocx doctor` as a warning rather than an
  override.

## Profile and fast tier

When opencodex owns routing, it also writes `$CODEX_HOME/opencodex.config.toml` as an explicit profile
target. Codex config uses `service_tier = "fast"` and `[features].fast_mode = true`;
catalog/request tier metadata may use `priority`. Do not collapse these spellings into one value.

## Provider output defaults

`OcxProviderConfig.defaultMaxOutputTokens` and `modelMaxOutputTokens` are OpenAI Chat wire defaults,
not context-window metadata. They are applied only when a Responses request omits
`max_output_tokens`; an explicit request value wins, then a model-specific configured value, then
the provider default, then the adapter omits `max_tokens`.

Both fields must stay positive finite integers at disk-config and management validation boundaries.
Registry entries may seed them through `providerConfigSeed`, key-login derivation, OAuth reconcile,
and `routeModel`, but user config overrides registry defaults per field/key.

## Restore

`ocx stop`, `ocx restore` / `ocx eject`, `ocx service stop`, and `ocx service uninstall` must strip
opencodex config and routed catalog entries without damaging native Codex state.

Full `ocx uninstall` config cleanup is ownership-manifest based. A fresh config directory receives a
root-bound owner marker and an uninstall manifest before its first atomic config write. Uninstall
validates both bounded metadata files, rejects path traversal and a symlink/junction config root,
and removes only normalized manifest entries. Manifest-owned directory links are unlinked without
traversing their targets. Unknown files remain in place and make the command report a partial
uninstall with their exact paths.

Legacy nonempty config directories are deliberately not retroactively claimed. If either ownership
file is missing, malformed, or bound to another root, uninstall refuses config deletion and reports
the residual directory for manual review; there is no recursive-delete fallback.

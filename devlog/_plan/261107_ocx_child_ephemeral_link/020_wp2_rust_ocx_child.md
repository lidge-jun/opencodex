# `wp2` — Standalone Lightweight Rust Child Crate (`native/ocx-child`)

> Continuity handoff (`LOOP-CONTINUITY-01` from `wp1` D at `07f50076e5`): `wp1` landed the 74-vector `tests/fixtures/link/ocx-child-conformance.json` and `tests/clients/link-ocx-child-conformance.test.ts` (`65 pass, 0 fail`). Revalidated `020_wp2_rust_ocx_child.md` against `07f50076e5` and folded the `wp0` non-blocking Medium note: `Cargo.toml` sets crate `version = "0.1.0"` (matching `native/remote-workspace-helper/Cargo.toml:3`) while `pub const OCX_PROTOCOL_COMPAT_VERSION: &str = "2.98.0"` drives `--version` (`opencodex 2.98.0`) and peer headers, preventing `dev-version-bump.yml` drift on `package.json` bumps. Architect consultation: covered by `ARCH-01..ARCH-04` (`ALIGNED` on `01a1b18b-a2f3-7b53-971a-9b2c9cccecf7`, `000_roadmap.md` §3.1).

- **Phase ID**: `wp2` (depends on `wp1`; satisfies `c-3`, `c-6`)
- **Header dependencies**:
  - Consumes shared fixture `ConformanceSuite` (`tests/fixtures/link/ocx-child-conformance.json`) and wire/schema contracts `EphemeralChildConfigProjection` (`src/link/ephemeral-child.ts`), `HomeCodexSettingsDocument` / `HomeCodexSettings` (`src/link/codex-settings.ts:30`), `LinkChildParityReport` (`src/link/child-parity.ts:28`), `ClientSyncMismatchReason` (`src/client/sync-expectation.ts:17`), and `FanoutDocument` (`src/cli/sync-fanout.ts:86`).
  - Introduces Rust types `ChildStateV1`, `ChildJournalV1`, `ChildInjectedLedger`, `RelayServer`, `SingleSocketUpstream`, and binary `ocx-child` (`2.98.0`).
- **Scope**:
  - **IN**: `native/ocx-child/Cargo.toml` (NEW), `native/ocx-child/Cargo.lock` (NEW), `native/ocx-child/src/**` (NEW), `native/ocx-child/tests/**` (NEW).
  - **OUT**: `src/**`, `package.json` (`wp3`), `structure/**` & `docs-site/**` (`wp4`).

## 1. Exact File Map & Diff-Level Specification

### 1.1 NEW `native/ocx-child/Cargo.toml` & `Cargo.lock`

```toml
[package]
name = "opencodex-child"
version = "0.1.0"
edition = "2024"
rust-version = "1.90"
license = "MIT"
publish = false

[[bin]]
name = "ocx-child"
path = "src/main.rs"

[lib]
name = "ocx_child"
path = "src/lib.rs"

[dependencies]
base64 = "=0.22.1"
hmac = "=0.12.1"
serde = { version = "=1.0.229", features = ["derive"] }
serde_json = "=1.0.151"
sha2 = "=0.10.9"

[target.'cfg(unix)'.dependencies]
libc = "=0.2.191"

[target.'cfg(windows)'.dependencies]
windows-sys = {
  version = "=0.61.2",
  features = [
    "Win32_Foundation",
    "Win32_Security",
    "Win32_Security_Authorization",
    "Win32_Security_Cryptography",
    "Win32_Storage_FileSystem",
    "Win32_System_Threading",
  ],
}

[profile.release]
codegen-units = 1
lto = "thin"
opt-level = "s"
strip = "symbols"

[profile.release.build-override]
strip = false
```

### 1.2 NEW `native/ocx-child/src/` Module Layout

All modules set `#![deny(unsafe_op_in_unsafe_fn)]` at crate root (`lib.rs` / `main.rs`):

1. `src/lib.rs` & `src/main.rs`:
   - Exports testable library modules (`routes`, `http_wire`, `relay_auth`, `codex_settings`, `parity`, `toml_surgeon`, `journal`, `state`, `platform`, `relay`, `daemon`, `cli`).
   - `pub const OCX_PROTOCOL_COMPAT_VERSION: &str = "2.98.0";` (`>= 2.93.0`, decoupled from crate `0.1.0` so automated `package.json` bumps never cause version-lock drift).
2. `src/platform/mod.rs`, `src/platform/unix.rs`, `src/platform/windows.rs`:
   - `fill_random_bytes(&mut [u8])`: reads `/dev/urandom` on Unix and `BCryptGenRandom(..., BCRYPT_USE_SYSTEM_PREFERRED_RNG)` on Windows.
   - `volatile_zero_bytes(&mut [u8])`: `core::ptr::write_volatile` byte loop + `core::sync::atomic::compiler_fence(Ordering::SeqCst)` (`SecretBytes` zeroes on `Drop`).
   - `FileLock::acquire_blocking(path)` & `FileLock::try_acquire_nonblocking(path)`: opens lockfile with `0600` mode, acquires `libc::flock(fd, LOCK_EX)` / `LOCK_EX | LOCK_NB` on Unix and `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK)` / `LOCKFILE_FAIL_IMMEDIATELY` on Windows.
   - `write_private_atomic(path, bytes)`: ensures parent directory (`0700` on Unix; owner-only protected DACL via `SetNamedSecurityInfoW` / `PROTECTED_DACL_SECURITY_INFORMATION` on Windows), creates sibling temp file (`.tmp.<pid>.<rand>`, `O_CREAT | O_EXCL | O_WRONLY` mode `0600` on Unix and owner-only DACL on Windows), writes all bytes, `sync_all()`, and atomically `fs::rename`s into `path`.
   - `spawn_detached_serve(exe, opencodex_home, codex_home, listen_port)`: Unix `setsid` + `Stdio::null()`; Windows `CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` breaking out of Home's `OcxJob` (`JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` in `src/link/remote-windows.ts:69`).
   - `terminate_verified_daemon(pid, expected_port)`: verifies `GET http://127.0.0.1:<expected_port>/healthz` reports `service == "opencodex"`, `ephemeralChild == true`, and `pid == expected_pid` before sending `SIGTERM` / attested shutdown, polling up to 5 s until exit and port release.
3. `src/routes.rs` & `src/http_wire.rs`:
   - `classify_route(method, path, query, headers) -> RouteDecision`: exact port of `src/link/routes.ts:15`, `src/link/management-routes.ts:72`, and `src/client/link-ingress.ts:88-96`.
     - `GET /healthz` -> `LocalHealthz` returning `{ "service": "opencodex", "version": "2.98.0", "role": "client", "ephemeralChild": true, "uptime": <sec>, "pid": <pid>, "port": <port>, "startedAt": "<ISO-8601>" }` (`restartCapability` / `restartBudgetMs` are deliberately omitted because `ocx-child` does not serve `POST /api/system/restart`, and `isChildHealth(..., "client", port)` at `src/link/remote-probe.ts:35` checks only `port`, `service`, `pid`, and `role === "client"`).
     - `GET /readyz` (without `Upgrade`) -> `LocalReadyz`.
     - Loopback `Host` & `Origin` anti-rebinding gate (matching `isAllowedRequestOrigin` in `src/server/auth-cors.ts:83-125` & `src/client/link-ingress.ts:89-96`): on every relayed route and `/v1/responses` WebSocket `Upgrade`, `Host` (when parseable) must be a loopback hostname (`127.0.0.1`, `localhost`, `[::1]`) and `Origin` (when present) must be `http(s)://<loopback>(:port)`; otherwise return `403 origin_rejected`.
     - `/v1/responses` with `Upgrade: websocket` (after passing `Host`/`Origin` check) -> `Reject426Websocket` (`426 upgrade_required`, `"Responses WebSocket transport is disabled; use HTTP"`).
     - Any other `Upgrade` header -> `Reject404`.
     - Exact `POST` routes + 10 `CONTEXT_PATHS`, `GET|HEAD` `/v1/catalog` & `/v1/hub-state`, `GET /v1/models`, `GET /v1/opencodex/artifacts/*` -> `RelayData { auth: Bearer }`.
     - `GET /v1/usage` -> `RelayData { auth: ApiKeyHeader }`.
     - `GET /v1/link-management/codex-settings` (empty query) and `GET|HEAD /v1/link-management/api/...` (20 allowlisted paths without `refresh|reload|force|quota` query params) -> `RelayManagement` (16 MiB response cap).
     - Everything else -> `Reject404`.
   - `parse_and_sanitize_request_headers`: enforces `64 KiB` (`65_536` B) cap (`431`), rejects CR/LF in names/values (`400`), rejects `CL+TE` / duplicate `CL` / non-digit `CL` / non-`chunked` `TE` / `Upgrade` (`400 {"error":"link relay request headers refused"}`), strips `HOP_BY_HOP_HEADERS`, `REQUEST_OMITTED_HEADERS`, `CALLER_CREDENTIAL_HEADERS`, and `Connection`-listed tokens.
   - Enforces `256 MiB` (`268_435_456` B) inbound/non-SSE outbound body cap (`413` / `502`); streams chunked and SSE (`text/event-stream`) bodies chunk-by-chunk with immediate socket `flush()` and `300 s` header / SSE idle timeout.
4. `src/relay_auth.rs`, `src/codex_settings.rs`, & `src/parity.rs`:
   - Raw 32-byte `SHA-256(token)` HMAC key; exact `opencodex-link-relay-v2` caller/listener proofs and `opencodex-link-connection-v1` generation proofs with constant-time 32-byte comparison.
   - `SingleSocketUpstream::open_authenticated(tunnel_port, creds, probe_only)`: opens one `TcpStream` to `127.0.0.1:<tunnel_port>` (5 s timeout), sends `GET /.well-known/opencodex/link-relay-auth?version=2&...` with peer version/features headers (plus `x-opencodex-link-probe: 1` when `probe_only`), verifies `204` + 0-byte body + `x-opencodex-link-proof` (+ optional `x-opencodex-link-connection-proof`), and returns that **exact `TcpStream`** to carry the single data request with `x-opencodex-link-session: <nonce>`.
   - Exact OCX-6 `codex_settings_digest` and `LinkChildParityReport` (`<= 1024` B, immediate send on start / post-sync rollover + `[2s, 5s, 15s, 30s, 60s]` backoff then `60s` period, halting on `404`).
5. `src/toml_surgeon.rs` & `src/journal.rs`:
   - Ordered locks: `$OPENCODEX_HOME/child/lifecycle.lock` -> `$CODEX_HOME/.opencodex-write.lock`.
   - Fail-closed attach checks: refuses if `$OPENCODEX_HOME/runtime-port.json`, `ocx.pid`, full-`ocx` `config.json`, or `$CODEX_HOME/.opencodex-journal.json` exists, if a foreign listener occupies `listen_port`, or if `config.toml` has an external `model_provider` (except `base_url`-less placeholder), unmarked user `openai_base_url` / `experimental_realtime_ws_base_url`, or non-`opencodex-catalog.json` `model_catalog_json`.
   - Design B apply + `0600` `ChildJournalV1`: snapshots `preAttachConfig*`, `preAttachCatalog*`, and `preAttachModelsCacheExisted` / `preAttachModelsCacheBytesB64` / `latestModelsCacheSha256`; writes root `openai_base_url`, `experimental_realtime_ws_base_url`, `model_catalog_json`, optional `web_search = "disabled"` (saving `replacedUserWebSearchLine`), `[features]` `fast_mode` / `multi_agent_v2`, and `[agents]` subagent defaults; writes `$CODEX_HOME/opencodex-catalog.json` and refreshes `$CODEX_HOME/models_cache.json`.
   - Two-tier 100% offline `detach`: Tier 1 exact byte restore when `untouchedByExternalWriter && currentSha256 == latestInjectedConfigSha256`; Tier 2 surgical value-matched strip surviving `#1798` comment stripping while preserving user edits; fails closed (`exit 4`) on corrupt managed spans or tampered `opencodex-catalog.json`; restores pre-attach `models_cache.json` (or unlinks an unchanged cache `ocx-child` created so stale Home slugs never linger); stops owned `serve` daemon and leaves zero running process.
6. `src/cli.rs`:
   - Native & `ocx`-compatible verbs: `--version` (`opencodex 2.98.0`), `port` / `link port`, `config show --json`, `attach` / `connect --link --key-stdin --tunnel-port <P> --link-id <id>`, `serve` / `restart` (rolls over `ocx-child serve` when attached; fails closed `exit 1` without spawning any daemon when detached so zero orphan daemon can ever start), `sync [--expect-link <id>] [--json]` (under `--json`, all human/diagnostic lines write strictly to `stderr` so `stdout` emits only the single `ocx.sync.fanout/1` JSON object; validates `--expect-link` under non-blocking lock with exit-5 `child_link_mismatch` / `pending_operation` stderr JSON before any network/disk I/O; intentionally starts `ocx-child serve` if absent on an attached VM or rolls it over when `daemonStartedAtMs < appliedAtMs` so `/healthz` `startedAt >= appliedAt`, and immediately POSTs `child-parity`), `detach` / `disconnect`, `status [--json]` / `connect status [--json]` / `link status [--json]`.

### 1.3 NEW `native/ocx-child/tests/conformance.rs` & `tests/relay_and_lifecycle.rs`

- `tests/conformance.rs`: executes all 6 vector arrays from `../../tests/fixtures/link/ocx-child-conformance.json`.
- `tests/relay_and_lifecycle.rs`: integration suite with a real mock Home `hub-link` HTTP/1.1 + SSE server verifying same-socket peer binding, single-use `nonce`, SSE streaming, smuggling/Upgrade rejection, caller credential stripping, `attach -> serve -> sync -> rollover + parity -> #1798 offline detach`, busy-lock/mismatch `--expect-link` exit `5`, and fail-closed attach/detach conflicts.

## 2. Conditional-Path Activation Scenarios (`C-ACTIVATION-GROUNDING-01`)

1. **Same-socket binding**: Mock Home verifies preflight and data request share identical client `SocketAddr`.
2. **Spoofed Home listener proof**: Mock Home returns bad `x-opencodex-link-proof` -> `ocx-child` returns `503 link_relay_auth_failed` without sending `ocx_data_*`.
3. **`#1798` comment-stripped offline detach**: Strip all `#` comments while Home is stopped -> `ocx-child detach` strips proxy keys by value and preserves user keys.
4. **Busy-lock & mismatch `--expect-link` exit `5`**: Hold `lifecycle.lock` while invoking `sync --expect-link` -> observe exit `5` and `{"phase":"child_link_mismatch","reason":"pending_operation"}` on stderr.
5. **Fail-closed attach**: Plant `runtime-port.json` or external `model_provider` -> observe non-zero refusal with `config.toml` untouched.

## 3. Phase Verifiers

- `cargo fmt --manifest-path native/ocx-child/Cargo.toml --check` (exit `0`)
- `cargo clippy --locked --manifest-path native/ocx-child/Cargo.toml --all-targets -- -D warnings` (exit `0`)
- `cargo test --locked --manifest-path native/ocx-child/Cargo.toml` (exit `0`)
- `cargo build --release --locked --manifest-path native/ocx-child/Cargo.toml` (exit `0`, stripped binary size recorded)

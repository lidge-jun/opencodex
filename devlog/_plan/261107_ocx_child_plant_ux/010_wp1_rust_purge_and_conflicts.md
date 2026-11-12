# Work-Phase 1 (`wp1`): `native/ocx-child` `--purge` & Conflict Markers + `src/link/` Foundations

> Depends on: `000_roadmap.md` (`ARCH-01..ARCH-05`). Consumed types: `LinkRecord`, `SshRunner`, `packedPowerShellArgv`, `ChildPaths`. Exported types: `LinkChildKind`, `ChildTargetTriple`, `RemoteRuntimeKind`, `ChildBinarySource`, `RemoteRuntimeInspection`.

## 1. File Change Map

| Action | Path | Summary |
|---|---|---|
| MODIFY | `native/ocx-child/src/platform.rs` | Add `PurgeExecutableOutcome`, `is_managed_plant_executable(exe_path, user_home, local_appdata)`, and `purge_managed_executable(exe_path, user_home, local_appdata)` (refusing symlinks/reparse points and foreign paths; POSIX `fs::remove_file`; Windows rename-aside + detached `cmd.exe /d /c` cleanup) |
| MODIFY | `native/ocx-child/src/daemon.rs` | Prefix `ensure_port_available_for_attach` conflict errors with `ocx-child-conflict:child_port_busy:` so Home maps foreign port ownership deterministically to `409 child_port_busy` |
| MODIFY | `native/ocx-child/src/toml_surgeon.rs` | Prefix `detect_unowned_root_routing_conflict` external provider / user `openai_base_url` errors with `ocx-child-conflict:child_external_provider_conflict:` |
| MODIFY | `native/ocx-child/src/cli.rs` | Extend `cmd_detach` (`detach` / `disconnect`) to accept `--purge` (reject unknown flags with exit `2`), drop `FileLock` and remove `lock_file` + empty `$OPENCODEX_HOME/child` dir, and run `purge_managed_executable` when `--purge` is passed |
| MODIFY | `native/ocx-child/tests/relay_and_lifecycle.rs` | Add Rust integration tests for `detach --purge` (managed path removed + empty `child` dir removed; foreign path preserved; symlink refused) and structured `child_port_busy` / `child_external_provider_conflict` stderr prefixes |
| MODIFY | `src/link/store.ts` | Add `export type LinkChildKind = "full" | "ephemeral"` and optional `childKind?: LinkChildKind` to `LinkRecord` + `"childKind"` in `RECORD_KEYS` |
| NEW | `src/link/child-binary-source.ts` | Resolve `ocx-child` binary for `ChildTargetTriple` across `OPENCODEX_CHILD_BIN_DIR`, sidecar dirs, `native/ocx-child/target/release` (when `targetTriple === hostChildTargetTriple()`), and `$OPENCODEX_HOME/cache/ocx-child/<version>/` with `SHA256SUMS` verification |
| MODIFY | `src/link/remote-windows.ts` | Add `windowsInspectRuntimeArgv()` and `windowsPlantChildArgv(expectedBytes, expectedSha256)` + `windowsPurgePlantedChildArgv()` staying strictly below `POWERSHELL_ENCODED_MAX = 8000` inside `OcxJob` |
| NEW | `src/link/remote-plant.ts` | Implement `ChildTargetTriple`, `RemoteRuntimeKind`, `parseTargetTriple`, `remoteInspectRuntimeArgv`, `inspectRemoteChildRuntime`, `remotePlantChildArgv`, `remotePurgePlantedChildArgv`, and `classifyChildAttachConflict` |
| NEW | `tests/clients/link-child-plant-foundations.test.ts` | Unit tests for `child-binary-source.ts` (`SHA256SUMS` pass/mismatch, symlink refusal, `OPENCODEX_CHILD_BIN_DIR`, host release fallback), `LinkRecord.childKind` roundtrip, and POSIX/Windows inspect & plant argv budgets (`<= 8000`) |
| MODIFY | `scripts/test-layout/layout-clients.json` & `tests/fixtures/test-layout-expected.json` | Register `tests/clients/link-child-plant-foundations.test.ts` |

## 2. Diff-Level Specifications

### 2.1 `native/ocx-child/src/platform.rs` & `cli.rs` (`--purge`)

```diff
--- a/native/ocx-child/src/platform.rs
+++ b/native/ocx-child/src/platform.rs
@@ -876,5 +876,82 @@ pub fn resolve_codex_home() -> PathBuf {
     if let Some(custom) = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
         return PathBuf::from(custom);
     }
     resolve_user_home().join(".codex")
 }
+
+#[derive(Debug, Clone, PartialEq, Eq)]
+pub enum PurgeExecutableOutcome {
+    Removed,
+    SkippedUnmanagedPath,
+}
+
+pub fn is_managed_plant_executable(
+    exe_path: &Path,
+    user_home: &Path,
+    local_appdata: Option<&Path>,
+) -> Result<bool, String> {
+    reject_symlink(exe_path)?;
+    let Some(parent) = exe_path.parent() else { return Ok(false); };
+    reject_symlink(parent)?;
+    let expected_name = if cfg!(windows) { "ocx-child.exe" } else { "ocx-child" };
+    if exe_path.file_name().and_then(|n| n.to_str()) != Some(expected_name) {
+        return Ok(false);
+    }
+    let canon_parent = fs::canonicalize(parent)
+        .map_err(|e| format!("failed canonicalizing {}: {e}", parent.display()))?;
+    let cache_bin = user_home.join(".cache").join("opencodex").join("bin");
+    if fs::canonicalize(&cache_bin).ok().as_ref() == Some(&canon_parent) {
+        return Ok(true);
+    }
+    if let Some(appdata) = local_appdata {
+        let win_bin = appdata.join("opencodex").join("bin");
+        if fs::canonicalize(&win_bin).ok().as_ref() == Some(&canon_parent) {
+            return Ok(true);
+        }
+    }
+    Ok(false)
+}
+
+pub fn purge_managed_executable(
+    exe_path: &Path,
+    user_home: &Path,
+    local_appdata: Option<&Path>,
+) -> Result<PurgeExecutableOutcome, String> {
+    if !is_managed_plant_executable(exe_path, user_home, local_appdata)? {
+        return Ok(PurgeExecutableOutcome::SkippedUnmanagedPath);
+    }
+    #[cfg(unix)]
+    {
+        fs::remove_file(exe_path)
+            .map_err(|e| format!("failed removing planted ocx-child {}: {e}", exe_path.display()))?;
+        Ok(PurgeExecutableOutcome::Removed)
+    }
+    #[cfg(windows)]
+    {
+        use std::os::windows::process::CommandExt;
+        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
+        const DETACHED_PROCESS: u32 = 0x0000_0008;
+        let parent = exe_path.parent().ok_or_else(|| "missing parent".to_owned())?;
+        let trashed = parent.join(format!(".ocx-child.purge.{}.old", std::process::id()));
+        let _ = fs::remove_file(&trashed);
+        fs::rename(exe_path, &trashed)
+            .map_err(|e| format!("failed renaming planted ocx-child for purge: {e}"))?;
+        let cmd_line = format!(
+            "ping -n 2 127.0.0.1 >nul & del /f /q "{}"",
+            trashed.display()
+        );
+        let _ = Command::new("cmd.exe")
+            .args(["/d", "/c", &cmd_line])
+            .stdin(Stdio::null())
+            .stdout(Stdio::null())
+            .stderr(Stdio::null())
+            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
+            .spawn();
+        Ok(PurgeExecutableOutcome::Removed)
+    }
+}
```

In `native/ocx-child/src/cli.rs` (`cmd_detach`):
- Parse `--keep-catalog`, `--json`, `--purge`; reject unknown flags with exit `2`.
- Hold `FileLock` during daemon stop, `offline_detach`, and removal of `key_file` + `state_file`; then explicitly `drop(lock)`, remove `paths.lock_file` and attempt `fs::remove_dir(&paths.child_dir)` (ignoring non-empty `Err`, plus `fs::remove_dir(&paths.opencodex_home)` only when empty) so a detached ephemeral Child leaves zero stale files in `$OPENCODEX_HOME/child/`.
- When `purge` is true, resolve `current_exe` (using `OCX_CHILD_SELF_EXE_FOR_TEST` override only under explicit test env or `std::env::current_exe()` — better: factor `detach_with_exe(args, current_exe_override: Option<&Path>)` for Rust library integration tests without any env-var backdoor in production!) and call `purge_managed_executable`, reporting `"purged": true | false` in JSON output.

### 2.2 Conflict Markers in `daemon.rs` and `toml_surgeon.rs`

```diff
--- a/native/ocx-child/src/daemon.rs
+++ b/native/ocx-child/src/daemon.rs
@@ -80,14 +80,14 @@ pub fn ensure_port_available_for_attach(port: u16, owned_pid: Option<u32>) -> Re
         return Err(format!(
-            "attach refused: 127.0.0.1:{port} is already served by foreign listener (pid {})",
+            "ocx-child-conflict:child_port_busy: attach refused: 127.0.0.1:{port} is already served by foreign listener (pid {})",
             health.pid
         ));
     }
     if TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).is_err() {
         return Err(format!(
-            "attach refused: 127.0.0.1:{port} is already in use"
+            "ocx-child-conflict:child_port_busy: attach refused: 127.0.0.1:{port} is already in use"
         ));
     }
```

```diff
--- a/native/ocx-child/src/toml_surgeon.rs
+++ b/native/ocx-child/src/toml_surgeon.rs
@@ -399,7 +399,7 @@ pub fn detect_unowned_root_routing_conflict(content: &str) -> Result<(), String>
     if let Some(ext) = external_codex_model_provider(content) {
         return Err(format!(
-            "attach refused: an external Codex model_provider ({ext}) owns config.toml"
+            "ocx-child-conflict:child_external_provider_conflict: attach refused: an external Codex model_provider ({ext}) owns config.toml"
         ));
     }
```
(Apply the exact `ocx-child-conflict:child_external_provider_conflict:` prefix to all three conflict branches in `detect_unowned_root_routing_conflict` — `external_codex_model_provider` at `toml_surgeon.rs:399`, unmarked `openai_base_url` / `experimental_realtime_ws_base_url` at `toml_surgeon.rs:421`, and unmarked user-owned `model_catalog_json` at `toml_surgeon.rs:433` — preserving `"attach refused:"` so all existing tests stay green.)

### 2.3 `src/link/store.ts`, `src/link/child-binary-source.ts`, and `src/link/remote-plant.ts`

1. `src/link/store.ts`:
   ```diff
   +export type LinkChildKind = "full" | "ephemeral";
   +
    export interface LinkRecord {
      ...
      createdAt: string;
      remotePlatform?: "posix" | "windows";
   +  childKind?: LinkChildKind;
    }
   -const RECORD_KEYS = new Set(["id", "alias", "direction", "hostKeyFingerprint", "tunnelPort", "apiKeyId", "createdAt", "remotePlatform"]);
   +const RECORD_KEYS = new Set(["id", "alias", "direction", "hostKeyFingerprint", "tunnelPort", "apiKeyId", "createdAt", "remotePlatform", "childKind"]);
   ```
2. `src/link/child-binary-source.ts`:
   - `export type ChildTargetTriple = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "windows-x64"`
   - `export type PlantUnavailableReason = "unsupported_target" | "artifact_not_found" | "checksum_mismatch"`
   - `resolveChildBinarySource(targetTriple: ChildTargetTriple | null, options?: { env?: NodeJS.ProcessEnv; hostPlatform?: NodeJS.Platform; hostArch?: string; opencodexHome?: string; version?: string })`:
     - Returns `{ ok: true, artifact: { targetTriple, bytes: Uint8Array, sizeBytes: number, sha256: string, source: "env" | "sidecar" | "local-release" | "cache" } }` or `{ ok: false, reason: PlantUnavailableReason }`.
     - Artifact naming: `ocx-child-${targetTriple}${isWin ? ".exe" : ""}` (and in `OPENCODEX_CHILD_BIN_DIR` also accepts `<dir>/${targetTriple}/ocx-child[.exe]` when `SHA256SUMS` lists either).
     - `SHA256SUMS` requirement: for `env`, `sidecar`, and `cache` sources, requires a sibling `SHA256SUMS` file in the candidate directory containing `<64hex>  <filename>` (or `*<filename>`), verifies `lstatSync` is a regular non-symlink file (`<= 32 MiB`, `> 0` bytes, mode `& 0o022 === 0` on POSIX), reads the file once into `Uint8Array`, computes SHA-256 over those exact bytes, and returns `checksum_mismatch` if it diverges! For `local-release` (`native/ocx-child/target/release/ocx-child[.exe]` when `targetTriple === hostChildTargetTriple()`), verifies regular non-symlink file & permissions and hashes the read bytes directly.
3. `src/link/remote-plant.ts` & `src/link/remote-windows.ts`:
   - `remoteInspectRuntimeArgv(platform)`:
     - POSIX `sh -c`: emits `ocx-inspect:uname:<uname -s>:<uname -m>`, evaluates candidate order identical to `REMOTE_OCX_SCRIPT`, distinguishes `full` vs `ephemeral` (selected path basename starting with `ocx-child` or `"$selected" --help` containing `(ocx-child`), and emits `ocx-inspect:kind:<full|ephemeral|missing>` + `ocx-inspect:version:<line>` with exit `0`.
     - Windows `packedPowerShellArgv`: emits `ocx-inspect:arch:<$env:PROCESSOR_ARCHITECTURE>`, checks `OCX_CANDIDATES`, and emits `ocx-inspect:kind:<full|ephemeral|missing>` + `ocx-inspect:version:<line>` with exit `0`.
   - `remotePlantChildArgv(platform, expectedBytes, expectedSha256)`:
     - POSIX `sh -c`: `umask 077`, checks `[ ! -L "$HOME/.cache/opencodex" ] && [ ! -L "$HOME/.cache/opencodex/bin" ] && [ ! -L "$HOME/.cache/opencodex/bin/ocx-child" ]`, `mkdir -p "$HOME/.cache/opencodex/bin"`, `chmod 0700 "$HOME/.cache/opencodex/bin"`, writes stdin to `$tmp`, verifies `[ "$actual_bytes" = "$expected_bytes" ]`, verifies SHA-256 via `sha256sum` or `shasum -a 256` when available, `chmod 0700 "$tmp"`, `mv -f "$tmp" "$dest"`, and runs `"$dest" --version`.
     - Windows `packedPowerShellArgv` (`< 8000` chars): inside `NATIVE_PROCESS` (`OcxJob`), resolves `$dir = if($env:LOCALAPPDATA){"$env:LOCALAPPDATA\opencodex\bin"}else{"$env:USERPROFILE\.cache\opencodex\bin"}`, refuses `ReparsePoint` on `$dir` or `$dest`, reads `[Console]::OpenStandardInput()` bounded to `expectedBytes + 1`, checks exact length and `[Security.Cryptography.SHA256]` lowercase hex digest against `expectedSha256`, moves atomically to `$dest`, and runs `[OcxJob]::Run($dest, '"'+$dest+'" --version')`.

## 3. Conditional Activation Scenarios (`C-ACTIVATION-GROUNDING-01`)

- `--purge` on managed path vs foreign path vs symlink: Rust integration test invokes `detach_with_exe` on `.cache/opencodex/bin/ocx-child` (deletes binary + empty `child` dir), `/tmp/custom/ocx-child` (preserves binary), and symlinked `.cache/opencodex/bin/ocx-child` (refuses unlink).
- `SHA256SUMS` mismatch & symlink in `child-binary-source.ts`: unit test writes tampered `SHA256SUMS` -> observes `{ ok: false, reason: "checksum_mismatch" }`; writes symlink -> refused.
- `child_port_busy` & `child_external_provider_conflict`: Rust test binds a dummy TCP listener on `listen_port` or writes `model_provider = "custom"` -> observes exact `ocx-child-conflict:...` stderr prefix and untouched `config.toml`.

## 4. `wp1` P-Phase Continuity & Architect Reflection Amendments (`01a1b2fe-fb7d-7f00-b3c9-756fbf5e0e0c`)

- **Continuity from `wp0` D**: Resumed from `wp0` D conclusion ("Verified wp0 docs-only roadmap; next cycle wp1 starts foundations").
- **Architect `01a1b2fe-fb7d-7f00-b3c9-756fbf5e0e0c` verdict**: `ALIGNED` on `W1-ARCH-01..W1-ARCH-03`.
- **Folded refinements for `B` implementation**:
  1. `src/link/store.ts` (`parseRecord`): validate `raw.childKind === undefined || raw.childKind === "full" || raw.childKind === "ephemeral"` and preserve `childKind` on the returned `LinkRecord` so `writeLinkStore` roundtrips it cleanly.
  2. `native/ocx-child/src/platform.rs`: verify `fs::symlink_metadata(exe_path)` is an existing regular file (`file_type().is_file()`), and on Windows pass `OCX_PURGE_TARGET` via `.env("OCX_PURGE_TARGET", &trashed)` to `cmd.exe /d /c "ping -n 2 127.0.0.1 >nul & del /f /q \"%OCX_PURGE_TARGET%\""` with `CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW | DETACHED_PROCESS`.
  3. `src/link/child-binary-source.ts`: verify `lstatSync` non-symlink status on candidate directory, `SHA256SUMS` (`<= 256 KiB`), and binary (`<= 32 MiB`, `> 0`, POSIX `(mode & 0o022) === 0`).
  4. `src/link/remote-plant.ts` & `src/link/remote-windows.ts`: include `remotePurgePlantedChildArgv(platform)` (invoking `detach --purge` when runnable and unlinking the managed binary after non-symlink/non-ReparsePoint checks) and `classifyChildAttachConflict(stderr)` matching `ocx-child-conflict:child_port_busy:` and `ocx-child-conflict:child_external_provider_conflict:`.

## 5. `wp1` A-Phase Audit Fold-Backs (`01a1b309-5460-7c93-855b-d59ef8182224`, `GO-WITH-FIXES`)

1. **`B1` (Folded — Windows `OcxJob` silent breakaway & `.old` sweep)**: Because `OcxJob` sets `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` without `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, `purge_managed_executable` on Windows spawns `cmd.exe` with `CREATE_NO_WINDOW | DETACHED_PROCESS` (silent breakaway succeeds automatically; if a caller has explicit breakaway only, fallback is automatic), and both `windowsOcxArgv` (on `disconnect --purge`) and `windowsPurgePlantedChildArgv` sweep `.ocx-child.purge.*.old` in the managed bin dir after `Invoke-Native` exits.
2. **`B2` (Folded — Managed ancestor symlink/reparse checks)**: Canonicalize `user_home` / `local_appdata` root once, then reject symlinks/reparse points on every managed subpath component (`.cache`, `.cache/opencodex`, `.cache/opencodex/bin`, `ocx-child` and `opencodex`, `opencodex/bin`, `ocx-child.exe`) in Rust `is_managed_plant_executable` as well as POSIX and Windows plant/purge scripts.
3. **`B3` (Folded — `SHA256SUMS` fail-closed precedence)**: In `resolveChildBinarySource`, when a candidate binary exists in `env`, `sidecar`, or `cache` and fails `SHA256SUMS` (`checksum_mismatch`) or symlink/permission checks (including POSIX `(mode & 0o022) === 0` on `SHA256SUMS`), return `{ ok: false, reason: "checksum_mismatch" }` immediately without falling through to `local-release`. Also include `windowsPurgePlantedChildArgv()` in the `<= 8000` encoded-command budget test.


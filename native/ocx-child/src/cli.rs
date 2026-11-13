use std::fs;
use std::io::{self, BufRead, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::codex_home::{
    ClaimPolicy, CodexHomeError, CodexHomeGuard, OwnershipPhase, RestoreStepError,
};
use crate::codex_settings::{
    HomeCodexSettings, HomeCodexSettingsDocument, HomeIdentity, codex_settings_digest,
    parse_home_codex_settings_document,
};
use crate::daemon::{
    ensure_port_available_for_attach, pick_ephemeral_link_port, probe_local_healthz,
    start_or_rollover_daemon, stop_owned_daemon,
};
use crate::journal::{
    DetachError, apply_attach_or_sync, offline_detach_deferred, remove_optional_file,
    validate_existing_journal_paths,
};
use crate::parity::LinkChildParityReport;
use crate::platform::{
    DirectoryIdentity, FileLock, LockAcquireError, PurgeExecutableOutcome, SecretBytes,
    constant_time_eq, directory_identity, ensure_private_dir, format_iso8601_utc,
    hold_managed_plant_in_use, now_epoch_ms, purge_managed_executable, random_hex, reject_symlink,
    resolve_codex_home, resolve_opencodex_home, resolve_user_home, volatile_zero_bytes,
    write_private_atomic, write_regular_atomic,
};
use crate::relay::{
    RelayCredentials, UpstreamError, fetch_home_authenticated, post_child_parity_report,
    serve_foreground,
};
use crate::relay_auth::{is_valid_key_id, is_valid_link_id};
use crate::routes::RelayAuthKind;
use crate::state::{
    AppliedSettingsRecord, CHILD_STATE_SCHEMA, ChildPaths, ChildStateV1, StateReadOutcome,
    is_valid_daemon_generation, is_valid_link_token_format, read_child_state,
    read_verified_link_key, write_child_state, write_link_key,
};
use crate::{DEFAULT_LISTEN_PORT, OCX_PROTOCOL_COMPAT_VERSION};

const REMOTE_LINK_SYNC_MESSAGE: &str = "Remote Link Home catalog synchronized.";
const STALE_REMOTE_CATALOG_MESSAGE: &str =
    "Home unavailable; retained and applied the last-known-good remote catalog (stale).";
const MAX_STDIN_CREDENTIAL_BYTES: usize = 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StdinLinkCredential {
    api_key_id: String,
    key: String,
}

fn default_listen_port() -> u16 {
    std::env::var("OCX_CHILD_LISTEN_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|&p| p >= 1024)
        .unwrap_or(DEFAULT_LISTEN_PORT)
}

fn current_paths() -> ChildPaths {
    ChildPaths::new(resolve_opencodex_home(), resolve_codex_home())
}

pub fn run_cli(args: &[String]) -> u8 {
    let Some(first) = args.first().map(String::as_str) else {
        eprintln!(
            "Usage: ocx-child <attach|sync|detach|serve|restart|disconnect|status|port|--version>"
        );
        return 2;
    };
    match first {
        "--version" | "-V" | "version" => {
            println!("opencodex {OCX_PROTOCOL_COMPAT_VERSION}");
            0
        }
        "--help" | "-h" | "help" => {
            println!("opencodex {OCX_PROTOCOL_COMPAT_VERSION} (ocx-child ephemeral link client)");
            0
        }
        "port" => cmd_port(),
        "link" => match args.get(1).map(String::as_str) {
            Some("port") => cmd_port(),
            Some("status") => cmd_link_status(&args[2..]),
            _ => {
                eprintln!("Usage: ocx-child link <port|status>");
                2
            }
        },
        "config" => match (
            args.get(1).map(String::as_str),
            args.get(2).map(String::as_str),
        ) {
            (Some("show"), Some("--json")) | (Some("show"), None) => cmd_config_show(),
            _ => {
                eprintln!("Usage: ocx-child config show --json");
                2
            }
        },
        "attach" => cmd_attach_or_connect(&args[1..], true),
        "connect" => {
            if args.get(1).map(String::as_str) == Some("status") {
                cmd_connect_status(&args[2..])
            } else {
                cmd_attach_or_connect(&args[1..], false)
            }
        }
        "serve" => cmd_serve(&args[1..]),
        "restart" => cmd_restart(),
        "sync" => cmd_sync(&args[1..]),
        "detach" | "disconnect" => cmd_detach(&args[1..]),
        "status" => cmd_status(&args[1..]),
        other => {
            eprintln!("Unknown ocx-child subcommand: {other}");
            2
        }
    }
}

fn cmd_port() -> u8 {
    match pick_ephemeral_link_port() {
        Ok(port) => {
            println!("{{\"port\":{port}}}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

fn cmd_config_show() -> u8 {
    let paths = current_paths();
    let (port, role) = match read_child_state(&paths.state_file) {
        StateReadOutcome::Valid(st) if st.pending_operation.is_none() => (st.listen_port, "client"),
        _ => (default_listen_port(), "standalone"),
    };
    println!("{{\"port\":{port},\"runtimeRole\":\"{role}\",\"ephemeralChild\":true}}");
    0
}

fn read_stdin_credential() -> Result<(String, SecretBytes), String> {
    let mut raw = Vec::with_capacity(256);
    io::stdin()
        .take((MAX_STDIN_CREDENTIAL_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|e| format!("failed reading credential from stdin: {e}"))?;
    let secret_buf = SecretBytes::new(raw);
    if secret_buf.as_slice().len() > MAX_STDIN_CREDENTIAL_BYTES {
        return Err("link credential exceeds 4 KiB stdin limit".to_owned());
    }
    let text = std::str::from_utf8(secret_buf.as_slice())
        .map_err(|_| "invalid link credential UTF-8".to_owned())?
        .trim();
    let parsed: StdinLinkCredential =
        serde_json::from_str(text).map_err(|_| "invalid link credential JSON".to_owned())?;
    if !is_valid_key_id(&parsed.api_key_id) || !is_valid_link_token_format(&parsed.key) {
        return Err("invalid link credential shape".to_owned());
    }
    let key_bytes = SecretBytes::new(parsed.key.into_bytes());
    Ok((parsed.api_key_id, key_bytes))
}

struct SettingsFetchError {
    retryable: bool,
    message: String,
}

impl std::fmt::Display for SettingsFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn fetch_home_settings_doc(
    tunnel_port: u16,
    creds: &RelayCredentials,
) -> Result<HomeCodexSettingsDocument, SettingsFetchError> {
    let (head, body, _) = fetch_home_authenticated(
        tunnel_port,
        creds,
        "GET",
        "/v1/link-management/codex-settings",
        RelayAuthKind::Bearer,
        None,
        64 * 1024,
    )
    .map_err(|e| SettingsFetchError {
        retryable: matches!(e, UpstreamError::HomeUnreachable(_)),
        message: format!("codex-settings fetch failed: {e:?}"),
    })?;
    if head.status == 404 {
        return Ok(HomeCodexSettingsDocument {
            version: 1,
            home: HomeIdentity {
                name: "home".to_owned(),
                version: OCX_PROTOCOL_COMPAT_VERSION.to_owned(),
            },
            settings: HomeCodexSettings {
                fast_mode: None,
                multi_agent_mode: None,
                web_search_sidecar_enabled: true,
                subagent_defaults: None,
            },
        });
    }
    if head.status != 200 {
        return Err(SettingsFetchError {
            retryable: head.status >= 500,
            message: format!("Home codex-settings returned HTTP {}", head.status),
        });
    }
    parse_home_codex_settings_document(&body).ok_or_else(|| SettingsFetchError {
        retryable: false,
        message: "Home codex-settings failed strict schema validation".to_owned(),
    })
}

pub struct AttachRollbackSnapshot {
    opencodex_home: String,
    codex_home: String,
    opencodex_home_identity: DirectoryIdentity,
    codex_home_identity: DirectoryIdentity,
    prior_state: Option<ChildStateV1>,
    prior_was_serving: bool,
    journal: Option<Vec<u8>>,
    config: Option<Vec<u8>>,
    catalog: Option<Vec<u8>>,
    catalog_backup: Option<Vec<u8>>,
    models_cache: Option<Vec<u8>>,
    key: Option<SecretBytes>,
    state_bytes: Option<Vec<u8>>,
}

const MAX_ROLLBACK_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachRollbackRecordRef<'a> {
    schema: &'static str,
    opencodex_home: String,
    codex_home: String,
    opencodex_home_identity: DirectoryIdentity,
    codex_home_identity: DirectoryIdentity,
    prior_state: &'a Option<ChildStateV1>,
    prior_was_serving: bool,
    journal: Option<&'a [u8]>,
    config: Option<&'a [u8]>,
    catalog: Option<&'a [u8]>,
    catalog_backup: Option<&'a [u8]>,
    models_cache: Option<&'a [u8]>,
    key: Option<&'a [u8]>,
    state_bytes: Option<&'a [u8]>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachRollbackRecord {
    schema: String,
    opencodex_home: String,
    codex_home: String,
    opencodex_home_identity: DirectoryIdentity,
    codex_home_identity: DirectoryIdentity,
    prior_state: Option<ChildStateV1>,
    prior_was_serving: bool,
    journal: Option<Vec<u8>>,
    config: Option<Vec<u8>>,
    catalog: Option<Vec<u8>>,
    catalog_backup: Option<Vec<u8>>,
    models_cache: Option<Vec<u8>>,
    key: Option<Vec<u8>>,
    state_bytes: Option<Vec<u8>>,
}

impl Drop for AttachRollbackRecord {
    fn drop(&mut self) {
        for bytes in [
            &mut self.journal,
            &mut self.config,
            &mut self.catalog,
            &mut self.catalog_backup,
            &mut self.models_cache,
            &mut self.key,
            &mut self.state_bytes,
        ]
        .into_iter()
        .flatten()
        {
            volatile_zero_bytes(bytes);
        }
    }
}

fn rollback_pending(paths: &ChildPaths) -> Result<bool, String> {
    match fs::symlink_metadata(&paths.rollback_file) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("cannot inspect rollback snapshot: {e}")),
    }
}

impl Drop for AttachRollbackSnapshot {
    fn drop(&mut self) {
        for bytes in [
            &mut self.journal,
            &mut self.config,
            &mut self.catalog,
            &mut self.catalog_backup,
            &mut self.models_cache,
            &mut self.state_bytes,
        ]
        .into_iter()
        .flatten()
        {
            volatile_zero_bytes(bytes);
        }
    }
}

impl AttachRollbackSnapshot {
    fn read_optional(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
        match fs::read(path) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("attach failed reading {}: {e}", path.display())),
        }
    }

    pub fn capture(
        guard: &CodexHomeGuard,
        prior_state: Option<ChildStateV1>,
    ) -> Result<Self, String> {
        let paths = guard.paths();
        ensure_private_dir(&paths.child_dir)?;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&paths.codex_home)
            .map_err(|e| format!("cannot create Codex home for rollback: {e}"))?;
        let (opencodex_home, codex_home) = Self::canonical_homes(paths)?;
        let opencodex_home_identity = directory_identity(std::path::Path::new(&opencodex_home))?;
        let codex_home_identity = directory_identity(std::path::Path::new(&codex_home))?;
        let prior_was_serving = prior_state.as_ref().is_some_and(|st| {
            probe_local_healthz(st.listen_port, Duration::from_millis(300)).is_some()
        });
        let snapshot = Self {
            opencodex_home,
            codex_home,
            opencodex_home_identity,
            codex_home_identity,
            prior_state,
            prior_was_serving,
            journal: Self::read_optional(&paths.journal_file)?,
            config: Self::read_optional(&paths.codex_config_path())?,
            catalog: Self::read_optional(&paths.codex_catalog_path())?,
            catalog_backup: Self::read_optional(&paths.catalog_backup_file)?,
            models_cache: Self::read_optional(&paths.codex_models_cache_path())?,
            key: Self::read_optional(&paths.key_file)?.map(SecretBytes::new),
            state_bytes: Self::read_optional(&paths.state_file)?,
        };
        snapshot.validate_homes(paths)?;
        snapshot.persist(paths)?;
        Ok(snapshot)
    }

    fn canonical_homes(paths: &ChildPaths) -> Result<(String, String), String> {
        let ocx = fs::canonicalize(&paths.opencodex_home)
            .map_err(|e| format!("cannot resolve OpenCodex home for rollback: {e}"))?;
        let codex = fs::canonicalize(&paths.codex_home)
            .map_err(|e| format!("cannot resolve Codex home for rollback: {e}"))?;
        let ocx = ocx.to_str().ok_or("OpenCodex home is not UTF-8")?;
        let codex = codex.to_str().ok_or("Codex home is not UTF-8")?;
        Ok((ocx.to_owned(), codex.to_owned()))
    }

    fn validate_homes(&self, paths: &ChildPaths) -> Result<(), String> {
        let (ocx, codex) = Self::canonical_homes(paths)?;
        if ocx != self.opencodex_home
            || codex != self.codex_home
            || directory_identity(std::path::Path::new(&ocx))? != self.opencodex_home_identity
            || directory_identity(std::path::Path::new(&codex))? != self.codex_home_identity
        {
            return Err("rollback snapshot belongs to a different home".to_owned());
        }
        Ok(())
    }

    fn persist(&self, paths: &ChildPaths) -> Result<(), String> {
        ensure_private_dir(&paths.child_dir)?;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&paths.codex_home)
            .map_err(|e| format!("cannot create Codex home for rollback: {e}"))?;
        reject_symlink(&paths.rollback_file)?;
        match fs::symlink_metadata(&paths.rollback_file) {
            Ok(_) => return Err("attach refused: unresolved rollback snapshot exists".to_owned()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot inspect rollback snapshot: {e}")),
        }
        self.validate_homes(paths)?;
        let record = AttachRollbackRecordRef {
            schema: "ocx.child.attach-rollback/1",
            opencodex_home_identity: self.opencodex_home_identity.clone(),
            codex_home_identity: self.codex_home_identity.clone(),
            opencodex_home: self.opencodex_home.clone(),
            codex_home: self.codex_home.clone(),
            prior_state: &self.prior_state,
            prior_was_serving: self.prior_was_serving,
            journal: self.journal.as_deref(),
            config: self.config.as_deref(),
            catalog: self.catalog.as_deref(),
            catalog_backup: self.catalog_backup.as_deref(),
            models_cache: self.models_cache.as_deref(),
            key: self.key.as_ref().map(SecretBytes::as_slice),
            state_bytes: self.state_bytes.as_deref(),
        };
        let mut bytes = serde_json::to_vec(&record)
            .map_err(|e| format!("cannot serialize rollback snapshot: {e}"))?;
        if bytes.len() as u64 > MAX_ROLLBACK_BYTES {
            volatile_zero_bytes(&mut bytes);
            return Err("rollback snapshot exceeds size limit".to_owned());
        }
        let result = write_private_atomic(&paths.rollback_file, &bytes);
        volatile_zero_bytes(&mut bytes);
        result
    }

    fn recover(guard: &CodexHomeGuard) -> Result<bool, String> {
        let paths = guard.paths();
        reject_symlink(&paths.rollback_file)?;
        let file = match fs::File::open(&paths.rollback_file) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(format!("cannot open rollback snapshot: {e}")),
        };
        let mut bytes = Vec::new();
        file.take(MAX_ROLLBACK_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("cannot read rollback snapshot: {e}"))?;
        if bytes.len() as u64 > MAX_ROLLBACK_BYTES {
            volatile_zero_bytes(&mut bytes);
            return Err("rollback snapshot exceeds size limit".to_owned());
        }
        let parsed = serde_json::from_slice::<AttachRollbackRecord>(&bytes);
        volatile_zero_bytes(&mut bytes);
        let mut record = parsed.map_err(|e| format!("invalid rollback snapshot: {e}"))?;
        let (ocx, codex) = Self::canonical_homes(paths)?;
        if record.schema != "ocx.child.attach-rollback/1"
            || record.opencodex_home != ocx
            || record.codex_home != codex
            || record.opencodex_home_identity != directory_identity(std::path::Path::new(&ocx))?
            || record.codex_home_identity != directory_identity(std::path::Path::new(&codex))?
        {
            return Err("rollback snapshot belongs to a different home".to_owned());
        }
        match read_child_state(&paths.state_file) {
            StateReadOutcome::Valid(state) => stop_owned_daemon(&state)?,
            StateReadOutcome::Absent => {}
            StateReadOutcome::Invalid(_) => {
                return Err("cannot recover rollback with invalid child state".to_owned());
            }
        }
        let snapshot = Self {
            opencodex_home: record.opencodex_home.clone(),
            codex_home: record.codex_home.clone(),
            opencodex_home_identity: record.opencodex_home_identity.clone(),
            codex_home_identity: record.codex_home_identity.clone(),
            prior_state: record.prior_state.take(),
            // A recovery requested by detach restores files without starting a daemon.
            prior_was_serving: false,
            journal: record.journal.take(),
            config: record.config.take(),
            catalog: record.catalog.take(),
            catalog_backup: record.catalog_backup.take(),
            models_cache: record.models_cache.take(),
            key: record.key.take().map(SecretBytes::new),
            state_bytes: record.state_bytes.take(),
        };
        let _ = record.prior_was_serving;
        snapshot.restore(guard)?;
        Ok(true)
    }

    /// Restore one file. An ordinary failure is collected in `errors` so the remaining files
    /// are still attempted; a changed home stops restoration at once (`Err`).
    fn restore_path(
        guard: &CodexHomeGuard,
        path: &std::path::Path,
        bytes: Option<&[u8]>,
        private: bool,
        errors: &mut Vec<String>,
    ) -> Result<(), String> {
        let result = guard.restore_step(|| match bytes {
            Some(b) if private => write_private_atomic(path, b),
            Some(b) => write_regular_atomic(path, b),
            None => remove_optional_file(path),
        });
        match result {
            Ok(()) => Ok(()),
            Err(RestoreStepError::Failed(e)) => {
                errors.push(format!("restore {}: {e}", path.display()));
                Ok(())
            }
            Err(RestoreStepError::HomeChanged(e)) => Err(format!("attach rollback stopped: {e}")),
        }
    }

    pub fn restore(&self, guard: &CodexHomeGuard) -> Result<(), String> {
        let paths = guard.paths();
        self.validate_homes(paths)?;
        let mut errors = Vec::new();
        for (path, bytes) in [
            (paths.codex_config_path(), self.config.as_deref()),
            (paths.codex_catalog_path(), self.catalog.as_deref()),
            (
                paths.codex_models_cache_path(),
                self.models_cache.as_deref(),
            ),
        ] {
            Self::restore_path(guard, &path, bytes, false, &mut errors)?;
        }
        if errors.is_empty() {
            for (path, bytes) in [
                (&paths.catalog_backup_file, self.catalog_backup.as_deref()),
                (
                    &paths.key_file,
                    self.key.as_ref().map(SecretBytes::as_slice),
                ),
                (&paths.state_file, self.state_bytes.as_deref()),
            ] {
                Self::restore_path(guard, path, bytes, true, &mut errors)?;
            }
        }
        if errors.is_empty() {
            Self::restore_path(
                guard,
                &paths.journal_file,
                self.journal.as_deref(),
                true,
                &mut errors,
            )?;
        }
        let mut restarted = None;
        if let Some(mut prev) = self.prior_state.clone()
            && self.prior_was_serving
            && errors.is_empty()
            && probe_local_healthz(prev.listen_port, Duration::from_millis(250)).is_none()
        {
            let state_key_consistent = match read_child_state(&paths.state_file) {
                StateReadOutcome::Valid(st)
                    if st.link_id == prev.link_id
                        && st.token_fingerprint == prev.token_fingerprint =>
                {
                    read_verified_link_key(&paths.key_file, &st.token_fingerprint).is_ok()
                }
                _ => false,
            };
            if !state_key_consistent {
                errors.push("prior relay restart skipped: restored state.json and link-key are inconsistent".to_owned());
            } else {
                // The state naming the new generation and PID is durable once this returns.
                match start_or_rollover_daemon(paths, &mut prev, None) {
                    Ok(pending) => restarted = Some(pending),
                    Err(e) => errors.push(format!("restart prior daemon: {e}")),
                }
            }
        }
        if errors.is_empty() {
            // The rollback record goes only after restoration verified both homes, and before a
            // restarted prior relay is committed, so that relay never serves while recovery
            // could still restore files underneath it. Dropping an uncommitted relay stops it.
            guard
                .restore_step(|| remove_optional_file(&paths.rollback_file))
                .map_err(RestoreStepError::into_message)?;
            if let Some(pending) = restarted {
                pending.commit().map_err(|e| {
                    format!("attach rolled back, but the prior relay did not restart: {e}")
                })?;
            }
            Ok(())
        } else {
            Err(format!("attach rollback incomplete: {}", errors.join("; ")))
        }
    }

    /// Restore after a failed attach; true when every file and record was restored.
    fn restore_and_report(&self, guard: &CodexHomeGuard) -> bool {
        match self.restore(guard) {
            Ok(()) => true,
            Err(rb_err) => {
                eprintln!("{rb_err}");
                false
            }
        }
    }
}

fn cmd_attach_or_connect(args: &[String], native_attach_default_start: bool) -> u8 {
    let mut link_id: Option<String> = None;
    let mut tunnel_port: Option<u16> = None;
    let mut listen_port: u16 = default_listen_port();
    let mut start_daemon = native_attach_default_start;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--link" | "--key-stdin" => i += 1,
            "--start-daemon" => {
                start_daemon = true;
                i += 1;
            }
            "--no-daemon" => {
                start_daemon = false;
                i += 1;
            }
            "--link-id" => {
                link_id = args.get(i + 1).cloned();
                i += 2;
            }
            "--tunnel-port" => {
                tunnel_port = args.get(i + 1).and_then(|s| s.parse::<u16>().ok());
                i += 2;
            }
            "--listen-port" | "--port" => {
                if let Some(p) = args.get(i + 1).and_then(|s| s.parse::<u16>().ok()) {
                    listen_port = p;
                } else {
                    eprintln!("invalid --listen-port");
                    return 2;
                }
                i += 2;
            }
            "--clients" => i += 2,
            other => {
                eprintln!("unrecognized attach/connect argument: {other}");
                return 2;
            }
        }
    }
    let Some(link_id) = link_id.filter(|id| is_valid_link_id(id)) else {
        eprintln!("--link-id lnk_<16hex> is required");
        return 2;
    };
    let Some(tunnel_port) = tunnel_port.filter(|&p| p >= 1024) else {
        eprintln!("--tunnel-port <1024..65535> is required");
        return 2;
    };
    let (api_key_id, raw_key) = match read_stdin_credential() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };

    let local_paths = current_paths();
    let _lock = match FileLock::acquire_blocking(&local_paths.lock_file) {
        Ok(l) => l,
        Err(_) => {
            eprintln!("attach failed: could not acquire child lifecycle lock");
            return 1;
        }
    };
    // A receipt from an earlier detach of this link must not vouch for this new attachment.
    if let Err(e) =
        remove_optional_file(&detach_receipt_path(&local_paths.opencodex_home, &link_id))
    {
        eprintln!("attach failed clearing an earlier detach receipt: {e}");
        return 1;
    }

    if !matches!(rollback_pending(&local_paths), Ok(false)) {
        eprintln!("attach refused: incomplete attach requires detach recovery");
        return 1;
    }
    // The ownership record names this link (schema /2) before any CODEX_HOME write.
    let mut guard = match CodexHomeGuard::acquire_for_attach(&local_paths, true, true, &link_id) {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("attach refused: {}", e.message());
            return 1;
        }
    };
    crate::test_hooks::barrier("attach-protected");
    let request = AttachRequest {
        link_id,
        tunnel_port,
        listen_port,
        start_daemon,
        api_key_id,
        raw_key,
    };
    match attach_locked(&mut guard, request) {
        Ok(()) => 0,
        Err(failure) => {
            if failure.left_no_changes
                && let Err(e) = guard.revert_claim()
            {
                eprintln!("attach could not release Codex home ownership: {e}");
            }
            failure.code
        }
    }
}

struct AttachRequest {
    link_id: String,
    tunnel_port: u16,
    listen_port: u16,
    start_daemon: bool,
    api_key_id: String,
    raw_key: SecretBytes,
}

struct AttachFailure {
    code: u8,
    /// True when nothing was changed, or every change was rolled back and recorded as such.
    left_no_changes: bool,
}

fn attach_locked(guard: &mut CodexHomeGuard, request: AttachRequest) -> Result<(), AttachFailure> {
    let AttachRequest {
        link_id,
        tunnel_port,
        listen_port,
        start_daemon,
        api_key_id,
        raw_key,
    } = request;
    let paths = guard.paths().clone();
    let refuse = |code: u8| AttachFailure {
        code,
        left_no_changes: true,
    };
    let prior_state = match read_child_state(&paths.state_file) {
        StateReadOutcome::Valid(st) => Some(*st),
        _ => None,
    };
    let existing_pid = prior_state
        .as_ref()
        .filter(|prev| prev.listen_port == listen_port)
        .and_then(|prev| prev.daemon_pid);
    if let Err(e) = ensure_port_available_for_attach(listen_port, existing_pid) {
        eprintln!("{e}");
        return Err(refuse(1));
    }

    let raw_key_str = match std::str::from_utf8(raw_key.as_slice()) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("invalid credential encoding");
            return Err(refuse(2));
        }
    };
    let fp = crate::relay_auth::token_fingerprint_hex(raw_key_str);
    let creds = RelayCredentials {
        api_key_id: api_key_id.clone(),
        link_id: link_id.clone(),
        token_fingerprint: fp.clone(),
        raw_token: SecretBytes::new(raw_key.as_slice().to_vec()),
    };

    // Probe Home /readyz and pull /v1/catalog + /v1/link-management/codex-settings
    match fetch_home_authenticated(
        tunnel_port,
        &creds,
        "GET",
        "/readyz",
        RelayAuthKind::ApiKeyHeader,
        None,
        64 * 1024,
    ) {
        Ok((h, _, _)) if h.status == 200 => {}
        Ok((h, _, _)) => {
            eprintln!("Home /readyz returned HTTP {}", h.status);
            return Err(refuse(1));
        }
        Err(e) => {
            eprintln!("Home /readyz unreachable over tunnel: {e:?}");
            return Err(refuse(1));
        }
    }

    let catalog_bytes = match fetch_home_authenticated(
        tunnel_port,
        &creds,
        "GET",
        "/v1/catalog",
        RelayAuthKind::Bearer,
        None,
        4 * 1024 * 1024,
    ) {
        Ok((h, b, _)) if h.status == 200 => b,
        Ok((h, _, _)) => {
            eprintln!("Home /v1/catalog returned HTTP {}", h.status);
            return Err(refuse(1));
        }
        Err(e) => {
            eprintln!("Home /v1/catalog failed: {e:?}");
            return Err(refuse(1));
        }
    };

    let settings_doc = match fetch_home_settings_doc(tunnel_port, &creds) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{e}");
            return Err(refuse(1));
        }
    };

    let rollback = match AttachRollbackSnapshot::capture(guard, prior_state.clone()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            // A persisted snapshot means changes may need recovery; keep ownership for detach.
            let left_no_changes = matches!(rollback_pending(&paths), Ok(false));
            return Err(AttachFailure {
                code: 1,
                left_no_changes,
            });
        }
    };

    let journal = match apply_attach_or_sync(
        guard,
        &link_id,
        &api_key_id,
        listen_port,
        &catalog_bytes,
        &settings_doc.settings,
    ) {
        Ok(j) => j,
        Err(e) => {
            let restored = rollback.restore_and_report(guard);
            eprintln!("{e}");
            return Err(AttachFailure {
                code: 1,
                left_no_changes: restored,
            });
        }
    };

    if let Err(e) = write_link_key(&paths.key_file, raw_key_str) {
        let restored = rollback.restore_and_report(guard);
        eprintln!("{e}");
        return Err(AttachFailure {
            code: 1,
            left_no_changes: restored,
        });
    }

    let now_ms = now_epoch_ms();
    let now_iso = format_iso8601_utc(now_ms);
    let digest = codex_settings_digest(&settings_doc.settings);
    let shutdown_secret = match random_hex(24) {
        Ok(s) => s,
        Err(e) => {
            let restored = rollback.restore_and_report(guard);
            eprintln!("{e}");
            return Err(AttachFailure {
                code: 1,
                left_no_changes: restored,
            });
        }
    };
    if let Some(prev) = &prior_state
        && prev.listen_port != listen_port
        && let Err(e) = stop_owned_daemon(prev)
    {
        let restored = rollback.restore_and_report(guard);
        eprintln!(
            "attach failed stopping previous relay on port {}: {e}",
            prev.listen_port
        );
        return Err(AttachFailure {
            code: 1,
            left_no_changes: restored,
        });
    }
    let mut state = ChildStateV1 {
        schema: CHILD_STATE_SCHEMA.to_owned(),
        link_id: link_id.clone(),
        api_key_id: api_key_id.clone(),
        token_fingerprint: fp,
        tunnel_port,
        listen_port,
        connected_at: now_iso.clone(),
        catalog_fingerprint: journal.latest_catalog_sha256,
        catalog_synced_at: now_iso.clone(),
        daemon_pid: existing_pid,
        daemon_started_at_ms: None,
        shutdown_secret: shutdown_secret.into(),
        parity_sequence: 0,
        pending_operation: None,
        daemon_generation: None,
        applied_settings: Some(AppliedSettingsRecord {
            link_id: link_id.clone(),
            fetched_at: now_iso.clone(),
            applied_at: now_iso,
            applied_at_ms: now_ms,
            digest: digest.clone(),
            document: settings_doc,
        }),
    };
    crate::test_hooks::barrier("attach-before-state-write");
    if let Err(e) = write_child_state(&paths.state_file, &state) {
        let restored = rollback.restore_and_report(guard);
        eprintln!("{e}");
        return Err(AttachFailure {
            code: 1,
            left_no_changes: restored,
        });
    }

    let pending = if start_daemon {
        crate::test_hooks::barrier("attach-before-daemon-start");
        match start_or_rollover_daemon(&paths, &mut state, Some(now_ms)) {
            Ok(pending) => Some(pending),
            Err(e) => {
                let restored = rollback.restore_and_report(guard);
                eprintln!("{e}");
                return Err(AttachFailure {
                    code: 1,
                    left_no_changes: restored,
                });
            }
        }
    } else {
        None
    };

    if let Err(e) = guard.set_phase(OwnershipPhase::Attached) {
        // Stop the uncommitted daemon before restoring files it could otherwise serve.
        drop(pending);
        let restored = rollback.restore_and_report(guard);
        eprintln!("attach failed recording Codex home ownership: {e}");
        return Err(AttachFailure {
            code: 1,
            left_no_changes: restored,
        });
    }
    if let Err(e) = remove_optional_file(&paths.rollback_file) {
        drop(pending);
        eprintln!("attach failed to clear rollback snapshot: {e}");
        return Err(AttachFailure {
            code: 1,
            left_no_changes: false,
        });
    }
    // The daemon may serve only now: state and ownership are durable and the rollback record
    // is gone, so recovery can no longer restore files underneath it.
    if let Some(pending) = pending {
        match pending.commit() {
            Ok((_, started_ms)) => {
                state.parity_sequence += 1;
                let _ = write_child_state(&paths.state_file, &state);
                let report = LinkChildParityReport {
                    link_id,
                    last_apply_at: Some(now_ms),
                    runtime_started_at: started_ms,
                    applied_codex_settings_digest: Some(digest),
                    sequence: state.parity_sequence,
                };
                let _ = post_child_parity_report(tunnel_port, &creds, &report);
            }
            Err(e) => {
                eprintln!(
                    "attach completed but the client relay did not start: {e}; run `ocx-child restart`"
                );
                return Err(AttachFailure {
                    code: 1,
                    left_no_changes: false,
                });
            }
        }
    }
    println!("Connected to http://127.0.0.1:{tunnel_port}.");
    println!("Local Codex CLI: ready (ephemeral ocx-child Design B attached).");
    Ok(())
}

struct LifecycleStart {
    generation: String,
    secret: SecretBytes,
}

/// Read the parent's start line: `ocx-child-start/1 <generation> <shutdown secret>\n`.
fn read_lifecycle_start() -> Result<LifecycleStart, String> {
    let mut line = Vec::with_capacity(128);
    let read = io::stdin().lock().take(161).read_until(b'\n', &mut line);
    let buffer = SecretBytes::new(line);
    read.map_err(|e| format!("cannot read lifecycle start line: {e}"))?;
    let text = std::str::from_utf8(buffer.as_slice())
        .ok()
        .and_then(|t| t.strip_suffix('\n'))
        .ok_or("invalid lifecycle start line")?;
    let mut parts = text.split(' ');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("ocx-child-start/1"), Some(generation), Some(secret), None)
            if is_valid_daemon_generation(generation) && secret.len() == 48 =>
        {
            Ok(LifecycleStart {
                generation: generation.to_owned(),
                secret: SecretBytes::new(secret.as_bytes().to_vec()),
            })
        }
        _ => Err("invalid lifecycle start line".to_owned()),
    }
}

fn cmd_serve(args: &[String]) -> u8 {
    let mut foreground = false;
    let mut lifecycle_start = false;
    let mut listen_port: Option<u16> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--foreground" => {
                foreground = true;
                i += 1;
            }
            "--lifecycle-start" => {
                lifecycle_start = true;
                i += 1;
            }
            "--listen-port" | "--port" => {
                listen_port = args.get(i + 1).and_then(|s| s.parse::<u16>().ok());
                i += 2;
            }
            _ => i += 1,
        }
    }
    let paths = current_paths();
    if foreground {
        let start = if lifecycle_start {
            match read_lifecycle_start() {
                Ok(start) => Some(start),
                Err(e) => {
                    eprintln!("serve refused: {e}");
                    return 1;
                }
            }
        } else {
            None
        };
        // Watch for the commit from now on, so a parent that dies while this process waits
        // on the start gate still ends it.
        let committed = start
            .as_ref()
            .map(|s| crate::relay::spawn_commit_watcher(s.generation.clone()));
        let state = match read_child_state(&paths.state_file) {
            StateReadOutcome::Valid(st) if st.pending_operation.is_none() => st,
            StateReadOutcome::Absent => {
                eprintln!("serve refused: ocx-child is detached (no active link)");
                return 1;
            }
            _ => {
                eprintln!("serve refused: child state is invalid or pending teardown");
                return 1;
            }
        };
        if !matches!(validate_existing_journal_paths(&paths), Ok(true)) {
            eprintln!(
                "serve refused: child recovery journal is missing or belongs to another home"
            );
            return 1;
        }
        match rollback_pending(&paths) {
            Ok(true) if start.is_none() => {
                eprintln!("serve refused: incomplete attach requires lifecycle authorization");
                return 1;
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("serve refused: {e}");
                return 1;
            }
        }
        if let Some(start) = &start
            && !constant_time_eq(start.secret.as_slice(), state.shutdown_secret.as_bytes())
        {
            eprintln!("serve refused: lifecycle authorization does not match child state");
            return 1;
        }
        if let Err(e) = read_verified_link_key(&paths.key_file, &state.token_fingerprint) {
            eprintln!("serve refused: {e}");
            return 1;
        }
        // Held for the life of this relay, so no purge removes the binary it runs from.
        let local_appdata = std::env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let _in_use = match std::env::current_exe()
            .map_err(|e| format!("cannot resolve the current executable: {e}"))
            .and_then(|exe| {
                hold_managed_plant_in_use(&exe, &resolve_user_home(), local_appdata.as_deref())
            }) {
            Ok(lock) => lock,
            Err(e) => {
                eprintln!("serve refused: {e}");
                return 1;
            }
        };
        let port = listen_port.unwrap_or(state.listen_port);
        if port != state.listen_port {
            eprintln!("serve refused: listen port does not match child state");
            return 1;
        }
        let served = match (&start, committed) {
            (Some(start), Some(committed)) => {
                crate::relay::serve_foreground_lifecycle(paths, port, &start.generation, committed)
            }
            _ => serve_foreground(paths, port),
        };
        return match served {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        };
    }
    cmd_restart()
}

fn cmd_restart() -> u8 {
    let paths = current_paths();
    let _lock = match FileLock::acquire_blocking(&paths.lock_file) {
        Ok(l) => l,
        Err(_) => {
            eprintln!("restart failed: child lifecycle lock busy");
            return 1;
        }
    };
    if !matches!(rollback_pending(&paths), Ok(false)) {
        eprintln!("restart refused: incomplete attach requires detach recovery");
        return 1;
    }
    let codex_guard = match CodexHomeGuard::acquire(&paths, true, false, ClaimPolicy::Continue) {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("restart refused: {}", e.message());
            return 1;
        }
    };
    let paths = codex_guard.paths().clone();
    let mut state = match read_child_state(&paths.state_file) {
        StateReadOutcome::Valid(st) if st.pending_operation.is_none() => *st,
        StateReadOutcome::Absent => {
            eprintln!("restart refused: ocx-child is detached (no active link)");
            return 1;
        }
        _ => {
            eprintln!("restart refused: child state is invalid or pending teardown");
            return 1;
        }
    };
    if !matches!(validate_existing_journal_paths(&paths), Ok(true)) {
        eprintln!("restart refused: child recovery journal is missing or belongs to another home");
        return 1;
    }
    let floor_ms = state.applied_settings.as_ref().map(|a| a.applied_at_ms);
    let (pid, started_ms) = match start_or_rollover_daemon(&paths, &mut state, floor_ms)
        .and_then(|pending| pending.commit())
    {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    if let Ok(raw_token) = read_verified_link_key(&paths.key_file, &state.token_fingerprint) {
        let creds = RelayCredentials {
            api_key_id: state.api_key_id.clone(),
            link_id: state.link_id.clone(),
            token_fingerprint: state.token_fingerprint.clone(),
            raw_token,
        };
        state.parity_sequence += 1;
        let _ = write_child_state(&paths.state_file, &state);
        let (last_apply_at, digest) = match &state.applied_settings {
            Some(rec) => (Some(rec.applied_at_ms), Some(rec.digest.clone())),
            None => (None, None),
        };
        let report = LinkChildParityReport {
            link_id: state.link_id.clone(),
            last_apply_at,
            runtime_started_at: started_ms,
            applied_codex_settings_digest: digest,
            sequence: state.parity_sequence,
        };
        let _ = post_child_parity_report(state.tunnel_port, &creds, &report);
    }
    println!(
        "ocx-child client relay active (PID {pid}, port {}).",
        state.listen_port
    );
    0
}

fn emit_expectation_mismatch(phase: &str, reason: &str) -> u8 {
    eprintln!(
        "Sync refused ({phase}: {reason}); nothing was changed and local providers were not synced."
    );
    eprintln!("{{\"phase\":\"{phase}\",\"reason\":\"{reason}\"}}");
    5
}

fn cmd_sync(args: &[String]) -> u8 {
    let mut json_mode = false;
    let mut expect_link: Option<String> = None;
    let mut expect_hub_key: Option<String> = None;
    let mut expect_count = 0usize;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--json" {
            json_mode = true;
            i += 1;
        } else if arg == "--local-only"
            || arg == "--restart-codex"
            || arg == "--restart-app-server-only"
        {
            i += 1;
        } else if arg == "--expect-link" {
            expect_count += 1;
            expect_link = args.get(i + 1).cloned();
            i += 2;
        } else if let Some(val) = arg.strip_prefix("--expect-link=") {
            expect_count += 1;
            expect_link = Some(val.to_owned());
            i += 1;
        } else if arg == "--expect-hub-key" {
            expect_count += 1;
            expect_hub_key = args.get(i + 1).cloned();
            i += 2;
        } else if let Some(val) = arg.strip_prefix("--expect-hub-key=") {
            expect_count += 1;
            expect_hub_key = Some(val.to_owned());
            i += 1;
        } else {
            eprintln!("unrecognized sync flag: {arg}");
            return 2;
        }
    }
    if expect_count > 1 {
        eprintln!("ocx sync accepts one --expect-link or --expect-hub-key, given once.");
        return 2;
    }
    if let Some(id) = &expect_link
        && !is_valid_link_id(id)
    {
        eprintln!(
            "--expect-link needs a link id of the form lnk_ followed by 16 hex digits (see ocx connect status --json)."
        );
        return 2;
    }
    if let Some(k) = &expect_hub_key
        && (k.trim().is_empty() || k.trim() != k || k.len() > 256)
    {
        eprintln!(
            "--expect-hub-key needs the connected API key id (see ocx connect status --json)."
        );
        return 2;
    }

    let paths = current_paths();
    let has_expectation = expect_link.is_some() || expect_hub_key.is_some();
    let _lock = if has_expectation {
        match FileLock::try_acquire_nonblocking(&paths.lock_file) {
            Ok(l) => l,
            Err(LockAcquireError::Busy) => {
                let phase = if expect_link.is_some() {
                    "child_link_mismatch"
                } else {
                    "hub_client_mismatch"
                };
                return emit_expectation_mismatch(phase, "pending_operation");
            }
            Err(LockAcquireError::Io) => {
                let phase = if expect_link.is_some() {
                    "child_link_mismatch"
                } else {
                    "hub_client_mismatch"
                };
                return emit_expectation_mismatch(phase, "invalid_state");
            }
        }
    } else {
        match FileLock::acquire_blocking(&paths.lock_file) {
            Ok(l) => l,
            Err(_) => {
                eprintln!("sync failed: child lifecycle lock unavailable");
                return 1;
            }
        }
    };

    let mut state = match read_child_state(&paths.state_file) {
        StateReadOutcome::Absent => {
            if expect_link.is_some() {
                return emit_expectation_mismatch("child_link_mismatch", "disconnected");
            }
            if expect_hub_key.is_some() {
                return emit_expectation_mismatch("hub_client_mismatch", "disconnected");
            }
            eprintln!("ocx-child is not attached to a Remote Link Home.");
            return 1;
        }
        StateReadOutcome::Invalid(_) => {
            if expect_link.is_some() {
                return emit_expectation_mismatch("child_link_mismatch", "invalid_state");
            }
            if expect_hub_key.is_some() {
                return emit_expectation_mismatch("hub_client_mismatch", "invalid_state");
            }
            eprintln!("ocx-child state is invalid.");
            return 1;
        }
        StateReadOutcome::Valid(st) => *st,
    };
    if !matches!(rollback_pending(&paths), Ok(false)) {
        if expect_link.is_some() {
            return emit_expectation_mismatch("child_link_mismatch", "invalid_state");
        }
        if expect_hub_key.is_some() {
            return emit_expectation_mismatch("hub_client_mismatch", "invalid_state");
        }
        eprintln!("sync refused: incomplete attach requires detach recovery");
        return 1;
    }

    if let Some(op) = &state.pending_operation {
        let reason = if op == "disconnect" {
            "disconnect_pending"
        } else {
            "pending_operation"
        };
        if expect_link.is_some() {
            return emit_expectation_mismatch("child_link_mismatch", reason);
        }
        if expect_hub_key.is_some() {
            return emit_expectation_mismatch("hub_client_mismatch", reason);
        }
        eprintln!("sync refused: {reason}");
        return 1;
    }
    if expect_hub_key.is_some() {
        return emit_expectation_mismatch("hub_client_mismatch", "link_client");
    }
    if let Some(expected_id) = &expect_link
        && state.link_id != *expected_id
    {
        return emit_expectation_mismatch("child_link_mismatch", "other_link");
    }
    let codex_guard =
        match CodexHomeGuard::acquire(&paths, !has_expectation, false, ClaimPolicy::Continue) {
            Ok(guard) => guard,
            Err(e) => {
                if expect_link.is_some() {
                    let reason = if e == CodexHomeError::Busy {
                        "pending_operation"
                    } else {
                        "invalid_state"
                    };
                    return emit_expectation_mismatch("child_link_mismatch", reason);
                }
                eprintln!("sync refused: {}", e.message());
                return 1;
            }
        };
    let paths = codex_guard.paths().clone();
    if !matches!(validate_existing_journal_paths(&paths), Ok(true)) {
        if expect_link.is_some() {
            return emit_expectation_mismatch("child_link_mismatch", "invalid_state");
        }
        eprintln!("sync refused: child recovery journal is missing or belongs to another home");
        return 1;
    }

    let raw_token = match read_verified_link_key(&paths.key_file, &state.token_fingerprint) {
        Ok(t) => t,
        Err(e) => {
            if expect_link.is_some() {
                return emit_expectation_mismatch("child_link_mismatch", "invalid_state");
            }
            eprintln!("Connected sync failed without local fallback: {e}");
            return 1;
        }
    };
    let creds = RelayCredentials {
        api_key_id: state.api_key_id.clone(),
        link_id: state.link_id.clone(),
        token_fingerprint: state.token_fingerprint.clone(),
        raw_token,
    };

    let mut stale = false;
    let catalog_bytes = match fetch_home_authenticated(
        state.tunnel_port,
        &creds,
        "GET",
        "/v1/catalog",
        RelayAuthKind::Bearer,
        None,
        4 * 1024 * 1024,
    ) {
        Ok((h, b, _)) if h.status == 200 => b,
        result @ (Err(UpstreamError::HomeUnreachable(_)) | Ok((_, _, _)))
            if matches!(&result, Err(UpstreamError::HomeUnreachable(_)))
                || matches!(&result, Ok((h, _, _)) if h.status >= 500) =>
        {
            match fs::read(&paths.catalog_backup_file) {
                Ok(cached) => {
                    stale = true;
                    cached
                }
                Err(_) => {
                    eprintln!(
                        "Connected sync failed without local fallback: Home /v1/catalog unreachable"
                    );
                    return 1;
                }
            }
        }
        Ok((head, _, _)) => {
            eprintln!(
                "Connected sync failed: Home /v1/catalog returned HTTP {}",
                head.status
            );
            return 1;
        }
        Err(e) => {
            eprintln!("Connected sync failed: Home /v1/catalog: {e:?}");
            return 1;
        }
    };

    let now_ms = now_epoch_ms();
    let now_iso = format_iso8601_utc(now_ms);
    let settings_doc = match fetch_home_settings_doc(state.tunnel_port, &creds) {
        Ok(doc) => doc,
        Err(e) if stale && e.retryable && state.applied_settings.is_some() => {
            state.applied_settings.as_ref().unwrap().document.clone()
        }
        Err(e) => {
            eprintln!("Connected sync failed without local fallback: {e}");
            return 1;
        }
    };

    let journal = match apply_attach_or_sync(
        &codex_guard,
        &state.link_id,
        &state.api_key_id,
        state.listen_port,
        &catalog_bytes,
        &settings_doc.settings,
    ) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("Connected sync failed without local fallback: {e}");
            return 1;
        }
    };

    let new_digest = codex_settings_digest(&settings_doc.settings);
    let (applied_at_iso, applied_at_ms) = match &state.applied_settings {
        Some(prev) if prev.link_id == state.link_id && prev.digest == new_digest => {
            (prev.applied_at.clone(), prev.applied_at_ms)
        }
        _ => (now_iso.clone(), now_ms),
    };
    state.catalog_fingerprint = journal.latest_catalog_sha256;
    state.catalog_synced_at = now_iso.clone();
    state.applied_settings = Some(AppliedSettingsRecord {
        link_id: state.link_id.clone(),
        fetched_at: now_iso,
        applied_at: applied_at_iso,
        applied_at_ms,
        digest: new_digest.clone(),
        document: settings_doc,
    });
    if let Err(e) = write_child_state(&paths.state_file, &state) {
        eprintln!("Failed writing child state: {e}");
        return 1;
    }

    // OCX-6 freshness: ensure live ocx-child serve started >= applied_at_ms and POST child-parity
    let live = probe_local_healthz(state.listen_port, Duration::from_millis(500));
    let needs_rollover = match (&live, state.daemon_pid, state.daemon_started_at_ms) {
        (Some(h), Some(pid), Some(started_ms))
            if h.service == "opencodex" && h.ephemeral_child == Some(true) && h.pid == pid =>
        {
            started_ms < applied_at_ms
        }
        _ => true,
    };
    let runtime_started_ms = if needs_rollover {
        match start_or_rollover_daemon(&paths, &mut state, Some(applied_at_ms))
            .and_then(|pending| pending.commit())
        {
            Ok((_, s_ms)) => s_ms,
            Err(e) => {
                eprintln!("The client runtime restart did not complete: {e}");
                return 1;
            }
        }
    } else {
        state.daemon_started_at_ms.unwrap_or(now_ms)
    };

    if !stale {
        state.parity_sequence += 1;
        let _ = write_child_state(&paths.state_file, &state);
        let report = LinkChildParityReport {
            link_id: state.link_id.clone(),
            last_apply_at: Some(applied_at_ms),
            runtime_started_at: runtime_started_ms,
            applied_codex_settings_digest: Some(new_digest),
            sequence: state.parity_sequence,
        };
        let _ = post_child_parity_report(state.tunnel_port, &creds, &report);
    }

    let home_state = if stale { "stale" } else { "synced" };
    let human_msg = if stale {
        STALE_REMOTE_CATALOG_MESSAGE
    } else {
        REMOTE_LINK_SYNC_MESSAGE
    };
    if json_mode {
        eprintln!("{human_msg}");
        println!(
            "{{\"schema\":\"ocx.sync.fanout/1\",\"home\":{{\"state\":\"{home_state}\",\"exit\":0}},\"fanout\":{{\"state\":\"not-applicable\",\"reason\":null}},\"children\":[]}}"
        );
    } else {
        println!("{human_msg}");
    }
    0
}

fn cmd_detach(args: &[String]) -> u8 {
    detach_with_exe(args, None)
}

pub fn detach_with_exe(args: &[String], current_exe_override: Option<&Path>) -> u8 {
    let mut keep_catalog = false;
    let mut json_mode = false;
    let mut purge = false;
    let mut expect_link: Option<String> = None;
    let usage = || {
        eprintln!(
            "Usage: ocx-child detach [--keep-catalog] [--purge] [--json] [--expect-link <link id>]"
        );
        2
    };
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        i += 1;
        match arg {
            "--keep-catalog" => keep_catalog = true,
            "--json" => json_mode = true,
            "--purge" => purge = true,
            "--expect-link" if expect_link.is_none() => {
                expect_link = args.get(i).cloned();
                i += 1;
                if expect_link.is_none() {
                    return usage();
                }
            }
            _ => match arg.strip_prefix("--expect-link=") {
                Some(value) if expect_link.is_none() => expect_link = Some(value.to_owned()),
                _ => return usage(),
            },
        }
    }
    if let Some(id) = &expect_link
        && !is_valid_link_id(id)
    {
        eprintln!("--expect-link needs a link id of the form lnk_ followed by 16 hex digits.");
        return 2;
    }
    let expect = expect_link.as_deref();
    let local_paths = current_paths();
    let lock = match FileLock::acquire_blocking(&local_paths.lock_file) {
        Ok(l) => l,
        Err(_) => {
            eprintln!("detach failed: child lifecycle lock busy");
            return 1;
        }
    };
    let mut codex_guard =
        match CodexHomeGuard::acquire(&local_paths, true, false, ClaimPolicy::Detach) {
            Ok(guard) => guard,
            Err(CodexHomeError::Missing) => {
                if let Some(link) = expect
                    && let Some((record, path)) = first_child_record(&local_paths)
                {
                    return refuse_expected_link(
                        json_mode,
                        ExpectLinkRefusal::Residual,
                        link,
                        record,
                        &path,
                        "Codex home does not exist while child recovery records remain",
                    );
                }
                if let Err(code) = detach_without_codex_home(&local_paths) {
                    return code;
                }
                let purged = match purge_with_receipt(
                    purge,
                    current_exe_override,
                    &local_paths.opencodex_home,
                    expect,
                    crate::journal::DetachOutcome::NotAttached,
                ) {
                    Ok(purged) => purged,
                    Err(code) => return code,
                };
                drop(lock);
                print_detached(
                    json_mode,
                    crate::journal::DetachOutcome::NotAttached,
                    purged,
                    expect,
                );
                return 0;
            }
            Err(CodexHomeError::Refused(msg)) if expect.is_some() => {
                return refuse_expected_link(
                    json_mode,
                    ExpectLinkRefusal::Conflict,
                    expect.unwrap_or_default(),
                    "codex-home-owner",
                    &local_paths.codex_owner_path(),
                    &msg,
                );
            }
            Err(e) => {
                eprintln!("detach refused: {}", e.message());
                return 1;
            }
        };
    if let Some(link) = expect {
        if let Err(code) = check_expected_link(&codex_guard, link, json_mode) {
            return code;
        }
        crate::test_hooks::barrier("expect-link-checked");
    }
    let paths = codex_guard.paths().clone();
    if let Err(e) = codex_guard.set_phase(OwnershipPhase::Detaching) {
        eprintln!("detach failed recording Codex home ownership phase: {e}");
        return 1;
    }
    let _startup_gate = match FileLock::acquire_blocking(&paths.child_dir.join("daemon-start.lock"))
    {
        Ok(lock) => lock,
        Err(_) => {
            eprintln!("detach failed: daemon startup gate unavailable");
            return 1;
        }
    };
    if let Err(e) = AttachRollbackSnapshot::recover(&codex_guard) {
        eprintln!("detach recovery failed: {e}");
        return 1;
    }
    let journal_exists = match validate_existing_journal_paths(&paths) {
        Ok(exists) => exists,
        Err(e) => {
            eprintln!("detach refused: {e}");
            return 1;
        }
    };
    let state = match read_child_state(&paths.state_file) {
        StateReadOutcome::Valid(st) if journal_exists => Some(st),
        StateReadOutcome::Absent => None,
        _ => {
            eprintln!("detach refused: child state or recovery journal is invalid");
            return 1;
        }
    };
    if !journal_exists {
        for path in [&paths.key_file, &paths.catalog_backup_file] {
            match fs::symlink_metadata(path) {
                Ok(_) => {
                    eprintln!("detach refused: orphaned child recovery material exists");
                    return 1;
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => {
                    eprintln!("detach refused: cannot inspect child recovery material: {e}");
                    return 1;
                }
            }
        }
    }
    if let Some(mut st) = state {
        st.pending_operation = Some("disconnect".to_owned());
        if let Err(e) = write_child_state(&paths.state_file, &st) {
            eprintln!("detach refused: failed to record pending operation: {e}");
            return 1;
        }
        if let Err(e) = stop_owned_daemon(&st) {
            eprintln!("{e}");
            return 1;
        }
    }
    let outcome = match offline_detach_deferred(&codex_guard, keep_catalog) {
        Ok(o) => o,
        Err(DetachError::Conflict(msg)) => {
            eprintln!("detach conflict: {msg}");
            return 4;
        }
        Err(DetachError::Io(msg)) => {
            eprintln!("detach failed: {msg}");
            return 1;
        }
    };
    for path in [
        &paths.key_file,
        &paths.state_file,
        &paths.catalog_backup_file,
        &paths.journal_file,
    ] {
        if let Err(e) = codex_guard.restore_step(|| remove_optional_file(path)) {
            eprintln!("detach cleanup failed: {}", e.into_message());
            return 1;
        }
    }
    // Ownership is released last, after cleanup is durable, so a crash before this point
    // leaves a record that only this OpenCodex home's detach can resume.
    if let Err(e) = codex_guard.release() {
        eprintln!("detach cleanup failed releasing Codex home ownership: {e}");
        return 1;
    }
    drop(codex_guard);
    // The lifecycle lock lives outside the child directory, so the emptied directory can go.
    // The start gate is removed only after it is released; a relay still waiting on it finds
    // no state and exits without serving.
    drop(_startup_gate);
    let _ = remove_optional_file(&paths.child_dir.join("daemon-start.lock"));
    let _ = fs::remove_dir(&paths.child_dir);
    let purged = match purge_with_receipt(
        purge,
        current_exe_override,
        &paths.opencodex_home,
        expect,
        outcome,
    ) {
        Ok(purged) => purged,
        Err(code) => return code,
    };
    drop(lock);
    print_detached(json_mode, outcome, purged, expect);
    0
}

#[derive(Clone, Copy)]
enum ExpectLinkRefusal {
    /// Leftover state this command will not restore; the owning home's plain detach can.
    Residual,
    /// The Child belongs to another link or home, or its records cannot be read.
    Conflict,
}

/// Refuse `detach --expect-link` without changing anything: exit 6 residual, exit 5 conflict.
fn refuse_expected_link(
    json_mode: bool,
    kind: ExpectLinkRefusal,
    link_id: &str,
    record: &str,
    path: &Path,
    reason: &str,
) -> u8 {
    let (outcome, code) = match kind {
        ExpectLinkRefusal::Residual => ("residual", 6),
        ExpectLinkRefusal::Conflict => ("conflict", 5),
    };
    if json_mode {
        println!(
            "{}",
            serde_json::json!({
                "restored": false,
                "outcome": outcome,
                "linkId": link_id,
                "record": record,
                "path": path.display().to_string(),
                "reason": reason,
                "purged": false,
            })
        );
    }
    eprintln!(
        "detach --expect-link {link_id} refused ({outcome}): {reason}; record {}; nothing was restored.",
        path.display()
    );
    code
}

/// The first child recovery record that exists, by the name a refusal reports.
fn first_child_record(paths: &ChildPaths) -> Option<(&'static str, PathBuf)> {
    [
        ("child-state", &paths.state_file),
        ("attach-rollback", &paths.rollback_file),
        ("codex-journal", &paths.journal_file),
        ("link-key", &paths.key_file),
        ("catalog-backup", &paths.catalog_backup_file),
    ]
    .into_iter()
    .find(|(_, path)| fs::symlink_metadata(path).is_ok())
    .map(|(name, path)| (name, path.clone()))
}

/// The link an unresolved attach rollback would put back: `None` without a snapshot,
/// `Some(None)` for a first attach (no prior state), `Some(Some(id))` for a re-attach. The
/// snapshot is parsed and checked exactly as `AttachRollbackSnapshot::recover` will, so a
/// record recovery would refuse is refused here, before anything changes.
fn rollback_prior_link(paths: &ChildPaths) -> Result<Option<Option<String>>, String> {
    reject_symlink(&paths.rollback_file)?;
    let mut bytes = match fs::File::open(&paths.rollback_file) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(MAX_ROLLBACK_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| format!("cannot read rollback snapshot: {e}"))?;
            bytes
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot open rollback snapshot: {e}")),
    };
    let parsed = if bytes.len() as u64 > MAX_ROLLBACK_BYTES {
        Err("rollback snapshot exceeds size limit".to_owned())
    } else {
        serde_json::from_slice::<AttachRollbackRecord>(&bytes)
            .map_err(|e| format!("malformed rollback snapshot: {e}"))
    };
    volatile_zero_bytes(&mut bytes);
    let record = parsed?;
    let (ocx, codex) = AttachRollbackSnapshot::canonical_homes(paths)?;
    if record.schema != "ocx.child.attach-rollback/1"
        || record.opencodex_home != ocx
        || record.codex_home != codex
        || record.opencodex_home_identity != directory_identity(Path::new(&ocx))?
        || record.codex_home_identity != directory_identity(Path::new(&codex))?
    {
        return Err("rollback snapshot belongs to a different home".to_owned());
    }
    // Attach reads an unreadable state.json as no prior state but still snapshots its bytes: such a
    // snapshot would put back an earlier attachment whose link nobody can name, so it is refused.
    if record.prior_state.is_none()
        && (record.state_bytes.is_some()
            || record.journal.is_some()
            || record.key.is_some()
            || record.catalog_backup.is_some())
    {
        return Err(
            "rollback snapshot holds an earlier attachment's files but no readable prior state"
                .to_owned(),
        );
    }
    Ok(Some(
        record
            .prior_state
            .as_ref()
            .map(|prior| prior.link_id.clone()),
    ))
}

fn detach_receipt_path(opencodex_home: &Path, link_id: &str) -> PathBuf {
    opencodex_home
        .join("link-receipts")
        .join(format!("{link_id}.json"))
}

/// Durable, link-bound proof that `detach --expect-link` restored this Child, kept in
/// `$OPENCODEX_HOME/link-receipts/<link id>.json` after the child directory is gone, so a Home
/// whose answer was lost after the purge can still read it. It records the restore only: whether
/// the planted binary is gone is read from the binary itself. An attach of the same link removes
/// it under the lifecycle lock before it changes anything. Holds no credential.
fn write_detach_receipt(
    opencodex_home: &Path,
    link_id: &str,
    outcome: crate::journal::DetachOutcome,
) -> Result<(), String> {
    let path = detach_receipt_path(opencodex_home, link_id);
    if let Some(dir) = path.parent() {
        ensure_private_dir(dir)?;
    }
    let body = serde_json::json!({
        "schema": "ocx.child.detach-receipt/1",
        "linkId": link_id,
        "restored": true,
        "outcome": format!("{outcome:?}"),
    });
    write_private_atomic(&path, format!("{body}\n").as_bytes())
}

/// Purge under the lifecycle lock; with `--expect-link`, the restore receipt is durable before
/// the purge starts, so a crash or a lost answer at any later point stays provable.
fn purge_with_receipt(
    purge: bool,
    current_exe_override: Option<&Path>,
    opencodex_home: &Path,
    expect: Option<&str>,
    outcome: crate::journal::DetachOutcome,
) -> Result<bool, u8> {
    if let Some(link_id) = expect
        && let Err(e) = write_detach_receipt(opencodex_home, link_id, outcome)
    {
        eprintln!("detach could not record its receipt: {e}");
        return Err(1);
    }
    purge_after_detach(purge, current_exe_override)
}

/// Restore only when both `state.json` and the ownership record name `link_id`, and an
/// unresolved attach rollback would not put back another link; or when nothing at all is left.
/// Runs with the lifecycle and `CODEX_HOME` locks held, which the restore keeps, so no other
/// enrollment can run between this check and the restore.
fn check_expected_link(guard: &CodexHomeGuard, link_id: &str, json_mode: bool) -> Result<(), u8> {
    let paths = guard.paths();
    let owner_path = paths.codex_owner_path();
    let state_path = &paths.state_file;
    let refuse = |kind, record, path: &Path, reason: &str| {
        Err(refuse_expected_link(
            json_mode, kind, link_id, record, path, reason,
        ))
    };
    let state = read_child_state(state_path);
    if let StateReadOutcome::Invalid(e) = &state {
        return refuse(
            ExpectLinkRefusal::Conflict,
            "child-state",
            state_path,
            &format!("the Child state cannot be read ({e})"),
        );
    }
    let rollback = match rollback_prior_link(paths) {
        Ok(rollback) => rollback,
        Err(e) => {
            return refuse(
                ExpectLinkRefusal::Conflict,
                "attach-rollback",
                &paths.rollback_file,
                &format!("the attach rollback snapshot cannot be read ({e})"),
            );
        }
    };
    let owner = guard.owner_record();
    // Every link the records name. More than one means an attach replaced another link's
    // attachment. An interrupted one (phase attaching, or a rollback left) that also names this
    // link is residual: a plain detach would restore that other link and then remove it, so the
    // bound detach leaves it. Any other mix is a conflict.
    let mut named: Vec<(&'static str, PathBuf, String)> = Vec::new();
    if let StateReadOutcome::Valid(st) = &state {
        named.push(("child-state", state_path.clone(), st.link_id.clone()));
    }
    if let Some(id) = owner.and_then(|r| r.link_id.clone()) {
        named.push(("codex-home-owner", owner_path.clone(), id));
    }
    if let Some(Some(id)) = &rollback {
        named.push(("attach-rollback", paths.rollback_file.clone(), id.clone()));
    }
    if let Some((record, path, _)) = named.iter().find(|(_, _, id)| id != link_id) {
        let interrupted =
            rollback.is_some() || owner.is_some_and(|r| r.phase == OwnershipPhase::Attaching);
        return if interrupted && named.iter().any(|(_, _, id)| id == link_id) {
            refuse(
                ExpectLinkRefusal::Residual,
                record,
                path,
                "an interrupted attach replaced another link's attachment; a plain detach would restore and remove that link",
            )
        } else {
            refuse(
                ExpectLinkRefusal::Conflict,
                record,
                path,
                "the Child is linked to another link",
            )
        };
    }
    let state_names_link = matches!(state, StateReadOutcome::Valid(_));
    // The record names this link without its state: an attach of it stopped before its state write (phase attaching), or a
    // detach of it stopped after marking the record detaching, whether before or after it removed state.json, and possibly
    // while it restored an attach rollback (#8691 review). The bound detach finishes either as a plain one would. Any
    // rollback left names no link (the machine had none) or this one, since one naming another link was refused above, so
    // restoring it puts back no other link.
    let own_interrupted = owner.is_some_and(|r| {
        matches!(
            r.phase,
            OwnershipPhase::Attaching | OwnershipPhase::Detaching
        )
    }) && rollback
        .as_ref()
        .is_none_or(|prior| prior.as_deref().is_none_or(|id| id == link_id));
    match owner.map(|r| r.link_id.as_deref()) {
        Some(None) => refuse(
            ExpectLinkRefusal::Residual,
            "codex-home-owner",
            &owner_path,
            "the ownership record names no link (schema /1)",
        ),
        Some(Some(_)) if state_names_link => Ok(()),
        Some(Some(_)) if own_interrupted => Ok(()),
        Some(Some(_)) => refuse(
            ExpectLinkRefusal::Residual,
            "codex-home-owner",
            &owner_path,
            "the Child state is missing while the ownership record names this link outside an interrupted attach or detach",
        ),
        None if state_names_link => refuse(
            ExpectLinkRefusal::Residual,
            "child-state",
            state_path,
            "the Child state names this link but no ownership record does",
        ),
        None => match first_child_record(paths) {
            Some((record, path)) => refuse(
                ExpectLinkRefusal::Residual,
                record,
                &path,
                "a child recovery record remains without state or ownership record",
            ),
            None => Ok(()),
        },
    }
}

/// Removes the running binary when `--purge` was requested and it sits in the managed plant
/// directory. Runs only after every recovery record is gone, while the caller still holds the
/// lifecycle lock, so an attach waiting on that lock cannot start before the binary is gone.
fn purge_after_detach(purge: bool, current_exe_override: Option<&Path>) -> Result<bool, u8> {
    if !purge {
        return Ok(false);
    }
    crate::test_hooks::barrier("purge-before-remove");
    let exe = match current_exe_override {
        Some(p) => p.to_path_buf(),
        None => match std::env::current_exe() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("detach --purge failed resolving current executable: {e}");
                return Err(1);
            }
        },
    };
    let user_home = resolve_user_home();
    let local_appdata = std::env::var_os("LOCALAPPDATA")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    match purge_managed_executable(&exe, &user_home, local_appdata.as_deref()) {
        Ok(PurgeExecutableOutcome::Removed) => Ok(true),
        Ok(PurgeExecutableOutcome::SkippedUnmanagedPath) => Ok(false),
        Ok(PurgeExecutableOutcome::InUse) => {
            // A fixed line the Home matches (remote-plant.ts PURGE_KEPT_IN_USE_MARKER).
            eprintln!("ocx-purge-kept:binary_in_use");
            eprintln!(
                "detach --purge kept the planted ocx-child: another ocx-child relay is running from it"
            );
            Ok(false)
        }
        Err(e) => {
            eprintln!("detach --purge failed: {e}");
            Err(1)
        }
    }
}

fn print_detached(
    json_mode: bool,
    outcome: crate::journal::DetachOutcome,
    purged: bool,
    expect_link: Option<&str>,
) {
    if json_mode {
        match expect_link {
            // A receipt bound to the link the caller expected.
            Some(link_id) => println!(
                "{{\"restored\":true,\"outcome\":\"{outcome:?}\",\"daemonRunning\":false,\"purged\":{purged},\"linkId\":\"{link_id}\"}}"
            ),
            None => println!(
                "{{\"restored\":true,\"outcome\":\"{outcome:?}\",\"daemonRunning\":false,\"purged\":{purged}}}"
            ),
        }
    } else {
        println!(
            "Disconnected ephemeral Remote Link Child ({outcome:?}, purged={purged}); zero background daemon running."
        );
    }
}

/// Detach when `CODEX_HOME` does not exist: succeed only if nothing needs restoring.
fn detach_without_codex_home(paths: &ChildPaths) -> Result<(), u8> {
    for path in [
        &paths.rollback_file,
        &paths.journal_file,
        &paths.state_file,
        &paths.key_file,
        &paths.catalog_backup_file,
    ] {
        match fs::symlink_metadata(path) {
            Ok(_) => {
                eprintln!(
                    "detach refused: Codex home does not exist; child recovery records were kept"
                );
                return Err(1);
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => {
                eprintln!("detach refused: cannot inspect child recovery material: {e}");
                return Err(1);
            }
        }
    }
    Ok(())
}

fn cmd_status(args: &[String]) -> u8 {
    let wants_json = args.iter().any(|a| a == "--json");
    if args.iter().any(|a| a != "--json") {
        eprintln!("Usage: ocx status [--json]");
        return 1;
    }
    let paths = current_paths();
    let state_opt = match read_child_state(&paths.state_file) {
        StateReadOutcome::Valid(st) => Some(*st),
        _ => None,
    };
    let port = state_opt
        .as_ref()
        .map(|s| s.listen_port)
        .unwrap_or_else(default_listen_port);
    let live = probe_local_healthz(port, Duration::from_millis(500));
    let verified_live = live.filter(|h| {
        h.service == "opencodex"
            && h.role.as_deref() == Some("client")
            && h.ephemeral_child == Some(true)
            && h.port == port
            && state_opt
                .as_ref()
                .and_then(|s| s.daemon_pid)
                .is_none_or(|expected| expected == h.pid)
    });
    let running = verified_live.is_some();
    let (digest, last_apply_at) = match state_opt.as_ref().and_then(|s| s.applied_settings.as_ref())
    {
        Some(rec) => (Some(rec.digest.clone()), Some(rec.applied_at_ms)),
        None => (None, None),
    };
    let runtime_started_at = if running {
        state_opt.as_ref().and_then(|s| s.daemon_started_at_ms)
    } else {
        None
    };
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "ephemeralChild": true,
        "runtimeRole": if state_opt.is_some() { "client" } else { "standalone" },
        "proxy": {
            "running": running,
            "pid": verified_live.as_ref().map(|h| h.pid),
            "health": {
                "ok": running,
                "url": format!("http://127.0.0.1:{port}/healthz"),
            }
        },
        "listen": { "port": port, "hostname": "127.0.0.1" },
        "connection": match &state_opt {
            Some(st) => serde_json::json!({
                "state": "connected",
                "transport": "link",
                "serverUrl": format!("http://127.0.0.1:{}", st.tunnel_port),
                "apiKeyId": st.api_key_id,
                "link": { "linkId": st.link_id, "tunnelPort": st.tunnel_port },
                "readiness": "ready",
            }),
            None => serde_json::json!({ "state": "disconnected" }),
        },
        "appliedCodexSettingsDigest": digest,
        "lastApplyAt": last_apply_at,
        "runtimeStartedAt": runtime_started_at,
    });
    if wants_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&payload).unwrap_or_default()
        );
    } else {
        println!(
            "ocx-child: {} (port {port}, proxy {})",
            if state_opt.is_some() {
                "attached"
            } else {
                "detached"
            },
            if running { "running" } else { "stopped" }
        );
    }
    0
}

fn cmd_connect_status(args: &[String]) -> u8 {
    let wants_json = args.iter().any(|a| a == "--json");
    let paths = current_paths();
    let payload = match read_child_state(&paths.state_file) {
        StateReadOutcome::Valid(st) => serde_json::json!({
            "state": "connected",
            "transport": "link",
            "link": { "linkId": st.link_id, "tunnelPort": st.tunnel_port },
            "serverUrl": format!("http://127.0.0.1:{}", st.tunnel_port),
            "apiKeyId": st.api_key_id,
            "protocolVersion": 1,
            "catalog": if paths.codex_catalog_path().exists() { "present" } else { "missing" },
            "token": if paths.key_file.exists() { "owned" } else { "missing" },
            "readiness": "ready",
        }),
        StateReadOutcome::Absent => serde_json::json!({ "state": "disconnected" }),
        StateReadOutcome::Invalid(reason) => {
            serde_json::json!({ "state": "invalid", "reason": reason })
        }
    };
    if wants_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&payload).unwrap_or_default()
        );
    } else {
        println!(
            "Connection: {}",
            payload["state"].as_str().unwrap_or("unknown")
        );
    }
    0
}

fn cmd_link_status(args: &[String]) -> u8 {
    let wants_json = args.iter().any(|a| a == "--json");
    let paths = current_paths();
    let payload = match read_child_state(&paths.state_file) {
        StateReadOutcome::Valid(st) => serde_json::json!({
            "role": "child",
            "listener": { "state": "off", "port": null },
            "links": [],
            "child": null,
            "linkId": st.link_id,
            "tunnelPort": st.tunnel_port,
        }),
        _ => serde_json::json!({
            "role": "standalone",
            "listener": { "state": "off", "port": null },
            "links": [],
            "child": null,
        }),
    };
    if wants_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&payload).unwrap_or_default()
        );
    } else {
        println!("Role: {}", payload["role"].as_str().unwrap_or("standalone"));
    }
    0
}

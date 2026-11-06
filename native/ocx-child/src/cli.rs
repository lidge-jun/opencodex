use std::fs;
use std::io::{self, Read};
use std::time::Duration;

use serde::Deserialize;

use crate::codex_settings::{
    HomeCodexSettings, HomeCodexSettingsDocument, HomeIdentity, codex_settings_digest,
};
use crate::daemon::{
    ensure_port_available_for_attach, pick_ephemeral_link_port, probe_local_healthz,
    start_or_rollover_daemon, stop_owned_daemon,
};
use crate::journal::{DetachError, apply_attach_or_sync, offline_detach};
use crate::parity::LinkChildParityReport;
use crate::platform::{
    FileLock, LockAcquireError, SecretBytes, format_iso8601_utc, now_epoch_ms, random_hex,
    resolve_codex_home, resolve_opencodex_home,
};
use crate::relay::{
    RelayCredentials, fetch_home_authenticated, post_child_parity_report, serve_foreground,
};
use crate::relay_auth::{is_valid_key_id, is_valid_link_id};
use crate::routes::RelayAuthKind;
use crate::state::{
    AppliedSettingsRecord, CHILD_STATE_SCHEMA, ChildPaths, ChildStateV1, StateReadOutcome,
    is_valid_link_token_format, read_child_state, read_verified_link_key, write_child_state,
    write_link_key,
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

fn fetch_home_settings_doc(
    tunnel_port: u16,
    creds: &RelayCredentials,
) -> Result<HomeCodexSettingsDocument, String> {
    let (head, body, _) = fetch_home_authenticated(
        tunnel_port,
        creds,
        "GET",
        "/v1/link-management/codex-settings",
        RelayAuthKind::Bearer,
        None,
        64 * 1024,
    )
    .map_err(|e| format!("codex-settings fetch failed: {e:?}"))?;
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
        return Err(format!("Home codex-settings returned HTTP {}", head.status));
    }
    let doc: HomeCodexSettingsDocument =
        serde_json::from_slice(&body).map_err(|e| format!("invalid codex-settings JSON: {e}"))?;
    if !doc.validate() {
        return Err("Home codex-settings failed schema validation".to_owned());
    }
    Ok(doc)
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

    let paths = current_paths();
    let _lock = match FileLock::acquire_blocking(&paths.lock_file) {
        Ok(l) => l,
        Err(_) => {
            eprintln!("attach failed: could not acquire child lifecycle lock");
            return 1;
        }
    };

    let existing_pid = match read_child_state(&paths.state_file) {
        StateReadOutcome::Valid(st) => st.daemon_pid,
        _ => None,
    };
    if let Err(e) = ensure_port_available_for_attach(listen_port, existing_pid) {
        eprintln!("{e}");
        return 1;
    }

    let raw_key_str = match std::str::from_utf8(raw_key.as_slice()) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("invalid credential encoding");
            return 2;
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
            return 1;
        }
        Err(e) => {
            eprintln!("Home /readyz unreachable over tunnel: {e:?}");
            return 1;
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
            return 1;
        }
        Err(e) => {
            eprintln!("Home /v1/catalog failed: {e:?}");
            return 1;
        }
    };

    let settings_doc = match fetch_home_settings_doc(tunnel_port, &creds) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };

    let journal = match apply_attach_or_sync(
        &paths,
        &link_id,
        &api_key_id,
        listen_port,
        &catalog_bytes,
        &settings_doc.settings,
    ) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };

    if let Err(e) = write_link_key(&paths.key_file, raw_key_str) {
        eprintln!("{e}");
        return 1;
    }

    let now_ms = now_epoch_ms();
    let now_iso = format_iso8601_utc(now_ms);
    let digest = codex_settings_digest(&settings_doc.settings);
    let shutdown_secret = match random_hex(24) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
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
        shutdown_secret,
        parity_sequence: 0,
        pending_operation: None,
        applied_settings: Some(AppliedSettingsRecord {
            link_id: link_id.clone(),
            fetched_at: now_iso.clone(),
            applied_at: now_iso,
            applied_at_ms: now_ms,
            digest: digest.clone(),
            document: settings_doc,
        }),
    };
    if let Err(e) = write_child_state(&paths.state_file, &state) {
        eprintln!("{e}");
        return 1;
    }

    if start_daemon {
        match start_or_rollover_daemon(&paths, &mut state, Some(now_ms)) {
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
                eprintln!("{e}");
                return 1;
            }
        }
    }

    println!("Connected to http://127.0.0.1:{tunnel_port} as key {api_key_id}.");
    println!("Local Codex CLI: ready (ephemeral ocx-child Design B attached).");
    0
}

fn cmd_serve(args: &[String]) -> u8 {
    let mut foreground = false;
    let mut listen_port: Option<u16> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--foreground" => {
                foreground = true;
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
        let port = listen_port.unwrap_or_else(|| match read_child_state(&paths.state_file) {
            StateReadOutcome::Valid(st) => st.listen_port,
            _ => default_listen_port(),
        });
        return match serve_foreground(paths, port) {
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
    let floor_ms = state.applied_settings.as_ref().map(|a| a.applied_at_ms);
    let (pid, started_ms) = match start_or_rollover_daemon(&paths, &mut state, floor_ms) {
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
        } else if arg == "--local-only" || arg == "--restart-codex" {
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
        _ => match fs::read(&paths.catalog_backup_file) {
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
        },
    };

    let now_ms = now_epoch_ms();
    let now_iso = format_iso8601_utc(now_ms);
    let settings_doc = match fetch_home_settings_doc(state.tunnel_port, &creds) {
        Ok(doc) => doc,
        Err(_) if stale && state.applied_settings.is_some() => {
            state.applied_settings.as_ref().unwrap().document.clone()
        }
        Err(e) => {
            eprintln!("Connected sync failed without local fallback: {e}");
            return 1;
        }
    };

    let journal = match apply_attach_or_sync(
        &paths,
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
        match start_or_rollover_daemon(&paths, &mut state, Some(applied_at_ms)) {
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
    let keep_catalog = args.iter().any(|a| a == "--keep-catalog");
    let json_mode = args.iter().any(|a| a == "--json");
    let paths = current_paths();
    let _lock = match FileLock::acquire_blocking(&paths.lock_file) {
        Ok(l) => l,
        Err(_) => {
            eprintln!("detach failed: child lifecycle lock busy");
            return 1;
        }
    };
    if let StateReadOutcome::Valid(mut st) = read_child_state(&paths.state_file) {
        st.pending_operation = Some("disconnect".to_owned());
        let _ = write_child_state(&paths.state_file, &st);
        if let Err(e) = stop_owned_daemon(&st) {
            eprintln!("{e}");
            return 1;
        }
    }
    let outcome = match offline_detach(&paths, keep_catalog) {
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
    let _ = fs::remove_file(&paths.key_file);
    let _ = fs::remove_file(&paths.state_file);
    if json_mode {
        println!("{{\"restored\":true,\"outcome\":\"{outcome:?}\",\"daemonRunning\":false}}");
    } else {
        println!(
            "Disconnected ephemeral Remote Link Child ({outcome:?}); zero background daemon running."
        );
    }
    0
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
    let running = live.is_some();
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
            "pid": live.as_ref().map(|h| h.pid),
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

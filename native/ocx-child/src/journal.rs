use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};

use crate::codex_home::{CodexHomeGuard, RestoreStepError};
use crate::codex_settings::HomeCodexSettings;
use crate::platform::{
    DirectoryIdentity, directory_identity, ensure_private_dir, reject_symlink, sha256_hex,
    write_private_atomic, write_regular_atomic,
};
use crate::state::ChildPaths;
use crate::toml_surgeon::{
    ChildInjectedLedger, apply_design_b_config, detect_unowned_root_routing_conflict,
    surgical_detach_config,
};

pub const CHILD_JOURNAL_SCHEMA: &str = "ocx.child.journal/1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildJournalV1 {
    pub schema: String,
    pub link_id: String,
    pub api_key_id: String,
    pub opencodex_home: String,
    pub codex_home: String,
    #[serde(default)]
    pub opencodex_home_identity: Option<DirectoryIdentity>,
    #[serde(default)]
    pub codex_home_identity: Option<DirectoryIdentity>,
    pub catalog_path: String,
    pub pre_attach_config_existed: bool,
    pub pre_attach_config_bytes_b64: Option<String>,
    pub pre_attach_config_sha256: Option<String>,
    pub first_injected_config_sha256: String,
    pub latest_injected_config_sha256: String,
    #[serde(default)]
    pub previous_injected_config_sha256: Option<String>,
    pub untouched_by_external_writer: bool,
    pub pre_attach_catalog_existed: bool,
    pub pre_attach_catalog_bytes_b64: Option<String>,
    pub latest_catalog_sha256: String,
    #[serde(default)]
    pub previous_catalog_sha256: Option<String>,
    pub pre_attach_models_cache_existed: bool,
    pub pre_attach_models_cache_bytes_b64: Option<String>,
    pub latest_models_cache_sha256: Option<String>,
    #[serde(default)]
    pub previous_models_cache_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub retained_external_cache_entries: bool,
    pub ledger: ChildInjectedLedger,
}

/// Deterministic fault-injection points for write-ahead crash-recovery tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JournalWriteFault {
    AfterJournalWrite,
    AfterCatalogWrite,
    AfterCacheWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetachOutcome {
    ExactRestore,
    SurgicalRestore,
    NotAttached,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetachError {
    Conflict(String),
    Io(String),
}

pub fn read_journal(path: &Path) -> Result<Option<ChildJournalV1>, String> {
    reject_symlink(path)?;
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("failed reading journal {}: {e}", path.display())),
    };
    let parsed: ChildJournalV1 =
        serde_json::from_slice(&bytes).map_err(|e| format!("corrupt child journal: {e}"))?;
    if parsed.schema != CHILD_JOURNAL_SCHEMA {
        return Err(format!("unsupported journal schema: {}", parsed.schema));
    }
    Ok(Some(parsed))
}

pub fn write_journal(path: &Path, journal: &ChildJournalV1) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(journal)
        .map_err(|e| format!("failed serializing journal: {e}"))?;
    bytes.push(b'\n');
    write_private_atomic(path, &bytes)
}

fn validate_journal_paths(paths: &ChildPaths, journal: &ChildJournalV1) -> Result<(), String> {
    let current_ocx = fs::canonicalize(&paths.opencodex_home)
        .map_err(|e| format!("cannot resolve current OpenCodex home: {e}"))?;
    let current_codex = fs::canonicalize(&paths.codex_home)
        .map_err(|e| format!("cannot resolve current Codex home: {e}"))?;
    let catalog = Path::new(&journal.catalog_path);
    let expected_ocx_identity = journal
        .opencodex_home_identity
        .as_ref()
        .ok_or("child journal lacks OpenCodex directory identity")?;
    let expected_codex_identity = journal
        .codex_home_identity
        .as_ref()
        .ok_or("child journal lacks Codex directory identity")?;
    if current_ocx != Path::new(&journal.opencodex_home)
        || current_codex != Path::new(&journal.codex_home)
        || catalog != current_codex.join("opencodex-catalog.json")
        || &directory_identity(&current_ocx)? != expected_ocx_identity
        || &directory_identity(&current_codex)? != expected_codex_identity
    {
        return Err("child journal belongs to a different home or catalog path".to_owned());
    }
    Ok(())
}

/// Verify an existing journal before any lifecycle operation changes state or stops a daemon.
pub fn validate_existing_journal_paths(paths: &ChildPaths) -> Result<bool, String> {
    match read_journal(&paths.journal_file)? {
        Some(journal) => {
            validate_journal_paths(paths, &journal)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Fail-closed check ensuring full `ocx` does not own `$OPENCODEX_HOME` or `$CODEX_HOME`.
pub fn assert_no_full_ocx_conflict(paths: &ChildPaths) -> Result<(), String> {
    for name in [
        "runtime-port.json",
        "ocx.pid",
        "service-api-token",
        "client-connect-pending",
    ] {
        let candidate = paths.opencodex_home.join(name);
        if candidate.exists() {
            return Err(format!(
                "attach refused: full OpenCodex runtime state exists at {}",
                candidate.display()
            ));
        }
    }
    let cfg_json = paths.opencodex_home.join("config.json");
    if let Ok(raw) = fs::read(&cfg_json) {
        let non_empty = serde_json::from_slice::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .is_some_and(|obj| !obj.is_empty());
        if non_empty {
            return Err(format!(
                "attach refused: full OpenCodex config.json exists at {}",
                cfg_json.display()
            ));
        }
    }
    for jname in ["opencodex-journal.json", ".opencodex-journal.json"] {
        let jpath = paths.codex_home.join(jname);
        if jpath.exists() {
            return Err(format!(
                "attach refused: full OpenCodex Codex journal exists at {}",
                jpath.display()
            ));
        }
    }
    Ok(())
}

pub fn validate_catalog_json(bytes: &[u8]) -> Result<Vec<serde_json::Value>, String> {
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("downloaded catalog exceeds 4 MiB safety bound".to_owned());
    }
    let val: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("invalid catalog JSON: {e}"))?;
    let models = val
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "catalog JSON missing models array".to_owned())?;
    if models.len() > 2000 {
        return Err("catalog models array exceeds 2000 entries".to_owned());
    }
    let mut seen = HashSet::with_capacity(models.len());
    for item in models {
        let slug = item
            .get("slug")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.trim().is_empty() && s.bytes().all(|b| (0x21..=0x7e).contains(&b)))
            .ok_or_else(|| "catalog contains missing or invalid model slug".to_owned())?;
        if !seen.insert(slug.to_owned()) {
            return Err(format!("catalog contains duplicate slug: {slug}"));
        }
    }
    Ok(models.clone())
}

/// Prepares updated `$CODEX_HOME/models_cache.json` bytes (if changed) and SHA-256 without writing yet.
pub fn prepare_codex_models_cache(
    cache_path: &Path,
    catalog_models: &[serde_json::Value],
) -> Result<(Option<Vec<u8>>, String), String> {
    reject_symlink(cache_path)?;
    let existing_bytes = match fs::read(cache_path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("failed reading models_cache.json: {e}")),
    };
    render_codex_models_cache(existing_bytes.as_deref(), catalog_models, false)
}

fn render_codex_models_cache(
    existing_bytes: Option<&[u8]>,
    catalog_models: &[serde_json::Value],
    retain_unmarked: bool,
) -> Result<(Option<Vec<u8>>, String), String> {
    let catalog_slugs: HashSet<&str> = catalog_models
        .iter()
        .filter_map(|m| m.get("slug").and_then(serde_json::Value::as_str))
        .collect();
    let mut observed_native = Vec::new();
    if let Some(raw) = existing_bytes
        && let Ok(val) = serde_json::from_slice::<serde_json::Value>(raw)
        && let Some(arr) = val.get("models").and_then(serde_json::Value::as_array)
    {
        for entry in arr {
            let is_obs = entry
                .get("opencodex_account_observed_native")
                .and_then(serde_json::Value::as_bool)
                == Some(true);
            let slug = entry
                .get("slug")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if retain_unmarked && slug.is_empty() {
                return Err(
                    "client_models_cache_conflict: local model is missing a slug".to_owned(),
                );
            }
            if (is_obs || retain_unmarked) && !slug.is_empty() && !catalog_slugs.contains(slug) {
                observed_native.push(entry.clone());
            }
        }
    }
    let mut combined = Vec::with_capacity(catalog_models.len() + observed_native.len());
    combined.extend_from_slice(catalog_models);
    combined.extend(observed_native);
    let wrapper = serde_json::json!({
        "fetched_at": "2000-01-01T00:00:00Z",
        "client_version": "0.0.0",
        "models": combined,
    });
    let mut rendered = serde_json::to_vec_pretty(&wrapper)
        .map_err(|e| format!("failed serializing models_cache.json: {e}"))?;
    rendered.push(b'\n');
    let digest = sha256_hex(&rendered);
    let to_write = (existing_bytes != Some(rendered.as_slice())).then_some(rendered);
    Ok((to_write, digest))
}

pub fn refresh_codex_models_cache(
    cache_path: &Path,
    catalog_models: &[serde_json::Value],
) -> Result<String, String> {
    let (to_write, digest) = prepare_codex_models_cache(cache_path, catalog_models)?;
    if let Some(rendered) = to_write {
        write_regular_atomic(cache_path, &rendered)?;
    }
    Ok(digest)
}

pub fn apply_attach_or_sync(
    guard: &CodexHomeGuard,
    link_id: &str,
    api_key_id: &str,
    listen_port: u16,
    catalog_bytes: &[u8],
    settings: &HomeCodexSettings,
) -> Result<ChildJournalV1, String> {
    apply_attach_or_sync_with_fault(
        guard,
        link_id,
        api_key_id,
        listen_port,
        catalog_bytes,
        settings,
        None,
    )
}

pub fn apply_attach_or_sync_with_fault(
    guard: &CodexHomeGuard,
    link_id: &str,
    api_key_id: &str,
    listen_port: u16,
    catalog_bytes: &[u8],
    settings: &HomeCodexSettings,
    fault: Option<JournalWriteFault>,
) -> Result<ChildJournalV1, String> {
    if !guard.is_owner() {
        return Err("attach refused: this OpenCodex home does not own the Codex home".to_owned());
    }
    let paths = guard.paths();
    assert_no_full_ocx_conflict(paths)?;
    let catalog_models = validate_catalog_json(catalog_bytes)?;
    let config_path = paths.codex_config_path();
    let catalog_path = paths.codex_catalog_path();
    let cache_path = paths.codex_models_cache_path();
    reject_symlink(&config_path)?;
    reject_symlink(&catalog_path)?;
    reject_symlink(&cache_path)?;

    let existing_journal = read_journal(&paths.journal_file)?;
    if let Some(journal) = &existing_journal {
        validate_journal_paths(paths, journal)?;
    }
    let current_cfg_bytes = match fs::read(&config_path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("failed reading {}: {e}", config_path.display())),
    };
    let current_cfg_text = match &current_cfg_bytes {
        Some(b) => std::str::from_utf8(b)
            .map_err(|_| "config.toml is not valid UTF-8".to_owned())?
            .to_owned(),
        None => String::new(),
    };

    if existing_journal.is_none() && !current_cfg_text.is_empty() {
        detect_unowned_root_routing_conflict(&current_cfg_text)?;
    }

    ensure_private_dir(&paths.child_dir)?;
    fs::create_dir_all(&paths.codex_home)
        .map_err(|e| format!("failed to create Codex home: {e}"))?;
    let canonical_ocx = fs::canonicalize(&paths.opencodex_home)
        .map_err(|e| format!("cannot resolve OpenCodex home: {e}"))?;
    let canonical_codex = fs::canonicalize(&paths.codex_home)
        .map_err(|e| format!("cannot resolve Codex home: {e}"))?;
    let catalog_path_str = canonical_codex
        .join("opencodex-catalog.json")
        .to_str()
        .ok_or("canonical catalog path is not UTF-8")?
        .to_owned();
    let (next_cfg_text, next_ledger) = apply_design_b_config(
        &current_cfg_text,
        listen_port,
        &catalog_path_str,
        settings,
        existing_journal.as_ref().map(|j| &j.ledger),
    )?;
    let next_cfg_sha = sha256_hex(next_cfg_text.as_bytes());
    let next_cat_sha = sha256_hex(catalog_bytes);

    let (pre_cfg_existed, pre_cfg_b64, pre_cfg_sha, first_inj_sha, prev_inj_sha, untouched) =
        if let Some(prev) = &existing_journal {
            let cur_sha = current_cfg_bytes.as_ref().map(|b| sha256_hex(b));
            let cur_matches_owned = cur_sha.as_deref()
                == Some(prev.latest_injected_config_sha256.as_str())
                || (cur_sha.is_some() && cur_sha == prev.previous_injected_config_sha256);
            let still_untouched = prev.untouched_by_external_writer
                && (cur_matches_owned || cur_sha == prev.pre_attach_config_sha256);
            let carried_prev_cfg = if cur_matches_owned {
                cur_sha
            } else {
                prev.previous_injected_config_sha256
                    .clone()
                    .or_else(|| Some(prev.latest_injected_config_sha256.clone()))
            };
            (
                prev.pre_attach_config_existed,
                prev.pre_attach_config_bytes_b64.clone(),
                prev.pre_attach_config_sha256.clone(),
                prev.first_injected_config_sha256.clone(),
                carried_prev_cfg,
                still_untouched,
            )
        } else {
            let b64 = current_cfg_bytes.as_ref().map(|b| BASE64.encode(b));
            let sha = current_cfg_bytes.as_ref().map(|b| sha256_hex(b));
            (
                current_cfg_bytes.is_some(),
                b64,
                sha,
                next_cfg_sha.clone(),
                None,
                true,
            )
        };

    let (pre_cat_existed, pre_cat_b64, prev_cat_sha) = if let Some(prev) = &existing_journal {
        let mut carried_prev_cat = prev
            .previous_catalog_sha256
            .clone()
            .or_else(|| Some(prev.latest_catalog_sha256.clone()));
        if catalog_path.exists() {
            let existing_cat = fs::read(&catalog_path)
                .map_err(|e| format!("failed reading {}: {e}", catalog_path.display()))?;
            let existing_cat_sha = sha256_hex(&existing_cat);
            let matches_owned_injected = existing_cat_sha == prev.latest_catalog_sha256
                || Some(existing_cat_sha.as_str()) == prev.previous_catalog_sha256.as_deref();
            let matches_pre_attach = prev
                .pre_attach_catalog_bytes_b64
                .as_ref()
                .and_then(|b64| BASE64.decode(b64).ok())
                .is_some_and(|p| p == existing_cat);
            if !matches_owned_injected && !matches_pre_attach {
                return Err(
                    "client_catalog_ownership_changed: opencodex-catalog.json was modified externally"
                        .to_owned(),
                );
            }
            if matches_owned_injected {
                carried_prev_cat = Some(existing_cat_sha);
            }
        }
        (
            prev.pre_attach_catalog_existed,
            prev.pre_attach_catalog_bytes_b64.clone(),
            carried_prev_cat,
        )
    } else {
        match fs::read(&catalog_path) {
            Ok(b) => (true, Some(BASE64.encode(&b)), None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, None, None),
            Err(e) => return Err(format!("failed reading {}: {e}", catalog_path.display())),
        }
    };

    let (mut pre_cache_existed, mut pre_cache_b64, prev_cache_sha) =
        if let Some(prev) = &existing_journal {
            let carried_prev_cache = match fs::read(&cache_path) {
                Ok(existing_cache) => {
                    let existing_cache_sha = sha256_hex(&existing_cache);
                    let matches_owned = Some(existing_cache_sha.as_str())
                        == prev.latest_models_cache_sha256.as_deref()
                        || Some(existing_cache_sha.as_str())
                            == prev.previous_models_cache_sha256.as_deref();
                    if matches_owned {
                        Some(existing_cache_sha)
                    } else {
                        prev.previous_models_cache_sha256
                            .clone()
                            .or_else(|| prev.latest_models_cache_sha256.clone())
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => prev
                    .previous_models_cache_sha256
                    .clone()
                    .or_else(|| prev.latest_models_cache_sha256.clone()),
                Err(e) => return Err(format!("failed reading {}: {e}", cache_path.display())),
            };
            (
                prev.pre_attach_models_cache_existed,
                prev.pre_attach_models_cache_bytes_b64.clone(),
                carried_prev_cache,
            )
        } else {
            match fs::read(&cache_path) {
                Ok(b) => (true, Some(BASE64.encode(&b)), None),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, None, None),
                Err(e) => return Err(format!("failed reading {}: {e}", cache_path.display())),
            }
        };

    let mut retained_external_cache_entries = existing_journal
        .as_ref()
        .is_some_and(|j| j.retained_external_cache_entries);
    let (prepared_cache, latest_cache_sha) = if let Some(prev) = &existing_journal {
        let current = match fs::read(&cache_path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("failed reading models_cache.json: {e}")),
        };
        let externally_modified = current.as_ref().is_some_and(|bytes| {
            let hash = sha256_hex(bytes);
            Some(hash.as_str()) != prev.latest_models_cache_sha256.as_deref()
                && Some(hash.as_str()) != prev.previous_models_cache_sha256.as_deref()
        });
        if current.is_some() && (externally_modified || retained_external_cache_entries) {
            let original = match (
                &prev.pre_attach_models_cache_bytes_b64,
                prev.pre_attach_models_cache_existed,
            ) {
                (Some(encoded), true) => Some(
                    BASE64
                        .decode(encoded)
                        .map_err(|e| format!("bad models_cache snapshot: {e}"))?,
                ),
                (None, false) => None,
                _ => return Err("missing pre-attach models_cache snapshot".to_owned()),
            };
            let current = current
                .as_deref()
                .ok_or("models_cache disappeared during sync")?;
            // `reconciled` is the detach snapshot: injected slugs carry their pre-attach
            // versions there. The live cache below lets the new catalog win every shared slug,
            // exactly as first attach does, and keeps only entries whose slug it does not carry.
            let reconciled = reconcile_modified_models_cache(
                current,
                original.as_deref(),
                &paths.catalog_backup_file,
            )?;
            let (rendered, hash) =
                render_codex_models_cache(Some(&reconciled), &catalog_models, true)?;
            pre_cache_existed = true;
            pre_cache_b64 = Some(BASE64.encode(&reconciled));
            retained_external_cache_entries = true;
            (rendered.or(Some(reconciled)), hash)
        } else {
            prepare_codex_models_cache(&cache_path, &catalog_models)?
        }
    } else {
        prepare_codex_models_cache(&cache_path, &catalog_models)?
    };
    // Until the cache write lands, the cache may still hold the previous catalog's entries, so
    // the backup that tells reconciliation which slugs the Child injected names both catalogs.
    let interim_backup = match &existing_journal {
        Some(_) => interim_catalog_backup(&paths.catalog_backup_file, &catalog_models)?,
        None => None,
    };

    let journal = ChildJournalV1 {
        schema: CHILD_JOURNAL_SCHEMA.to_owned(),
        link_id: link_id.to_owned(),
        api_key_id: api_key_id.to_owned(),
        opencodex_home: canonical_ocx
            .to_str()
            .ok_or("canonical OpenCodex home is not UTF-8")?
            .to_owned(),
        codex_home: canonical_codex
            .to_str()
            .ok_or("canonical Codex home is not UTF-8")?
            .to_owned(),
        opencodex_home_identity: Some(directory_identity(&canonical_ocx)?),
        codex_home_identity: Some(directory_identity(&canonical_codex)?),
        catalog_path: catalog_path_str,
        pre_attach_config_existed: pre_cfg_existed,
        pre_attach_config_bytes_b64: pre_cfg_b64,
        pre_attach_config_sha256: pre_cfg_sha,
        first_injected_config_sha256: first_inj_sha,
        latest_injected_config_sha256: next_cfg_sha,
        previous_injected_config_sha256: prev_inj_sha,
        untouched_by_external_writer: untouched,
        pre_attach_catalog_existed: pre_cat_existed,
        pre_attach_catalog_bytes_b64: pre_cat_b64,
        latest_catalog_sha256: next_cat_sha,
        previous_catalog_sha256: prev_cat_sha,
        pre_attach_models_cache_existed: pre_cache_existed,
        pre_attach_models_cache_bytes_b64: pre_cache_b64,
        latest_models_cache_sha256: Some(latest_cache_sha),
        previous_models_cache_sha256: prev_cache_sha,
        retained_external_cache_entries,
        ledger: next_ledger,
    };
    // Persist recovery journal BEFORE mutating any file in $CODEX_HOME (write-ahead durability).
    write_journal(&paths.journal_file, &journal)?;
    if fault == Some(JournalWriteFault::AfterJournalWrite) {
        return Err("injected fault: AfterJournalWrite".to_owned());
    }
    write_regular_atomic(&catalog_path, catalog_bytes)?;
    write_private_atomic(
        &paths.catalog_backup_file,
        interim_backup.as_deref().unwrap_or(catalog_bytes),
    )?;
    if fault == Some(JournalWriteFault::AfterCatalogWrite) {
        return Err("injected fault: AfterCatalogWrite".to_owned());
    }
    if let Some(cache_bytes) = prepared_cache {
        write_regular_atomic(&cache_path, &cache_bytes)?;
    }
    if interim_backup.is_some() {
        write_private_atomic(&paths.catalog_backup_file, catalog_bytes)?;
    }
    if fault == Some(JournalWriteFault::AfterCacheWrite) {
        return Err("injected fault: AfterCacheWrite".to_owned());
    }
    write_regular_atomic(&config_path, next_cfg_text.as_bytes())?;
    Ok(journal)
}

/// Catalog backup naming the slugs of both the new catalog and the last one the Child injected,
/// or `None` when there is no previous backup to merge.
fn interim_catalog_backup(
    backup_path: &Path,
    catalog_models: &[serde_json::Value],
) -> Result<Option<Vec<u8>>, String> {
    reject_symlink(backup_path)?;
    let previous = match fs::read(backup_path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("failed reading catalog backup: {e}")),
    };
    let previous: serde_json::Value = serde_json::from_slice(&previous).map_err(|e| {
        format!("client_models_cache_reconcile_failed: invalid catalog backup JSON: {e}")
    })?;
    let previous_models = previous
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or("client_models_cache_reconcile_failed: catalog backup missing models array")?;
    let new_slugs: HashSet<&str> = catalog_models
        .iter()
        .filter_map(|m| m.get("slug").and_then(serde_json::Value::as_str))
        .collect();
    let mut merged = catalog_models.to_vec();
    merged.extend(
        previous_models
            .iter()
            .filter(|m| {
                m.get("slug")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|slug| !new_slugs.contains(slug))
            })
            .cloned(),
    );
    serde_json::to_vec(&serde_json::json!({ "models": merged }))
        .map(Some)
        .map_err(|e| format!("failed serializing catalog backup: {e}"))
}

/// Performs 100% offline two-tier restoration of `config.toml`, `opencodex-catalog.json`, and `models_cache.json`.
pub fn offline_detach(
    guard: &CodexHomeGuard,
    keep_catalog: bool,
) -> Result<DetachOutcome, DetachError> {
    offline_detach_inner(guard, keep_catalog, false)
}

/// Restore client files while retaining recovery records until lifecycle cleanup succeeds.
pub fn offline_detach_deferred(
    guard: &CodexHomeGuard,
    keep_catalog: bool,
) -> Result<DetachOutcome, DetachError> {
    offline_detach_inner(guard, keep_catalog, true)
}

pub fn remove_optional_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => {
            #[cfg(unix)]
            {
                let parent = path.parent().ok_or("removed file has no parent")?;
                crate::platform::sync_parent_directory(parent)?;
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("file");
            Err(format!("failed removing {name}: {e}"))
        }
    }
}

fn offline_detach_inner(
    guard: &CodexHomeGuard,
    keep_catalog: bool,
    defer_cleanup: bool,
) -> Result<DetachOutcome, DetachError> {
    let paths = guard.paths();
    let Some(mut journal) = read_journal(&paths.journal_file).map_err(DetachError::Io)? else {
        return Ok(DetachOutcome::NotAttached);
    };
    validate_journal_paths(paths, &journal).map_err(DetachError::Conflict)?;
    let config_path = paths.codex_config_path();
    let catalog_path = Path::new(&journal.catalog_path);
    let cache_path = paths.codex_models_cache_path();
    reject_symlink(&config_path).map_err(DetachError::Io)?;
    reject_symlink(catalog_path).map_err(DetachError::Io)?;
    reject_symlink(&cache_path).map_err(DetachError::Io)?;

    let prior_catalog =
        if !keep_catalog && journal.pre_attach_catalog_existed {
            let encoded = journal
                .pre_attach_catalog_bytes_b64
                .as_ref()
                .ok_or_else(|| {
                    DetachError::Conflict("missing pre-attach catalog snapshot".to_owned())
                })?;
            Some(BASE64.decode(encoded).map_err(|e| {
                DetachError::Conflict(format!("bad pre-attach catalog snapshot: {e}"))
            })?)
        } else {
            None
        };

    if !keep_catalog && catalog_path.exists() {
        let cat_bytes = fs::read(catalog_path)
            .map_err(|e| DetachError::Io(format!("failed reading catalog: {e}")))?;
        let cur_cat_sha = sha256_hex(&cat_bytes);
        let matches_known_injected = cur_cat_sha == journal.latest_catalog_sha256
            || Some(cur_cat_sha.as_str()) == journal.previous_catalog_sha256.as_deref();
        if !matches_known_injected {
            let matches_prior = prior_catalog
                .as_ref()
                .is_some_and(|prior| *prior == cat_bytes);
            if !matches_prior {
                return Err(DetachError::Conflict(
                    "client_catalog_ownership_changed: opencodex-catalog.json was modified externally".to_owned(),
                ));
            }
        }
    }

    enum CacheDetachPlan {
        Noop,
        Remove,
        Write(Vec<u8>),
    }

    let cache_plan = if cache_path.exists() {
        let cur_cache = fs::read(&cache_path)
            .map_err(|e| DetachError::Io(format!("failed reading models_cache.json: {e}")))?;
        let cur_cache_sha = sha256_hex(&cur_cache);
        let cache_untouched = Some(cur_cache_sha.as_str())
            == journal.latest_models_cache_sha256.as_deref()
            || Some(cur_cache_sha.as_str()) == journal.previous_models_cache_sha256.as_deref();
        if journal.pre_attach_models_cache_existed {
            let prior_cache = journal
                .pre_attach_models_cache_bytes_b64
                .as_ref()
                .ok_or_else(|| {
                    DetachError::Conflict("missing pre-attach models_cache snapshot".to_owned())
                })
                .and_then(|b64| {
                    BASE64.decode(b64).map_err(|e| {
                        DetachError::Conflict(format!("bad models_cache snapshot: {e}"))
                    })
                })?;
            if cache_untouched || cur_cache == prior_cache {
                if cur_cache != prior_cache {
                    CacheDetachPlan::Write(prior_cache)
                } else {
                    CacheDetachPlan::Noop
                }
            } else {
                let reconciled = reconcile_modified_models_cache(
                    &cur_cache,
                    Some(&prior_cache),
                    &paths.catalog_backup_file,
                )
                .map_err(DetachError::Conflict)?;
                CacheDetachPlan::Write(reconciled)
            }
        } else if cache_untouched {
            CacheDetachPlan::Remove
        } else {
            let reconciled =
                reconcile_modified_models_cache(&cur_cache, None, &paths.catalog_backup_file)
                    .map_err(DetachError::Conflict)?;
            CacheDetachPlan::Write(reconciled)
        }
    } else {
        CacheDetachPlan::Noop
    };

    let cur_cfg_bytes = match fs::read(&config_path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(DetachError::Io(format!("failed reading config.toml: {e}"))),
    };

    let outcome = match cur_cfg_bytes {
        None if !journal.pre_attach_config_existed && journal.untouched_by_external_writer => {
            DetachOutcome::ExactRestore
        }
        None => DetachOutcome::SurgicalRestore,
        Some(bytes) => {
            let cur_sha = sha256_hex(&bytes);
            let matches_untouched_sha = cur_sha == journal.latest_injected_config_sha256
                || Some(cur_sha.as_str()) == journal.pre_attach_config_sha256.as_deref()
                || Some(cur_sha.as_str()) == journal.previous_injected_config_sha256.as_deref();
            if journal.untouched_by_external_writer && matches_untouched_sha {
                if journal.pre_attach_config_existed {
                    let orig = journal
                        .pre_attach_config_bytes_b64
                        .as_ref()
                        .ok_or_else(|| {
                            DetachError::Conflict("missing pre-attach config snapshot".to_owned())
                        })
                        .and_then(|b64| {
                            BASE64.decode(b64).map_err(|e| {
                                DetachError::Conflict(format!("bad snapshot base64: {e}"))
                            })
                        })?;
                    guard
                        .restore_step(|| write_regular_atomic(&config_path, &orig))
                        .map_err(step_err)?;
                } else {
                    guard
                        .restore_step(|| remove_optional_file(&config_path))
                        .map_err(step_err)?;
                }
                DetachOutcome::ExactRestore
            } else {
                let text = std::str::from_utf8(&bytes)
                    .map_err(|_| DetachError::Conflict("config.toml is not UTF-8".to_owned()))?;
                let stripped =
                    surgical_detach_config(text, &journal.ledger).map_err(DetachError::Conflict)?;
                match stripped {
                    Some(updated) => {
                        guard
                            .restore_step(|| write_regular_atomic(&config_path, updated.as_bytes()))
                            .map_err(step_err)?;
                    }
                    None => {
                        guard
                            .restore_step(|| remove_optional_file(&config_path))
                            .map_err(step_err)?;
                    }
                }
                DetachOutcome::SurgicalRestore
            }
        }
    };

    if !keep_catalog {
        if journal.pre_attach_catalog_existed {
            if let Some(prior_bytes) = &prior_catalog {
                guard
                    .restore_step(|| write_regular_atomic(catalog_path, prior_bytes))
                    .map_err(step_err)?;
            }
        } else {
            guard
                .restore_step(|| remove_optional_file(catalog_path))
                .map_err(step_err)?;
        }
    }

    match cache_plan {
        CacheDetachPlan::Noop => {}
        CacheDetachPlan::Remove => {
            guard
                .restore_step(|| remove_optional_file(&cache_path))
                .map_err(step_err)?;
        }
        CacheDetachPlan::Write(reconciled) => {
            guard
                .restore_step(|| write_regular_atomic(&cache_path, &reconciled))
                .map_err(step_err)?;
        }
    }

    // A retry after cleanup starts must recognize the restored cache without
    // relying on the catalog backup, which cleanup may already have removed.
    match fs::read(&cache_path) {
        Ok(restored) => {
            journal.pre_attach_models_cache_existed = true;
            journal.pre_attach_models_cache_bytes_b64 = Some(BASE64.encode(&restored));
            journal.latest_models_cache_sha256 = Some(sha256_hex(&restored));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            journal.pre_attach_models_cache_existed = false;
            journal.pre_attach_models_cache_bytes_b64 = None;
            journal.latest_models_cache_sha256 = None;
        }
        Err(e) => {
            return Err(DetachError::Io(format!(
                "failed reading restored cache: {e}"
            )));
        }
    }
    journal.previous_models_cache_sha256 = None;
    guard
        .restore_step(|| write_journal(&paths.journal_file, &journal))
        .map_err(step_err)?;

    if !defer_cleanup {
        guard
            .restore_step(|| remove_optional_file(&paths.catalog_backup_file))
            .map_err(step_err)?;
        guard
            .restore_step(|| remove_optional_file(&paths.journal_file))
            .map_err(step_err)?;
    }
    Ok(outcome)
}

fn step_err(e: RestoreStepError) -> DetachError {
    DetachError::Io(e.into_message())
}

/// Rebuilds the pre-attach view of a `models_cache.json` that changed externally while attached.
///
/// Every slug of the last catalog the Child injected is Child-owned while attached, whatever its
/// current content: Codex rewrites the cache and may re-serialize those entries. Such an entry is
/// replaced by its pre-attach version, or dropped when the pre-attach cache did not have the slug.
/// Entries with any other slug were added outside the Child and are kept as they are.
fn reconcile_modified_models_cache(
    cur_cache_bytes: &[u8],
    prior_cache_bytes: Option<&[u8]>,
    last_child_catalog_path: &Path,
) -> Result<Vec<u8>, String> {
    let mut cur_val: serde_json::Value = serde_json::from_slice(cur_cache_bytes).map_err(|e| {
        format!("client_models_cache_reconcile_failed: invalid models_cache.json: {e}")
    })?;
    let cur_models = cur_val
        .get("models")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .ok_or_else(|| {
            "client_models_cache_reconcile_failed: models_cache.json missing models array"
                .to_owned()
        })?;
    let backup_bytes = fs::read(last_child_catalog_path).map_err(|e| {
        format!("client_models_cache_reconcile_failed: missing catalog backup: {e}")
    })?;
    let backup_val: serde_json::Value = serde_json::from_slice(&backup_bytes).map_err(|e| {
        format!("client_models_cache_reconcile_failed: invalid catalog backup JSON: {e}")
    })?;
    let backup_models = backup_val
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            "client_models_cache_reconcile_failed: catalog backup missing models array".to_owned()
        })?;
    let child_slugs: HashSet<&str> = backup_models
        .iter()
        .filter_map(|m| m.get("slug").and_then(serde_json::Value::as_str))
        .collect();
    let prior_by_slug: HashMap<String, serde_json::Value> = match prior_cache_bytes {
        Some(raw) => {
            let pv: serde_json::Value = serde_json::from_slice(raw).map_err(|e| {
                format!(
                    "client_models_cache_reconcile_failed: invalid prior models_cache snapshot: {e}"
                )
            })?;
            pv.get("models")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| {
                    "client_models_cache_reconcile_failed: prior models_cache missing models array"
                        .to_owned()
                })?
                .iter()
                .filter_map(|m| {
                    m.get("slug")
                        .and_then(serde_json::Value::as_str)
                        .map(|s| (s.to_owned(), m.clone()))
                })
                .collect()
        }
        None => HashMap::new(),
    };
    let kept: Vec<serde_json::Value> = cur_models
        .into_iter()
        .filter_map(|entry| {
            let slug = entry
                .get("slug")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if child_slugs.contains(slug) {
                prior_by_slug.get(slug).cloned()
            } else {
                Some(entry)
            }
        })
        .collect();
    if let Some(obj) = cur_val.as_object_mut() {
        obj.insert("models".to_owned(), serde_json::Value::Array(kept));
    }
    let mut out = serde_json::to_vec_pretty(&cur_val)
        .map_err(|e| format!("client_models_cache_reconcile_failed: {e}"))?;
    out.push(b'\n');
    Ok(out)
}

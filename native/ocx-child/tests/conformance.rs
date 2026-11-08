#![deny(unsafe_op_in_unsafe_fn)]

use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

use ocx_child::cli::AttachRollbackSnapshot;
use ocx_child::codex_home::{ClaimPolicy, CodexHomeGuard};
use ocx_child::codex_settings::{
    HomeCodexSettings, codex_settings_digest, codex_settings_digest_payload,
    parse_home_codex_settings_document,
};
use ocx_child::http_wire::{
    BodyFraming, FramingError, stream_upstream_to_chunked_client,
    validate_and_sanitize_request_headers,
};
use ocx_child::journal::{
    DetachError, DetachOutcome, JournalWriteFault, apply_attach_or_sync,
    apply_attach_or_sync_with_fault, offline_detach, offline_detach_deferred,
};
use ocx_child::parity::parse_link_child_parity_report;
use ocx_child::relay_auth::{
    compute_connection_proof, compute_relay_proof, relay_proof_matches, token_fingerprint_hex,
};
use ocx_child::routes::{RelayAuthKind, RouteDecision, classify_child_ingress};
use ocx_child::state::ChildPaths;
use ocx_child::toml_surgeon::{apply_design_b_config, surgical_detach_config};

#[test]
fn detach_preserves_user_edited_web_search_with_managed_marker() {
    let settings = HomeCodexSettings {
        fast_mode: None,
        multi_agent_mode: None,
        web_search_sidecar_enabled: false,
        subagent_defaults: None,
    };
    let (injected, ledger) = apply_design_b_config(
        "web_search = \"cached\"\n",
        10100,
        "/tmp/catalog.json",
        &settings,
        None,
    )
    .unwrap();
    // Unchanged: the journaled injected value is removed and the user's line comes back.
    let untouched = surgical_detach_config(&injected, &ledger).unwrap().unwrap();
    assert!(untouched.contains("web_search = \"cached\""), "{untouched}");
    assert!(
        !untouched.contains("web_search = \"disabled\""),
        "{untouched}"
    );
    let edited = injected.replace("web_search = \"disabled\"", "web_search = \"live\"");
    assert_ne!(edited, injected);
    let restored = surgical_detach_config(&edited, &ledger).unwrap().unwrap();
    assert!(restored.contains("web_search = \"live\""), "{restored}");
    assert!(!restored.contains("web_search = \"cached\""), "{restored}");
}

#[test]
fn detached_reconciled_cache_can_be_retried_after_backup_cleanup() {
    let scratch = std::env::temp_dir().join(format!(
        "ocx-child-retry-cache-{}-{}",
        std::process::id(),
        ocx_child::platform::random_hex(6).unwrap()
    ));
    let _guard = ScratchGuard(scratch.clone());
    let ocx_home = scratch.join("opencodex");
    let codex_home = scratch.join("codex");
    fs::create_dir_all(&ocx_home).unwrap();
    fs::create_dir_all(&codex_home).unwrap();
    let paths = ChildPaths::new(ocx_home, codex_home);
    let settings = HomeCodexSettings {
        fast_mode: None,
        multi_agent_mode: None,
        web_search_sidecar_enabled: true,
        subagent_defaults: None,
    };
    apply_attach_or_sync(
        &owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"remote-model"}]}"#,
        &settings,
    )
    .unwrap();
    let cache_path = paths.codex_models_cache_path();
    let mut cache: serde_json::Value =
        serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
    cache["models"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"slug":"local-added"}));
    fs::write(&cache_path, serde_json::to_vec(&cache).unwrap()).unwrap();
    offline_detach_deferred(&detach_guard(&paths), false).unwrap();
    let restored = fs::read(&cache_path).unwrap();
    fs::remove_file(&paths.catalog_backup_file).unwrap();
    offline_detach_deferred(&detach_guard(&paths), false)
        .expect("retry must not depend on removed backup");
    assert_eq!(fs::read(cache_path).unwrap(), restored);
    assert!(String::from_utf8(restored).unwrap().contains("local-added"));
}

#[test]
fn sync_preserves_new_external_cache_models_through_detach() {
    let scratch = std::env::temp_dir().join(format!(
        "ocx-child-sync-cache-{}-{}",
        std::process::id(),
        ocx_child::platform::random_hex(6).unwrap()
    ));
    let _guard = ScratchGuard(scratch.clone());
    let ocx = scratch.join("opencodex");
    let codex = scratch.join("codex");
    fs::create_dir_all(&ocx).unwrap();
    fs::create_dir_all(&codex).unwrap();
    let paths = ChildPaths::new(ocx, codex);
    let settings = HomeCodexSettings {
        fast_mode: None,
        multi_agent_mode: None,
        web_search_sidecar_enabled: true,
        subagent_defaults: None,
    };
    apply_attach_or_sync(
        &owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"remote-v1"}]}"#,
        &settings,
    )
    .unwrap();
    let cache_path = paths.codex_models_cache_path();
    let mut cache: serde_json::Value =
        serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
    cache["models"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"slug":"local-added"}));
    fs::write(&cache_path, serde_json::to_vec(&cache).unwrap()).unwrap();
    apply_attach_or_sync(
        &owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"remote-v2"}]}"#,
        &settings,
    )
    .unwrap();
    assert!(
        fs::read_to_string(&cache_path)
            .unwrap()
            .contains("local-added")
    );
    apply_attach_or_sync(
        &owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"remote-v3"}]}"#,
        &settings,
    )
    .unwrap();
    assert!(
        fs::read_to_string(&cache_path)
            .unwrap()
            .contains("local-added")
    );
    offline_detach(&detach_guard(&paths), false).unwrap();
    let detached = fs::read_to_string(cache_path).unwrap();
    assert!(detached.contains("local-added"));
    assert!(
        !detached.contains("remote-v1")
            && !detached.contains("remote-v2")
            && !detached.contains("remote-v3")
    );
}

fn cache_fixture(label: &str) -> (ScratchGuard, ChildPaths, HomeCodexSettings) {
    let scratch = std::env::temp_dir().join(format!(
        "ocx-child-{label}-{}-{}",
        std::process::id(),
        ocx_child::platform::random_hex(6).unwrap()
    ));
    let guard = ScratchGuard(scratch.clone());
    let paths = ChildPaths::new(scratch.join("opencodex"), scratch.join("codex"));
    fs::create_dir_all(&paths.opencodex_home).unwrap();
    fs::create_dir_all(&paths.codex_home).unwrap();
    let settings = HomeCodexSettings {
        fast_mode: None,
        multi_agent_mode: None,
        web_search_sidecar_enabled: true,
        subagent_defaults: None,
    };
    (guard, paths, settings)
}

fn cache_models(paths: &ChildPaths) -> Vec<serde_json::Value> {
    let cache: serde_json::Value =
        serde_json::from_slice(&fs::read(paths.codex_models_cache_path()).unwrap()).unwrap();
    cache["models"].as_array().unwrap().clone()
}

const NATIVE_GPT55_CACHE: &[u8] = br#"{"fetched_at":"2026-01-01T00:00:00Z","client_version":"1.0.0","models":[{"slug":"gpt-5.5","display_name":"native"}]}"#;
const HOME_GPT55_CATALOG: &[u8] = br#"{"models":[{"slug":"gpt-5.5","display_name":"home"}]}"#;

#[test]
fn sync_after_external_cache_edit_keeps_home_entries_over_restored_pre_attach_versions() {
    let (_guard, paths, settings) = cache_fixture("sync-shared-slug");
    fs::write(paths.codex_models_cache_path(), NATIVE_GPT55_CACHE).unwrap();
    let sync = || {
        apply_attach_or_sync(
            &owned(&paths),
            "lnk_0123456789abcdef",
            "link:t",
            10100,
            HOME_GPT55_CATALOG,
            &settings,
        )
    };
    sync().unwrap();
    let mut cache: serde_json::Value =
        serde_json::from_slice(&fs::read(paths.codex_models_cache_path()).unwrap()).unwrap();
    cache["models"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"slug":"local-added"}));
    fs::write(
        paths.codex_models_cache_path(),
        serde_json::to_vec(&cache).unwrap(),
    )
    .unwrap();
    for round in 0..2 {
        sync().unwrap_or_else(|e| panic!("sync round {round} failed: {e}"));
        let models = cache_models(&paths);
        assert_eq!(
            models,
            vec![
                serde_json::json!({"slug":"gpt-5.5","display_name":"home"}),
                serde_json::json!({"slug":"local-added"}),
            ],
            "round {round}"
        );
    }
    offline_detach(&detach_guard(&paths), false).unwrap();
    assert_eq!(
        cache_models(&paths),
        vec![
            serde_json::json!({"slug":"gpt-5.5","display_name":"native"}),
            serde_json::json!({"slug":"local-added"}),
        ]
    );
}

#[test]
fn sync_interrupted_before_the_cache_write_still_strips_the_previous_catalog() {
    for retry_sync in [false, true] {
        let (_guard, paths, settings) = cache_fixture("interrupted-cache");
        let sync = |catalog: &[u8], fault: Option<JournalWriteFault>| {
            apply_attach_or_sync_with_fault(
                &owned(&paths),
                "lnk_0123456789abcdef",
                "link:t",
                10100,
                catalog,
                &settings,
                fault,
            )
        };
        sync(br#"{"models":[{"slug":"remote-v1"}]}"#, None).unwrap();
        let mut cache: serde_json::Value =
            serde_json::from_slice(&fs::read(paths.codex_models_cache_path()).unwrap()).unwrap();
        cache["models"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"slug":"local-added"}));
        fs::write(
            paths.codex_models_cache_path(),
            serde_json::to_vec(&cache).unwrap(),
        )
        .unwrap();
        // The new catalog and its backup are written, the cache still holds remote-v1.
        let err = sync(
            br#"{"models":[{"slug":"remote-v2"}]}"#,
            Some(JournalWriteFault::AfterCatalogWrite),
        )
        .unwrap_err();
        assert!(err.contains("AfterCatalogWrite"), "{err}");
        if retry_sync {
            sync(br#"{"models":[{"slug":"remote-v2"}]}"#, None).unwrap();
            let slugs: Vec<_> = cache_models(&paths)
                .iter()
                .map(|m| m["slug"].as_str().unwrap().to_owned())
                .collect();
            assert_eq!(slugs, ["remote-v2", "local-added"]);
        }
        offline_detach(&detach_guard(&paths), false).unwrap();
        assert_eq!(
            cache_models(&paths),
            vec![serde_json::json!({"slug":"local-added"})],
            "retry_sync={retry_sync}"
        );
    }
}

#[test]
fn sync_and_detach_treat_codex_reserialized_home_entries_as_child_owned() {
    for sync_before_detach in [true, false] {
        let (_guard, paths, settings) = cache_fixture("reserialized-home");
        fs::write(paths.codex_models_cache_path(), NATIVE_GPT55_CACHE).unwrap();
        let sync = || {
            apply_attach_or_sync(
                &owned(&paths),
                "lnk_0123456789abcdef",
                "link:t",
                10100,
                HOME_GPT55_CATALOG,
                &settings,
            )
        };
        sync().unwrap();
        // Codex refreshes the stale wrapper and writes the Home entry back with its own defaults.
        let rewritten = br#"{"fetched_at":"2026-11-08T00:00:00Z","client_version":"0.99.0","etag":"abc","models":[{"display_name":"home","slug":"gpt-5.5","visibility":"list"},{"slug":"codex-new"}]}"#;
        fs::write(paths.codex_models_cache_path(), rewritten).unwrap();
        if sync_before_detach {
            sync().expect("sync must accept a Codex rewrite of Home entries");
            assert_eq!(
                cache_models(&paths),
                vec![
                    serde_json::json!({"slug":"gpt-5.5","display_name":"home"}),
                    serde_json::json!({"slug":"codex-new"}),
                ]
            );
        }
        offline_detach(&detach_guard(&paths), false).unwrap();
        assert_eq!(
            cache_models(&paths),
            vec![
                serde_json::json!({"slug":"gpt-5.5","display_name":"native"}),
                serde_json::json!({"slug":"codex-new"}),
            ],
            "sync_before_detach={sync_before_detach}"
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConformanceSuite {
    schema: String,
    route_cases: Vec<RouteCase>,
    framing_cases: Vec<FramingCase>,
    relay_auth_cases: Vec<RelayAuthCase>,
    settings_digest_cases: Vec<SettingsDigestCase>,
    child_parity_cases: Vec<ChildParityCase>,
    journal_roundtrip_cases: Vec<JournalRoundtripCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteCase {
    id: String,
    method: String,
    path: String,
    query: String,
    host_header: Option<String>,
    origin_header: Option<String>,
    upgrade_header: Option<String>,
    expected_action: String,
    expected_auth_header: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FramingCase {
    id: String,
    raw_headers: Vec<(String, String)>,
    expected_outcome: String,
    expected_survived_headers: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayAuthCase {
    id: String,
    raw_token: String,
    token_sha256_hex: String,
    key_id: String,
    link_id: String,
    nonce: String,
    generation: String,
    expected_caller_proof: String,
    expected_listener_proof: String,
    expected_connection_proof: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsDigestCase {
    id: String,
    settings: HomeCodexSettings,
    expected_canonical_json: String,
    expected_digest_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildParityCase {
    id: String,
    raw_json: String,
    expected_valid: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MidSessionMutation {
    kind: String,
    appended_toml: Option<String>,
    prepended_root_line: Option<String>,
    new_base_url: Option<String>,
    raw_override_toml: Option<String>,
    tampered_catalog: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalRoundtripCase {
    id: String,
    pre_attach_toml: Option<String>,
    pre_attach_catalog: Option<String>,
    listen_port: u16,
    initial_settings: HomeCodexSettings,
    sync_settings: Option<HomeCodexSettings>,
    mid_session_mutation: MidSessionMutation,
    expected_attach_ok: bool,
    expected_detach_outcome: String,
    expected_final_toml: Option<String>,
    expected_final_catalog: Option<String>,
}

fn load_suite() -> ConformanceSuite {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixture_path = manifest_dir
        .join("..")
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("link")
        .join("ocx-child-conformance.json");
    let raw = fs::read_to_string(&fixture_path)
        .unwrap_or_else(|e| panic!("failed reading {}: {e}", fixture_path.display()));
    serde_json::from_str(&raw).expect("valid conformance JSON")
}

#[test]
fn conformance_routes_match_typescript() {
    let suite = load_suite();
    assert_eq!(suite.schema, "ocx.child.conformance/1");
    for row in &suite.route_cases {
        let decision = classify_child_ingress(
            &row.method,
            &row.path,
            &row.query,
            row.host_header.as_deref(),
            row.origin_header.as_deref(),
            row.upgrade_header.as_deref(),
        );
        let (action, auth) = match decision {
            RouteDecision::LocalHealthz => ("local_healthz", "none"),
            RouteDecision::LocalReadyz => ("local_readyz", "none"),
            RouteDecision::LocalShutdown => ("local_shutdown", "none"),
            RouteDecision::Reject403Origin => ("reject_403_origin", "none"),
            RouteDecision::Reject426Websocket => ("reject_426_websocket", "none"),
            RouteDecision::Reject404 => ("reject_404", "none"),
            RouteDecision::RelayData {
                auth: RelayAuthKind::Bearer,
            } => ("relay_data", "bearer"),
            RouteDecision::RelayData {
                auth: RelayAuthKind::ApiKeyHeader,
            } => ("relay_data", "x-opencodex-api-key"),
            RouteDecision::RelayManagement => ("relay_management", "bearer"),
        };
        assert_eq!(
            action, row.expected_action,
            "route action mismatch on {}",
            row.id
        );
        assert_eq!(
            auth, row.expected_auth_header,
            "route auth mismatch on {}",
            row.id
        );
    }
}

#[test]
fn conformance_framing_and_header_stripping_match_typescript() {
    let suite = load_suite();
    for row in &suite.framing_cases {
        match validate_and_sanitize_request_headers(&row.raw_headers) {
            Ok(valid) => {
                assert_eq!(row.expected_outcome, "allow", "case {}", row.id);
                let mut survived: Vec<String> =
                    valid.sanitized.into_iter().map(|(k, _)| k).collect();
                survived.sort();
                survived.dedup();
                assert_eq!(survived, row.expected_survived_headers, "case {}", row.id);
            }
            Err(FramingError::Smuggling) => {
                assert_eq!(
                    row.expected_outcome, "reject_400_smuggling",
                    "case {}",
                    row.id
                );
            }
            Err(FramingError::Invalid) => {
                assert_eq!(
                    row.expected_outcome, "reject_400_invalid",
                    "case {}",
                    row.id
                );
            }
            Err(FramingError::HeadersTooLarge) => {
                assert_eq!(
                    row.expected_outcome, "reject_431_headers_too_large",
                    "case {}",
                    row.id
                );
            }
            Err(other) => panic!("unexpected framing error {other:?} on {}", row.id),
        }
    }
}

#[test]
fn conformance_relay_auth_v2_and_connection_proofs_match_typescript() {
    let suite = load_suite();
    for row in &suite.relay_auth_cases {
        let fp = token_fingerprint_hex(&row.raw_token);
        assert_eq!(fp, row.token_sha256_hex, "case {}", row.id);
        let caller =
            compute_relay_proof(&fp, "caller", &row.key_id, &row.link_id, &row.nonce).unwrap();
        let listener =
            compute_relay_proof(&fp, "listener", &row.key_id, &row.link_id, &row.nonce).unwrap();
        let conn =
            compute_connection_proof(&fp, &row.key_id, &row.link_id, &row.nonce, &row.generation)
                .unwrap();
        assert_eq!(caller, row.expected_caller_proof, "case {}", row.id);
        assert_eq!(listener, row.expected_listener_proof, "case {}", row.id);
        assert_eq!(conn, row.expected_connection_proof, "case {}", row.id);
        assert!(relay_proof_matches(
            Some(&caller),
            Some(&row.expected_caller_proof)
        ));
        assert!(!relay_proof_matches(Some(&caller), Some(&listener)));
    }
}

#[test]
fn conformance_ocx6_settings_digest_and_child_parity_match_typescript() {
    let suite = load_suite();
    for row in &suite.settings_digest_cases {
        assert_eq!(
            codex_settings_digest_payload(&row.settings),
            row.expected_canonical_json,
            "case {}",
            row.id
        );
        assert_eq!(
            codex_settings_digest(&row.settings),
            row.expected_digest_hex,
            "case {}",
            row.id
        );
    }
    for row in &suite.child_parity_cases {
        let parsed = parse_link_child_parity_report(&row.raw_json);
        assert_eq!(parsed.is_some(), row.expected_valid, "case {}", row.id);
    }
}

#[test]
fn conformance_journal_roundtrips_and_1798_detach_match_typescript() {
    let suite = load_suite();
    for (idx, row) in suite.journal_roundtrip_cases.iter().enumerate() {
        let scratch = std::env::temp_dir().join(format!(
            "ocx-child-conf-{}-{idx}-{}",
            std::process::id(),
            row.id
        ));
        let _ = fs::remove_dir_all(&scratch);
        let ocx_home = scratch.join("opencodex");
        let codex_home = scratch.join("codex");
        fs::create_dir_all(&ocx_home).unwrap();
        fs::create_dir_all(&codex_home).unwrap();
        let paths = ChildPaths::new(ocx_home, codex_home);

        if let Some(pre_toml) = &row.pre_attach_toml {
            fs::write(paths.codex_config_path(), pre_toml.as_bytes()).unwrap();
        }
        if let Some(pre_cat) = &row.pre_attach_catalog {
            fs::write(paths.codex_catalog_path(), pre_cat.as_bytes()).unwrap();
        }

        let sample_catalog = b"{\"models\":[{\"slug\":\"home-m1\"}]}\n";
        let attach_res = apply_attach_or_sync(
            &owned(&paths),
            "lnk_0123456789abcdef",
            "link:test",
            row.listen_port,
            sample_catalog,
            &row.initial_settings,
        );
        assert_eq!(
            attach_res.is_ok(),
            row.expected_attach_ok,
            "attach {}",
            row.id
        );

        if !row.expected_attach_ok {
            let detach_res = offline_detach(&detach_guard(&paths), false).unwrap();
            assert_eq!(detach_res, DetachOutcome::NotAttached, "case {}", row.id);
            let final_toml = fs::read_to_string(paths.codex_config_path()).ok();
            let final_cat = fs::read_to_string(paths.codex_catalog_path()).ok();
            assert_eq!(final_toml, row.expected_final_toml, "case {}", row.id);
            assert_eq!(final_cat, row.expected_final_catalog, "case {}", row.id);
            let _ = fs::remove_dir_all(&scratch);
            continue;
        }

        if let Some(sync_set) = &row.sync_settings {
            apply_attach_or_sync(
                &owned(&paths),
                "lnk_0123456789abcdef",
                "link:test",
                row.listen_port,
                sample_catalog,
                sync_set,
            )
            .unwrap();
        }
        let effective_settings = row.sync_settings.as_ref().unwrap_or(&row.initial_settings);
        let applied_toml = fs::read_to_string(paths.codex_config_path()).unwrap();
        if let Some(fm) = effective_settings.fast_mode {
            assert!(
                applied_toml.contains(&format!("fast_mode = {fm}")),
                "case {}",
                row.id
            );
        }
        if let Some(sub) = &effective_settings.subagent_defaults {
            assert!(
                applied_toml.contains(&format!("default_subagent_model = \"{}\"", sub.model)),
                "case {}",
                row.id
            );
        }

        match row.mid_session_mutation.kind.as_str() {
            "none" => {}
            "strip_comments_and_append_table" => {
                let cur = fs::read_to_string(paths.codex_config_path()).unwrap();
                let stripped: String = cur
                    .lines()
                    .filter(|l| !l.trim().starts_with('#'))
                    .collect::<Vec<_>>()
                    .join("\n")
                    + "\n"
                    + row
                        .mid_session_mutation
                        .appended_toml
                        .as_deref()
                        .unwrap_or("");
                fs::write(paths.codex_config_path(), stripped.as_bytes()).unwrap();
            }
            "strip_comments_and_prepend_root" => {
                let cur = fs::read_to_string(paths.codex_config_path()).unwrap();
                let stripped = format!(
                    "{}{}\n",
                    row.mid_session_mutation
                        .prepended_root_line
                        .as_deref()
                        .unwrap_or(""),
                    cur.lines()
                        .filter(|l| !l.trim().starts_with('#'))
                        .collect::<Vec<_>>()
                        .join("\n")
                );
                fs::write(paths.codex_config_path(), stripped.as_bytes()).unwrap();
            }
            "replace_root_base_url" => {
                let cur = fs::read_to_string(paths.codex_config_path()).unwrap();
                let next = cur.replace(
                    &format!(
                        "openai_base_url = \"http://127.0.0.1:{}/v1\"",
                        row.listen_port
                    ),
                    &format!(
                        "openai_base_url = \"{}\"",
                        row.mid_session_mutation.new_base_url.as_deref().unwrap()
                    ),
                );
                fs::write(paths.codex_config_path(), next.as_bytes()).unwrap();
            }
            "corrupt_managed_span" => {
                let raw = row
                    .mid_session_mutation
                    .raw_override_toml
                    .as_deref()
                    .unwrap();
                fs::write(paths.codex_config_path(), raw.as_bytes()).unwrap();
            }
            "tamper_catalog" => {
                let tampered = row
                    .mid_session_mutation
                    .tampered_catalog
                    .as_deref()
                    .unwrap();
                fs::write(paths.codex_catalog_path(), tampered.as_bytes()).unwrap();
            }
            other => panic!("unknown mutation {other}"),
        }

        let snap_cfg = fs::read(paths.codex_config_path()).ok();
        let snap_cat = fs::read(paths.codex_catalog_path()).ok();
        let snap_journal = fs::read(&paths.journal_file).ok();

        match offline_detach(&detach_guard(&paths), false) {
            Ok(DetachOutcome::ExactRestore) => {
                assert_eq!(
                    row.expected_detach_outcome, "exact_restore",
                    "case {}",
                    row.id
                );
            }
            Ok(DetachOutcome::SurgicalRestore) => {
                assert_eq!(
                    row.expected_detach_outcome, "surgical_restore",
                    "case {}",
                    row.id
                );
            }
            Ok(DetachOutcome::NotAttached) => {
                assert_eq!(
                    row.expected_detach_outcome, "not_attached",
                    "case {}",
                    row.id
                );
            }
            Err(DetachError::Conflict(_)) => {
                assert_eq!(
                    row.expected_detach_outcome, "refuse_conflict",
                    "case {}",
                    row.id
                );
                assert_eq!(
                    fs::read(paths.codex_config_path()).ok(),
                    snap_cfg,
                    "conflict mutated config on {}",
                    row.id
                );
                assert_eq!(
                    fs::read(paths.codex_catalog_path()).ok(),
                    snap_cat,
                    "conflict mutated catalog on {}",
                    row.id
                );
                assert_eq!(
                    fs::read(&paths.journal_file).ok(),
                    snap_journal,
                    "conflict mutated journal on {}",
                    row.id
                );
            }
            Err(other) => panic!("unexpected detach error {other:?} on {}", row.id),
        }

        let final_toml = fs::read_to_string(paths.codex_config_path()).ok();
        let final_cat = fs::read_to_string(paths.codex_catalog_path()).ok();
        if row.expected_final_toml.is_some() || row.expected_detach_outcome != "refuse_conflict" {
            assert_eq!(
                final_toml, row.expected_final_toml,
                "final toml mismatch on {}",
                row.id
            );
        }
        if row.expected_final_catalog.is_some() || row.expected_detach_outcome != "refuse_conflict"
        {
            assert_eq!(
                final_cat, row.expected_final_catalog,
                "final catalog mismatch on {}",
                row.id
            );
        } else {
            assert!(
                final_cat.is_some(),
                "fail-closed conflict must leave catalog untouched on {}",
                row.id
            );
        }
        let _ = fs::remove_dir_all(&scratch);
    }
}

/// Lock and claim a Codex home the way attach and sync do.
fn owned(paths: &ChildPaths) -> CodexHomeGuard {
    CodexHomeGuard::acquire(paths, true, true, ClaimPolicy::Attach).expect("claim Codex home")
}

/// Lock a Codex home the way detach does.
fn detach_guard(paths: &ChildPaths) -> CodexHomeGuard {
    CodexHomeGuard::acquire(paths, true, false, ClaimPolicy::Detach).expect("lock Codex home")
}

struct ScratchGuard(PathBuf);

impl Drop for ScratchGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn homes_fixture() -> (ScratchGuard, ChildPaths, ChildPaths, HomeCodexSettings) {
    let scratch = std::env::temp_dir().join(format!(
        "ocx-child-homes-{}-{}",
        std::process::id(),
        ocx_child::platform::random_hex(6).unwrap()
    ));
    let guard = ScratchGuard(scratch.clone());
    let original = ChildPaths::new(scratch.join("ocx"), scratch.join("codex-a"));
    let other = ChildPaths::new(scratch.join("ocx"), scratch.join("codex-b"));
    fs::create_dir_all(&original.opencodex_home).unwrap();
    fs::create_dir_all(&original.codex_home).unwrap();
    fs::create_dir_all(&other.codex_home).unwrap();
    let settings = HomeCodexSettings {
        fast_mode: None,
        multi_agent_mode: None,
        web_search_sidecar_enabled: true,
        subagent_defaults: None,
    };
    (guard, original, other, settings)
}

#[test]
fn detach_refuses_a_different_codex_home_before_mutating_the_original() {
    let (_guard, original, other, settings) = homes_fixture();
    fs::write(
        original.codex_config_path(),
        b"approval_policy = 'on-request'\n",
    )
    .unwrap();
    apply_attach_or_sync(
        &owned(&original),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"home"}]}"#,
        &settings,
    )
    .unwrap();
    let config_before = fs::read(original.codex_config_path()).unwrap();
    let catalog_before = fs::read(original.codex_catalog_path()).unwrap();
    let journal_before = fs::read(&original.journal_file).unwrap();

    assert!(matches!(
        offline_detach(&detach_guard(&other), false),
        Err(DetachError::Conflict(_))
    ));
    assert_eq!(
        fs::read(original.codex_config_path()).unwrap(),
        config_before
    );
    assert_eq!(
        fs::read(original.codex_catalog_path()).unwrap(),
        catalog_before
    );
    assert_eq!(fs::read(&original.journal_file).unwrap(), journal_before);
    assert!(!other.codex_config_path().exists());
}

#[test]
fn sync_refuses_a_different_codex_home_without_rewriting_the_journal() {
    let (_guard, original, other, settings) = homes_fixture();
    apply_attach_or_sync(
        &owned(&original),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"home"}]}"#,
        &settings,
    )
    .unwrap();
    let journal_before = fs::read(&original.journal_file).unwrap();
    // Neither the sync nor the attach policy may claim a Codex home that the existing
    // journal does not target, so journal application never runs against it.
    for policy in [ClaimPolicy::Continue, ClaimPolicy::Attach] {
        assert!(CodexHomeGuard::acquire(&other, true, false, policy).is_err());
    }
    let unowned = detach_guard(&other);
    assert!(
        apply_attach_or_sync(
            &unowned,
            "lnk_0123456789abcdef",
            "link:t",
            10100,
            br#"{"models":[{"slug":"home-next"}]}"#,
            &settings,
        )
        .is_err()
    );
    drop(unowned);
    assert_eq!(fs::read(&original.journal_file).unwrap(), journal_before);
    assert!(!other.codex_config_path().exists());
    assert!(!other.codex_owner_path().exists());
}

#[cfg(unix)]
#[test]
fn detach_accepts_an_alias_of_the_same_canonical_codex_home() {
    use std::os::unix::fs::symlink;

    let (guard, original, _other, settings) = homes_fixture();
    apply_attach_or_sync(
        &owned(&original),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"home"}]}"#,
        &settings,
    )
    .unwrap();
    let alias = guard.0.join("codex-alias");
    symlink(&original.codex_home, &alias).unwrap();
    let equivalent = ChildPaths::new(original.opencodex_home.clone(), alias);
    assert_eq!(
        offline_detach(&detach_guard(&equivalent), false).unwrap(),
        DetachOutcome::ExactRestore
    );
}

#[cfg(unix)]
#[test]
fn detach_refuses_a_retargeted_codex_home_alias() {
    use std::os::unix::fs::symlink;

    let (guard, original, other, settings) = homes_fixture();
    let alias = guard.0.join("codex-alias");
    symlink(&original.codex_home, &alias).unwrap();
    let aliased = ChildPaths::new(original.opencodex_home.clone(), alias.clone());
    apply_attach_or_sync(
        &owned(&aliased),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"home"}]}"#,
        &settings,
    )
    .unwrap();
    let original_config = fs::read(original.codex_config_path()).unwrap();
    let original_journal = fs::read(&original.journal_file).unwrap();
    fs::remove_file(&alias).unwrap();
    symlink(&other.codex_home, &alias).unwrap();

    assert!(matches!(
        offline_detach(&detach_guard(&aliased), false),
        Err(DetachError::Conflict(_))
    ));
    assert!(fs::read(original.codex_config_path()).unwrap() == original_config);
    assert!(fs::read(&original.journal_file).unwrap() == original_journal);
    assert!(!other.codex_config_path().exists());
}

#[cfg(unix)]
#[test]
fn detach_refuses_a_replaced_codex_home_directory() {
    let (guard, original, _other, settings) = homes_fixture();
    apply_attach_or_sync(
        &owned(&original),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"home"}]}"#,
        &settings,
    )
    .unwrap();
    let saved = guard.0.join("saved-codex");
    fs::rename(&original.codex_home, &saved).unwrap();
    fs::create_dir(&original.codex_home).unwrap();

    assert!(matches!(
        offline_detach(&detach_guard(&original), false),
        Err(DetachError::Conflict(_))
    ));
    assert!(original.journal_file.is_file());
    assert!(saved.join("config.toml").is_file());
}

#[test]
fn immediate_rollback_refuses_a_replaced_codex_home() {
    let (guard, original, _other, _settings) = homes_fixture();
    fs::write(original.codex_config_path(), b"original config").unwrap();
    let rollback = AttachRollbackSnapshot::capture(&owned(&original), None).unwrap();
    fs::rename(&original.codex_home, guard.0.join("saved-home")).unwrap();
    fs::create_dir(&original.codex_home).unwrap();
    fs::write(original.codex_config_path(), b"replacement config").unwrap();
    assert!(rollback.restore(&detach_guard(&original)).is_err());
    assert_eq!(
        fs::read(original.codex_config_path()).unwrap(),
        b"replacement config"
    );
    assert!(original.rollback_file.exists());
}

#[test]
fn detach_refuses_missing_or_invalid_catalog_snapshot_before_mutation() {
    for damaged in [serde_json::Value::Null, serde_json::json!("not base64!")] {
        let (_guard, paths, _other, settings) = homes_fixture();
        fs::write(
            paths.codex_catalog_path(),
            br#"{"models":[{"slug":"prior"}]}"#,
        )
        .unwrap();
        apply_attach_or_sync(
            &owned(&paths),
            "lnk_0123456789abcdef",
            "link:t",
            10100,
            br#"{"models":[{"slug":"home"}]}"#,
            &settings,
        )
        .unwrap();
        let config_before = fs::read(paths.codex_config_path()).unwrap();
        let catalog_before = fs::read(paths.codex_catalog_path()).unwrap();
        let mut journal: serde_json::Value =
            serde_json::from_slice(&fs::read(&paths.journal_file).unwrap()).unwrap();
        journal["preAttachCatalogBytesB64"] = damaged;
        fs::write(&paths.journal_file, serde_json::to_vec(&journal).unwrap()).unwrap();
        let journal_before = fs::read(&paths.journal_file).unwrap();

        assert!(matches!(
            offline_detach(&detach_guard(&paths), false),
            Err(DetachError::Conflict(_))
        ));
        assert!(fs::read(paths.codex_config_path()).unwrap() == config_before);
        assert!(fs::read(paths.codex_catalog_path()).unwrap() == catalog_before);
        assert!(fs::read(&paths.journal_file).unwrap() == journal_before);
    }
}

#[test]
fn detach_refuses_a_journal_with_a_foreign_catalog_target() {
    let (_guard, original, other, settings) = homes_fixture();
    apply_attach_or_sync(
        &owned(&original),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"home"}]}"#,
        &settings,
    )
    .unwrap();
    let foreign = other.codex_catalog_path();
    fs::write(&foreign, b"foreign").unwrap();
    let mut journal: serde_json::Value =
        serde_json::from_slice(&fs::read(&original.journal_file).unwrap()).unwrap();
    journal["catalogPath"] = serde_json::Value::String(foreign.to_string_lossy().into_owned());
    fs::write(
        &original.journal_file,
        serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();

    assert!(matches!(
        offline_detach(&detach_guard(&original), false),
        Err(DetachError::Conflict(_))
    ));
    assert_eq!(fs::read(foreign).unwrap(), b"foreign");
    assert!(original.journal_file.exists());
}

#[test]
fn failed_first_attach_rollback_keeps_the_recovery_journal() {
    let (_guard, paths, _other, settings) = homes_fixture();
    fs::create_dir_all(&paths.child_dir).unwrap();
    fs::write(&paths.key_file, b"previous-fixture-key").unwrap();
    fs::write(&paths.state_file, b"previous-fixture-state").unwrap();
    let snapshot = AttachRollbackSnapshot::capture(&owned(&paths), None).unwrap();
    apply_attach_or_sync(
        &owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"home"}]}"#,
        &settings,
    )
    .unwrap();
    fs::write(&paths.key_file, b"replacement-fixture-key").unwrap();
    fs::remove_file(paths.codex_config_path()).unwrap();
    fs::create_dir(paths.codex_config_path()).unwrap();

    assert!(snapshot.restore(&detach_guard(&paths)).is_err());
    assert!(
        paths.journal_file.is_file(),
        "recovery journal must survive an incomplete rollback"
    );
    let rollback = fs::read(paths.child_dir.join("attach-rollback.json"))
        .expect("durable rollback snapshot must survive an incomplete rollback");
    let decoded: serde_json::Value = serde_json::from_slice(&rollback).unwrap();
    let expected: Vec<u8> = b"previous-fixture-key".to_vec();
    assert!(
        decoded["key"] == serde_json::json!(expected),
        "prior key was not preserved"
    );
}

#[test]
fn detach_recovers_a_durable_incomplete_attach_snapshot() {
    let (_guard, paths, other, settings) = homes_fixture();
    let snapshot = AttachRollbackSnapshot::capture(&owned(&paths), None).unwrap();
    apply_attach_or_sync(
        &owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"home"}]}"#,
        &settings,
    )
    .unwrap();
    fs::remove_file(paths.codex_config_path()).unwrap();
    fs::create_dir(paths.codex_config_path()).unwrap();
    assert!(snapshot.restore(&detach_guard(&paths)).is_err());
    assert!(paths.rollback_file.is_file());
    let wrong_home = std::process::Command::new(env!("CARGO_BIN_EXE_ocx-child"))
        .arg("detach")
        .env("OPENCODEX_HOME", &other.opencodex_home)
        .env("CODEX_HOME", &other.codex_home)
        .output()
        .unwrap();
    assert!(!wrong_home.status.success());
    assert!(paths.rollback_file.is_file());
    assert!(paths.codex_config_path().is_dir());
    fs::remove_dir(paths.codex_config_path()).unwrap();

    let result = std::process::Command::new(env!("CARGO_BIN_EXE_ocx-child"))
        .arg("detach")
        .env("OPENCODEX_HOME", &paths.opencodex_home)
        .env("CODEX_HOME", &paths.codex_home)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "detach recovery failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!paths.rollback_file.exists());
    assert!(!paths.journal_file.exists());
    assert!(!paths.codex_config_path().exists());
}

#[cfg(unix)]
#[test]
fn rollback_recovery_refuses_a_replaced_codex_home_directory() {
    let (guard, paths, _other, settings) = homes_fixture();
    let snapshot = AttachRollbackSnapshot::capture(&owned(&paths), None).unwrap();
    apply_attach_or_sync(
        &owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"home"}]}"#,
        &settings,
    )
    .unwrap();
    fs::remove_file(paths.codex_config_path()).unwrap();
    fs::create_dir(paths.codex_config_path()).unwrap();
    assert!(snapshot.restore(&detach_guard(&paths)).is_err());
    let saved = guard.0.join("saved-codex");
    fs::rename(&paths.codex_home, &saved).unwrap();
    fs::create_dir(&paths.codex_home).unwrap();

    let result = std::process::Command::new(env!("CARGO_BIN_EXE_ocx-child"))
        .arg("detach")
        .env("OPENCODEX_HOME", &paths.opencodex_home)
        .env("CODEX_HOME", &paths.codex_home)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(paths.rollback_file.is_file());
    assert!(saved.join("config.toml").is_dir());
    assert!(!paths.codex_config_path().exists());
}

#[test]
fn detach_preserves_orphaned_key_when_the_journal_is_missing() {
    let (_guard, paths, _other, _settings) = homes_fixture();
    fs::create_dir_all(&paths.child_dir).unwrap();
    fs::write(&paths.key_file, b"fixture-key").unwrap();
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_ocx-child"))
        .arg("detach")
        .env("OPENCODEX_HOME", &paths.opencodex_home)
        .env("CODEX_HOME", &paths.codex_home)
        .output()
        .unwrap();
    assert!(
        !result.status.success(),
        "orphaned key must require recovery"
    );
    assert!(fs::read(&paths.key_file).unwrap() == b"fixture-key");
}

#[cfg(unix)]
#[test]
fn detach_keeps_recovery_journal_when_required_file_removal_fails() {
    use std::os::unix::fs::PermissionsExt;

    struct RestoreMode(PathBuf);
    impl Drop for RestoreMode {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }

    let (_guard, paths, _other, settings) = homes_fixture();
    apply_attach_or_sync(
        &owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        br#"{"models":[{"slug":"home"}]}"#,
        &settings,
    )
    .unwrap();
    fs::remove_file(paths.codex_models_cache_path()).unwrap();
    let _restore_mode = RestoreMode(paths.codex_home.clone());
    fs::set_permissions(&paths.codex_home, fs::Permissions::from_mode(0o500)).unwrap();

    assert!(matches!(
        offline_detach(&detach_guard(&paths), false),
        Err(DetachError::Io(_))
    ));
    assert!(paths.journal_file.is_file());
    assert!(paths.codex_config_path().is_file());
}

#[test]
fn conformance_multiline_placement_and_write_ahead_journal_crash_recovery() {
    let scratch = std::env::temp_dir().join(format!("ocx-child-wal-{}", std::process::id()));
    let _ = fs::remove_dir_all(&scratch);
    let _guard = ScratchGuard(scratch.clone());
    let ocx_home = scratch.join("opencodex");
    let codex_home = scratch.join("codex");
    fs::create_dir_all(&ocx_home).unwrap();
    fs::create_dir_all(&codex_home).unwrap();
    let paths = ChildPaths::new(ocx_home, codex_home);

    let pre_toml = "developer_instructions = \"\"\"\n[Important]\nNever inject inside me\n\"\"\"\n";
    let pre_cat = b"{\"models\":[{\"slug\":\"native-prior\"}]}\n";
    fs::write(paths.codex_config_path(), pre_toml.as_bytes()).unwrap();
    fs::write(paths.codex_catalog_path(), pre_cat).unwrap();

    let settings = HomeCodexSettings {
        fast_mode: Some(true),
        multi_agent_mode: Some("v1".to_owned()),
        web_search_sidecar_enabled: true,
        subagent_defaults: None,
    };
    let cat_v1 = b"{\"models\":[{\"slug\":\"m-v1\"}]}\n";
    apply_attach_or_sync(
        &owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        cat_v1,
        &settings,
    )
    .unwrap();

    // 1. Verify root keys landed AFTER closing triple quotes, never inside [Important]
    let injected = fs::read_to_string(paths.codex_config_path()).unwrap();
    assert!(injected.starts_with(pre_toml), "injected was:\n{injected}");
    assert!(injected.contains("openai_base_url = \"http://127.0.0.1:10100/v1\""));
    let cache_v1 = fs::read(paths.codex_models_cache_path()).unwrap();

    // 2. Two consecutive interrupted syncs:
    //    - sync v2 fails right after write_journal (catalog, cache, config remain v1)
    //    - sync v3 fails right after catalog write (catalog is v3, cache & config remain v1)
    let cat_v2 = b"{\"models\":[{\"slug\":\"m-v2\"}]}\n";
    let cat_v3 = b"{\"models\":[{\"slug\":\"m-v3\"}]}\n";
    let settings_v2 = HomeCodexSettings {
        fast_mode: Some(false),
        ..settings.clone()
    };
    let settings_v3 = HomeCodexSettings {
        multi_agent_mode: Some("v2".to_owned()),
        ..settings_v2.clone()
    };
    assert!(
        apply_attach_or_sync_with_fault(
            &owned(&paths),
            "lnk_0123456789abcdef",
            "link:t",
            10100,
            cat_v2,
            &settings_v2,
            Some(JournalWriteFault::AfterJournalWrite),
        )
        .is_err()
    );
    assert!(
        apply_attach_or_sync_with_fault(
            &owned(&paths),
            "lnk_0123456789abcdef",
            "link:t",
            10100,
            cat_v3,
            &settings_v3,
            Some(JournalWriteFault::AfterCatalogWrite),
        )
        .is_err()
    );
    assert_eq!(fs::read(paths.codex_catalog_path()).unwrap(), cat_v3);
    assert_eq!(fs::read(paths.codex_models_cache_path()).unwrap(), cache_v1);
    assert_eq!(
        fs::read_to_string(paths.codex_config_path()).unwrap(),
        injected
    );

    let outcome = offline_detach(&detach_guard(&paths), false).unwrap();
    assert_eq!(outcome, DetachOutcome::ExactRestore);
    assert_eq!(
        fs::read_to_string(paths.codex_config_path()).unwrap(),
        pre_toml
    );
    assert_eq!(fs::read(paths.codex_catalog_path()).unwrap(), pre_cat);
    assert!(!paths.codex_models_cache_path().exists());

    // 3. Two consecutive failed catalog writes (AfterJournalWrite twice) with no pre-attach catalog/cache
    fs::remove_file(paths.codex_catalog_path()).unwrap();
    apply_attach_or_sync(
        &owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        cat_v1,
        &settings,
    )
    .unwrap();
    for (cat, set) in [
        (cat_v2.as_slice(), &settings_v2),
        (cat_v3.as_slice(), &settings_v3),
    ] {
        assert!(
            apply_attach_or_sync_with_fault(
                &owned(&paths),
                "lnk_0123456789abcdef",
                "link:t",
                10100,
                cat,
                set,
                Some(JournalWriteFault::AfterJournalWrite),
            )
            .is_err()
        );
    }
    assert_eq!(fs::read(paths.codex_catalog_path()).unwrap(), cat_v1);
    assert!(paths.codex_models_cache_path().exists());

    let outcome = offline_detach(&detach_guard(&paths), false).unwrap();
    assert_eq!(outcome, DetachOutcome::ExactRestore);
    assert_eq!(
        fs::read_to_string(paths.codex_config_path()).unwrap(),
        pre_toml
    );
    assert!(!paths.codex_catalog_path().exists());
    assert!(!paths.codex_models_cache_path().exists());
}

#[test]
fn strict_settings_validation_chunk_eof_and_catalog_sync_ownership_guards() {
    // 1. Reject omitted keys, U+001B escape, uppercase effort, and UTF-16 > 256
    let omitted_fast = br#"{"version":1,"home":{"name":"h","version":"2.98.0"},"settings":{"multiAgentMode":null,"webSearchSidecarEnabled":true,"subagentDefaults":null}}"#;
    assert!(parse_home_codex_settings_document(omitted_fast).is_none());
    let esc_model = "{\"version\":1,\"home\":{\"name\":\"h\",\"version\":\"2.98.0\"},\"settings\":{\"fastMode\":null,\"multiAgentMode\":null,\"webSearchSidecarEnabled\":true,\"subagentDefaults\":{\"model\":\"bad\\u001bmodel\",\"reasoningEffort\":null}}}";
    assert!(parse_home_codex_settings_document(esc_model.as_bytes()).is_none());
    let upper_effort = br#"{"version":1,"home":{"name":"h","version":"2.98.0"},"settings":{"fastMode":null,"multiAgentMode":null,"webSearchSidecarEnabled":true,"subagentDefaults":{"model":"gpt-5.6","reasoningEffort":"HIGH"}}}"#;
    assert!(parse_home_codex_settings_document(upper_effort).is_none());
    // 128 astral emojis = 256 UTF-16 code units (valid); 129 emojis = 258 UTF-16 units (rejected)
    let ok_astral = "😀".repeat(128);
    let over_astral = "😀".repeat(129);
    let ok_doc = format!(
        "{{ \"version\": 1, \"home\": {{ \"name\": \"h\", \"version\": \"2.98.0\" }}, \"settings\": {{ \"fastMode\": null, \"multiAgentMode\": null, \"webSearchSidecarEnabled\": true, \"subagentDefaults\": {{ \"model\": \"{ok_astral}\", \"reasoningEffort\": \"high\" }} }} }}"
    );
    let bad_doc = format!(
        "{{ \"version\": 1, \"home\": {{ \"name\": \"h\", \"version\": \"2.98.0\" }}, \"settings\": {{ \"fastMode\": null, \"multiAgentMode\": null, \"webSearchSidecarEnabled\": true, \"subagentDefaults\": {{ \"model\": \"{over_astral}\", \"reasoningEffort\": \"high\" }} }} }}"
    );
    assert!(parse_home_codex_settings_document(ok_doc.as_bytes()).is_some());
    assert!(parse_home_codex_settings_document(bad_doc.as_bytes()).is_none());
    // ECMAScript trim: U+FEFF is trimmed, while U+0085 is retained (matching String.prototype.trim)
    let feff_doc = "{\"version\":1,\"home\":{\"name\":\"h\",\"version\":\"2.98.0\"},\"settings\":{\"fastMode\":null,\"multiAgentMode\":null,\"webSearchSidecarEnabled\":true,\"subagentDefaults\":{\"model\":\"\\ufeffgpt-5.6\",\"reasoningEffort\":null}}}";
    let nel_doc = "{\"version\":1,\"home\":{\"name\":\"h\",\"version\":\"2.98.0\"},\"settings\":{\"fastMode\":null,\"multiAgentMode\":null,\"webSearchSidecarEnabled\":true,\"subagentDefaults\":{\"model\":\"\\u0085gpt-5.6\",\"reasoningEffort\":null}}}";
    assert_eq!(
        parse_home_codex_settings_document(feff_doc.as_bytes())
            .unwrap()
            .settings
            .subagent_defaults
            .unwrap()
            .model,
        "gpt-5.6"
    );
    assert_eq!(
        parse_home_codex_settings_document(nel_doc.as_bytes())
            .unwrap()
            .settings
            .subagent_defaults
            .unwrap()
            .model,
        "\u{0085}gpt-5.6"
    );

    // 2. Truncated chunked upstream EOF returns UnexpectedEof without emitting 0\r\n\r\n
    let mut truncated_upstream = std::io::Cursor::new(b"5\r\nhello\r\n".to_vec());
    let mut downstream = Vec::new();
    let stream_err = stream_upstream_to_chunked_client(
        &mut truncated_upstream,
        &mut downstream,
        BodyFraming::Chunked,
        Some(1024),
    )
    .unwrap_err();
    assert_eq!(stream_err.kind(), std::io::ErrorKind::UnexpectedEof);
    assert!(!downstream.ends_with(b"0\r\n\r\n"));

    // 3. External catalog edit during attachment refuses sync and detach preserves user edit
    let scratch = std::env::temp_dir().join(format!("ocx-child-cat-guard-{}", std::process::id()));
    let _ = fs::remove_dir_all(&scratch);
    let paths = ChildPaths::new(scratch.join("ocx"), scratch.join("codex"));
    fs::create_dir_all(&paths.opencodex_home).unwrap();
    fs::create_dir_all(&paths.codex_home).unwrap();
    let set = HomeCodexSettings {
        fast_mode: None,
        multi_agent_mode: None,
        web_search_sidecar_enabled: true,
        subagent_defaults: None,
    };
    apply_attach_or_sync(
        &owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        b"{\"models\":[{\"slug\":\"m1\"}]}\n",
        &set,
    )
    .unwrap();
    let user_cat = b"{\"models\":[{\"slug\":\"user-edited\"}]}\n";
    fs::write(paths.codex_catalog_path(), user_cat).unwrap();
    let sync_err = apply_attach_or_sync(
        &owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        b"{\"models\":[{\"slug\":\"m2\"}]}\n",
        &set,
    )
    .unwrap_err();
    assert!(sync_err.contains("client_catalog_ownership_changed"));
    assert_eq!(fs::read(paths.codex_catalog_path()).unwrap(), user_cat);
    assert!(matches!(
        offline_detach(&detach_guard(&paths), false),
        Err(DetachError::Conflict(_))
    ));
    assert_eq!(fs::read(paths.codex_catalog_path()).unwrap(), user_cat);

    // 4. models_cache.json reconciliation fails closed on missing backup or invalid JSON and restores overwritten native entries
    let _ = fs::remove_dir_all(&scratch);
    let _guard = ScratchGuard(scratch.clone());
    fs::create_dir_all(&paths.opencodex_home).unwrap();
    fs::create_dir_all(&paths.codex_home).unwrap();
    let pre_cache = br#"{"fetched_at":"2000-01-01T00:00:00Z","client_version":"0.0.0","models":[{"slug":"shared-m","context_window":1}]}"#;
    fs::write(paths.codex_models_cache_path(), pre_cache).unwrap();
    apply_attach_or_sync(&owned(&paths),
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        b"{\"models\":[{\"slug\":\"shared-m\",\"context_window\":2},{\"slug\":\"home-only\",\"context_window\":8}]}\n",
        &set,
    )
    .unwrap();
    // Invalid cache JSON fails closed without deleting journal
    fs::write(paths.codex_models_cache_path(), b"{invalid").unwrap();
    assert!(matches!(
        offline_detach(&detach_guard(&paths), false),
        Err(DetachError::Conflict(_))
    ));
    assert!(paths.journal_file.exists());
    // Valid modified cache + missing catalog backup also fails closed before restoring config
    let ext_cache = br#"{"fetched_at":"2000-01-01T00:00:00Z","client_version":"0.0.0","models":[{"slug":"shared-m","context_window":2},{"slug":"home-only","context_window":8},{"slug":"ext-native","context_window":9}]}"#;
    fs::write(paths.codex_models_cache_path(), ext_cache).unwrap();
    let saved_backup = fs::read(&paths.catalog_backup_file).unwrap();
    fs::remove_file(&paths.catalog_backup_file).unwrap();
    assert!(matches!(
        offline_detach(&detach_guard(&paths), false),
        Err(DetachError::Conflict(_))
    ));
    assert!(paths.journal_file.exists());
    // Restore backup -> detach succeeds, restores shared-m context_window: 1, drops home-only, preserves ext-native
    fs::write(&paths.catalog_backup_file, &saved_backup).unwrap();
    assert_eq!(
        offline_detach(&detach_guard(&paths), false).unwrap(),
        DetachOutcome::ExactRestore
    );
    let final_cache: serde_json::Value =
        serde_json::from_slice(&fs::read(paths.codex_models_cache_path()).unwrap()).unwrap();
    let models = final_cache["models"].as_array().unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[0]["slug"], "shared-m");
    assert_eq!(models[0]["context_window"], 1);
    assert_eq!(models[1]["slug"], "ext-native");
    assert_eq!(models[1]["context_window"], 9);

    // 5. AttachRollbackSnapshot::capture rejects non-NotFound read failure & restore reports incomplete rollback
    let snap_ok = AttachRollbackSnapshot::capture(&owned(&paths), None).unwrap();
    let _ = fs::remove_file(paths.codex_config_path());
    fs::create_dir_all(paths.codex_config_path()).unwrap();
    let cap_err = AttachRollbackSnapshot::capture(&owned(&paths), None)
        .err()
        .expect("directory config.toml must fail capture");
    assert!(
        cap_err.contains("attach failed reading"),
        "err was: {cap_err}"
    );
    let rb_err = snap_ok.restore(&detach_guard(&paths)).unwrap_err();
    assert!(
        rb_err.contains("attach rollback incomplete"),
        "err was: {rb_err}"
    );
}

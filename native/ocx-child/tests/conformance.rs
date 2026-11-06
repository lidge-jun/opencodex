#![deny(unsafe_op_in_unsafe_fn)]

use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

use ocx_child::codex_settings::{
    HomeCodexSettings, codex_settings_digest, codex_settings_digest_payload,
    parse_home_codex_settings_document,
};
use ocx_child::http_wire::{
    BodyFraming, FramingError, stream_upstream_to_chunked_client,
    validate_and_sanitize_request_headers,
};
use ocx_child::journal::{DetachError, DetachOutcome, apply_attach_or_sync, offline_detach};
use ocx_child::parity::parse_link_child_parity_report;
use ocx_child::relay_auth::{
    compute_connection_proof, compute_relay_proof, relay_proof_matches, token_fingerprint_hex,
};
use ocx_child::routes::{RelayAuthKind, RouteDecision, classify_child_ingress};
use ocx_child::state::ChildPaths;

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
            &paths,
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
            let detach_res = offline_detach(&paths, false).unwrap();
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
                &paths,
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

        match offline_detach(&paths, false) {
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

#[test]
fn conformance_multiline_placement_and_write_ahead_journal_crash_recovery() {
    let scratch = std::env::temp_dir().join(format!("ocx-child-wal-{}", std::process::id()));
    let _ = fs::remove_dir_all(&scratch);
    let ocx_home = scratch.join("opencodex");
    let codex_home = scratch.join("codex");
    fs::create_dir_all(&ocx_home).unwrap();
    fs::create_dir_all(&codex_home).unwrap();
    let paths = ChildPaths::new(ocx_home, codex_home);

    let pre_toml = "developer_instructions = \"\"\"\n[Important]\nNever inject inside me\n\"\"\"\n";
    fs::write(paths.codex_config_path(), pre_toml.as_bytes()).unwrap();

    let settings = HomeCodexSettings {
        fast_mode: Some(true),
        multi_agent_mode: Some("v1".to_owned()),
        web_search_sidecar_enabled: true,
        subagent_defaults: None,
    };
    let cat_v1 = b"{\"models\":[{\"slug\":\"m-v1\"}]}\n";
    apply_attach_or_sync(
        &paths,
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

    // 2. Simulate crash during a second sync right after write_journal (config & catalog still hold v1)
    let cat_v2 = b"{\"models\":[{\"slug\":\"m-v2\"}]}\n";
    let settings_v2 = HomeCodexSettings {
        fast_mode: Some(false),
        ..settings.clone()
    };
    apply_attach_or_sync(
        &paths,
        "lnk_0123456789abcdef",
        "link:t",
        10100,
        cat_v2,
        &settings_v2,
    )
    .unwrap();
    // Roll back config.toml and catalog.json on disk to v1 as if process crashed right after write_journal
    fs::write(paths.codex_config_path(), injected.as_bytes()).unwrap();
    fs::write(paths.codex_catalog_path(), cat_v1).unwrap();

    let outcome = offline_detach(&paths, false).unwrap();
    assert_eq!(outcome, DetachOutcome::ExactRestore);
    assert_eq!(
        fs::read_to_string(paths.codex_config_path()).unwrap(),
        pre_toml
    );
    assert!(!paths.codex_catalog_path().exists());
    let _ = fs::remove_dir_all(&scratch);
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
        &paths,
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
        &paths,
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
        offline_detach(&paths, false),
        Err(DetachError::Conflict(_))
    ));
    assert_eq!(fs::read(paths.codex_catalog_path()).unwrap(), user_cat);
    let _ = fs::remove_dir_all(&scratch);
}

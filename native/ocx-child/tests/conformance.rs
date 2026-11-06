#![deny(unsafe_op_in_unsafe_fn)]

use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

use ocx_child::codex_settings::{
    HomeCodexSettings, codex_settings_digest, codex_settings_digest_payload,
};
use ocx_child::http_wire::{FramingError, validate_and_sanitize_request_headers};
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

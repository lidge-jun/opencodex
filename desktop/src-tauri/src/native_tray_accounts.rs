use crate::native_tray_snapshot::{number, text};
use crate::proxy::AccountSwitchKind;
use serde_json::{json, Value};

pub struct Source {
    pub name: String,
    pub label: String,
    pub path: Option<String>,
    /// The route that switches this provider's active account, when it has one. Chosen here, from
    /// the host's own view of the config; the panel never names a route.
    pub switch: Option<AccountSwitchKind>,
}

pub fn sources(config: &Value) -> Option<Vec<Source>> {
    Some(
        config["providers"]
            .as_object()?
            .iter()
            .filter(|(_, row)| row["disabled"].as_bool() != Some(true))
            .map(|(name, row)| {
                let (path, switch) = if name == "openai" {
                    (
                        Some("/api/codex-auth/accounts".into()),
                        Some(AccountSwitchKind::Codex),
                    )
                } else if text(row, "authMode") == "oauth" {
                    (
                        Some(query("/api/oauth/accounts", "provider", name)),
                        Some(AccountSwitchKind::OAuth),
                    )
                } else if row["hasApiKey"].as_bool() == Some(true)
                    && text(row, "authMode") != "forward"
                {
                    (
                        Some(query("/api/providers/keys", "name", name)),
                        Some(AccountSwitchKind::ApiKey),
                    )
                } else {
                    (None, None)
                };
                let label = if !text(row, "label").is_empty() {
                    text(row, "label")
                } else {
                    match name.as_str() {
                        "openai" => "OpenAI (Codex login)",
                        "anthropic" => "Anthropic Claude",
                        "xai" => "xAI Grok",
                        "google" => "Google Gemini",
                        "google-antigravity" => "Google Antigravity",
                        _ => name,
                    }
                };
                Source {
                    name: name.clone(),
                    label: label.into(),
                    path,
                    switch,
                }
            })
            .collect(),
    )
}

/// The management request that makes `account_id` the active account of `source`, or `None`
/// when the provider has no switch route. Bodies match the dashboard's own switch calls.
pub fn switch_request(source: &Source, account_id: &str) -> Option<(AccountSwitchKind, Value)> {
    let kind = source.switch?;
    let body = match kind {
        AccountSwitchKind::Codex => json!({ "accountId": account_id }),
        AccountSwitchKind::OAuth => json!({ "provider": source.name, "accountId": account_id }),
        AccountSwitchKind::ApiKey => json!({ "name": source.name, "id": account_id }),
    };
    Some((kind, body))
}

fn query(path: &str, key: &str, provider: &str) -> String {
    let mut url =
        reqwest::Url::parse(&format!("http://127.0.0.1{path}")).expect("constant loopback URL");
    url.query_pairs_mut()
        .append_pair(key, provider)
        .append_pair("quota", "1");
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}

fn mask_email(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@') else {
        return "•••".into();
    };
    let suffix = domain.rfind('.').map(|i| &domain[i..]).unwrap_or_default();
    format!(
        "{}•••@{}•••{suffix}",
        local.chars().next().unwrap_or('•'),
        domain.chars().next().unwrap_or('•')
    )
}

fn reset(value: &Value) -> Option<f64> {
    number(value)
        .filter(|n| *n > 0.0)
        .map(|n| if n >= 1e12 { n / 1000.0 } else { n })
        .filter(|n| *n < 253_402_300_800.0)
}

fn windows(quota: &Value, plan: &str) -> Vec<Value> {
    let monthly_only = matches!(plan.trim().to_lowercase().as_str(), "go" | "free");
    let mut rows = Vec::new();
    // A window is listed only when it reports something: a finite percentage (zero included) or
    // a valid reset time. Plans differ in which windows they have, so an absent 5-hour window is
    // not a 5-hour window with unknown usage; an account that reports nothing keeps the panel's
    // "No quota data" line instead of a row of dashes.
    let mut push = |id: &str, label: &str, percent: &Value, at: &Value| {
        let percent = number(percent);
        let at = reset(at);
        if percent.is_some() || at.is_some() {
            rows.push(json!({"id":format!("{id}:{}",rows.len()),"label":label,"percent":percent,"resetAt":at}));
        }
    };
    if !monthly_only {
        let short = quota
            .get("fiveHourPercent")
            .filter(|v| !v.is_null())
            .unwrap_or(&quota["shortPercent"]);
        let short_reset = quota
            .get("fiveHourResetAt")
            .filter(|v| !v.is_null())
            .unwrap_or(&quota["shortResetAt"]);
        push("short", "5-hour limit", short, short_reset);
        push(
            "weekly",
            "Weekly limit",
            &quota["weeklyPercent"],
            &quota["weeklyResetAt"],
        );
    }
    push(
        "monthly",
        "30-day limit",
        &quota["monthlyPercent"],
        &quota["monthlyResetAt"],
    );
    if !monthly_only {
        if let Some(custom) = quota["customWindows"].as_array() {
            for window in custom {
                if let Some(label) = window["label"].as_str() {
                    push(label, label, &window["percent"], &window["resetAt"]);
                }
            }
        }
    }
    rows
}

pub fn provider(source: &Source, body: Option<&Value>, unavailable: bool) -> Value {
    let parsed = body.and_then(parse_accounts);
    let malformed = body.is_some() && parsed.is_none();
    let accounts = parsed.unwrap_or_default();
    let mut row = json!({"id":source.name,"label":source.label,
        "unavailable":unavailable || malformed,"accounts":accounts,
        "switchable":source.switch.is_some()});
    // Optional: older panels ignore unknown keys, and a provider without a mark simply has none.
    if let Some(icon) = crate::provider_icons::icon(&source.name) {
        row["iconSvg"] = json!(icon.svg);
        row["iconPaint"] = json!(icon.paint);
    }
    row
}

fn parse_accounts(body: &Value) -> Option<Vec<Value>> {
    let rows = body
        .get("accounts")
        .or_else(|| body.get("keys"))?
        .as_array()?;
    let active = ["activeAccountId", "activeId", "activeCodexAccountId"]
        .iter()
        .find_map(|key| body[key].as_str());
    rows.iter().enumerate().map(|(index,row)| {
        let id = row["id"].as_str()?;
        let email = row["email"].as_str().map(mask_email);
        let label = [row["alias"].as_str(),row["label"].as_str(),email.as_deref(),row["logLabel"].as_str(),Some(id)]
            .into_iter().flatten().find(|v| !v.is_empty()).unwrap_or(id);
        let unavailable = row["quotaUnavailable"].as_bool()==Some(true)
            || text(row,"quotaMode")=="unsupported" || !row["quota"].is_object();
        let is_active = active.map_or(row["active"].as_bool()==Some(true),|selected|selected==id);
        let (switch_state, blocked_reason) = switch_state(row, is_active);
        Some(json!({"id":format!("{id}:{index}"),"accountId":id,"label":label,"email":email,"plan":row["plan"].as_str(),
            "active":is_active,
            "switchState":switch_state,"blockedReason":blocked_reason,
            "exhausted":!unavailable && exhausted(&row["quota"],text(row,"plan")),
            "unavailable":unavailable,
            "windows":if unavailable {vec![]} else {windows(&row["quota"],text(row,"plan"))}}))
    }).collect()
}

/// Mirrors what the server itself refuses or drains, and nothing more. The 98% hard lock exists
/// only on the main Codex account and is reported by the roster's `mainAccountHardLock`; a paused
/// account and a Codex account whose validation is pending (`health.reason`) are refused by the
/// switch route with 409. Everything else stays switchable, exhausted or not.
fn switch_state(row: &Value, active: bool) -> (&'static str, Option<&'static str>) {
    if active {
        ("active", None)
    } else if row["mainAccountHardLock"]["state"].as_str() == Some("blocked") {
        ("blocked", Some("mainHardLock"))
    } else if row["paused"].as_bool() == Some(true) {
        ("blocked", Some("paused"))
    } else if row["health"]["reason"].as_str() == Some("validation_pending") {
        ("blocked", Some("validationPending"))
    } else {
        ("available", None)
    }
}

/// Same windows as `isCodexQuotaExhausted` (src/codex/quota.ts): a reading at 100% in any window
/// the plan is governed by, plus the burst window on every plan.
fn exhausted(quota: &Value, plan: &str) -> bool {
    let monthly_only = matches!(plan.trim().to_lowercase().as_str(), "go" | "free");
    let short = quota
        .get("fiveHourPercent")
        .filter(|v| !v.is_null())
        .unwrap_or(&quota["shortPercent"]);
    let windows: &[&Value] = if monthly_only {
        &[&quota["monthlyPercent"], short]
    } else {
        &[&quota["weeklyPercent"], &quota["monthlyPercent"], short]
    };
    windows
        .iter()
        .any(|value| number(value).is_some_and(|percent| percent >= 100.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_routes_are_encoded_and_never_forward_credentials() {
        let rows = sources(&json!({"providers":{
            "off":{"disabled":true},"oauth&x":{"authMode":"oauth","apiKey":"secret"},
            "forward":{"hasApiKey":true,"authMode":"forward"},"openai":{}}}))
        .unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows
            .iter()
            .find(|s| s.name == "oauth&x")
            .unwrap()
            .path
            .as_ref()
            .unwrap()
            .contains("provider=oauth%26x"));
        assert!(rows
            .iter()
            .find(|s| s.name == "forward")
            .unwrap()
            .path
            .is_none());
    }
    #[test]
    fn account_projection_masks_email_preserves_selection_and_deduplicates_windows() {
        let rows=parse_accounts(&json!({"activeId":"a","keys":[{"id":"a","email":"example@example.com","key":"secret",
            "quota":{"shortPercent":12,"shortResetAt":1900000000000_u64,"customWindows":[{"label":"same","percent":1},{"label":"same","percent":2}]}}]})).unwrap();
        assert_eq!(rows[0]["label"], "e•••@e•••.com");
        assert_eq!(rows[0]["active"], true);
        assert!(!rows[0].to_string().contains("secret"));
        assert_eq!(rows[0]["windows"][0]["resetAt"], 1900000000.0);
        assert_ne!(rows[0]["windows"][1]["id"], rows[0]["windows"][2]["id"]);
    }
    #[test]
    fn monthly_plans_and_unavailable_quota_do_not_reuse_short_windows() {
        let rows = parse_accounts(&json!({"accounts":[
            {"id":"a","plan":" Go ","quota":{"fiveHourPercent":99,"monthlyPercent":0}},
            {"id":"b","quotaUnavailable":true,"quota":{"weeklyPercent":50}}]}))
        .unwrap();
        assert_eq!(rows[0]["windows"].as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["windows"][0]["percent"], 0.0);
        assert!(rows[1]["windows"].as_array().unwrap().is_empty());
        assert!(parse_accounts(&json!({"accounts":[{"quota":{}}]})).is_none());
    }
    #[test]
    fn only_windows_that_report_data_are_listed() {
        let labels = |quota: Value| -> Vec<String> {
            windows(&quota, "pro")
                .iter()
                .map(|w| w["label"].as_str().unwrap().to_owned())
                .collect()
        };
        // Weekly-only plan: no 5-hour row at all, with or without an explicit null.
        assert_eq!(
            labels(json!({"weeklyPercent":49,"weeklyResetAt":1900000000})),
            ["Weekly limit"]
        );
        assert_eq!(
            labels(json!({"fiveHourPercent":null,"fiveHourResetAt":null,"weeklyPercent":1})),
            ["Weekly limit"]
        );
        // Zero is a measurement and a reset time alone still identifies a live window.
        assert_eq!(
            labels(json!({"fiveHourPercent":0,"weeklyPercent":0})),
            ["5-hour limit", "Weekly limit"]
        );
        assert_eq!(
            labels(json!({"shortResetAt":1900000000,"weeklyPercent":3})),
            ["5-hour limit", "Weekly limit"]
        );
        // Nothing reported means no rows; the view shows its "No quota data" line.
        assert!(labels(json!({})).is_empty());
        assert!(labels(json!({"fiveHourPercent":"n/a","weeklyPercent":-1})).is_empty());
    }
    #[test]
    fn providers_carry_their_mark_when_one_exists() {
        let source = |name: &str| Source {
            name: name.into(),
            label: name.into(),
            path: None,
            switch: None,
        };
        let openai = provider(&source("openai"), None, false);
        assert!(openai["iconSvg"].as_str().unwrap().contains("<svg"));
        assert_eq!(openai["iconPaint"], "image");
        assert_eq!(provider(&source("xai"), None, false)["iconPaint"], "mask");
        let custom = provider(&source("my-endpoint"), None, false);
        assert!(custom.get("iconSvg").is_none() && custom.get("iconPaint").is_none());
    }
    #[test]
    fn rows_carry_the_raw_id_and_mirror_only_the_server_switch_rules() {
        let rows = parse_accounts(&json!({"activeAccountId":"pool-a","accounts":[
            {"id":"__main__","quota":{"weeklyPercent":98.5},
             "mainAccountHardLock":{"enabled":true,"state":"blocked"}},
            {"id":"pool-a","quota":{"weeklyPercent":10}},
            {"id":"pool-b","quota":{"weeklyPercent":99}},
            {"id":"pool-c","paused":true,"quota":{"weeklyPercent":1}},
            {"id":"pool-d","plan":"pro","quota":{"fiveHourPercent":100,"weeklyPercent":20}},
            {"id":"pool-e","plan":"free","quota":{"weeklyPercent":100,"monthlyPercent":40}},
            {"id":"pool-f","quota":{"weeklyPercent":3},
             "health":{"status":"warning","reason":"validation_pending"}}]}))
        .unwrap();
        let state = |i: usize| {
            (
                rows[i]["accountId"].as_str().unwrap(),
                rows[i]["switchState"].as_str().unwrap(),
                rows[i]["blockedReason"].as_str(),
                rows[i]["exhausted"].as_bool().unwrap(),
            )
        };
        // Only the main account carries the 98% lock; the display id keeps its index suffix.
        assert_eq!(rows[0]["id"], "__main__:0");
        assert_eq!(
            state(0),
            ("__main__", "blocked", Some("mainHardLock"), false)
        );
        assert_eq!(state(1), ("pool-a", "active", None, false));
        // A pool account at 99% is not locked; nothing but 100% marks it exhausted.
        assert_eq!(state(2), ("pool-b", "available", None, false));
        assert_eq!(state(3), ("pool-c", "blocked", Some("paused"), false));
        // The burst window counts on every plan; a monthly-only plan ignores its weekly reading.
        assert_eq!(state(4), ("pool-d", "available", None, true));
        assert_eq!(state(5), ("pool-e", "available", None, false));
        // The switch route answers 409 while validation is pending, so the panel does not offer it.
        assert_eq!(
            state(6),
            ("pool-f", "blocked", Some("validationPending"), false)
        );
        // A main account whose lock is off or ready stays switchable.
        let ready = parse_accounts(&json!({"accounts":[{"id":"__main__","quota":{},
            "mainAccountHardLock":{"enabled":true,"state":"ready"}}]}))
        .unwrap();
        assert_eq!(ready[0]["switchState"], "available");
    }
    #[test]
    fn the_host_picks_the_switch_route_and_body_from_its_own_sources() {
        let rows = sources(&json!({"providers":{
            "openai":{},"anthropic":{"authMode":"oauth"},"xai":{"hasApiKey":true},
            "forward":{"hasApiKey":true,"authMode":"forward"}}}))
        .unwrap();
        let find = |name: &str| rows.iter().find(|row| row.name == name).unwrap();
        assert_eq!(
            switch_request(find("openai"), "pool-a"),
            Some((AccountSwitchKind::Codex, json!({"accountId":"pool-a"})))
        );
        assert_eq!(
            switch_request(find("anthropic"), "acct"),
            Some((
                AccountSwitchKind::OAuth,
                json!({"provider":"anthropic","accountId":"acct"})
            ))
        );
        assert_eq!(
            switch_request(find("xai"), "key-1"),
            Some((
                AccountSwitchKind::ApiKey,
                json!({"name":"xai","id":"key-1"})
            ))
        );
        assert_eq!(switch_request(find("forward"), "x"), None);
        assert_eq!(provider(find("forward"), None, false)["switchable"], false);
        assert_eq!(provider(find("xai"), None, false)["switchable"], true);
    }
}

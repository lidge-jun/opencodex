use crate::native_tray_snapshot::{number, text};
use serde_json::{json, Value};

pub struct Source {
    pub name: String,
    pub label: String,
    pub path: Option<String>,
}

pub fn sources(config: &Value) -> Option<Vec<Source>> {
    Some(
        config["providers"]
            .as_object()?
            .iter()
            .filter(|(_, row)| row["disabled"].as_bool() != Some(true))
            .map(|(name, row)| {
                let path = if name == "openai" {
                    Some("/api/codex-auth/accounts".into())
                } else if text(row, "authMode") == "oauth" {
                    Some(query("/api/oauth/accounts", "provider", name))
                } else if row["hasApiKey"].as_bool() == Some(true)
                    && text(row, "authMode") != "forward"
                {
                    Some(query("/api/providers/keys", "name", name))
                } else {
                    None
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
                }
            })
            .collect(),
    )
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
    let mut push = |id: &str, label: &str, percent: &Value, at: &Value, keep_unknown: bool| {
        let percent = number(percent);
        let at = reset(at);
        if keep_unknown || percent.is_some() || at.is_some() {
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
        push(
            "short",
            "5-hour limit",
            short,
            short_reset,
            quota.get("monthlyPercent").is_none(),
        );
        push(
            "weekly",
            "Weekly limit",
            &quota["weeklyPercent"],
            &quota["weeklyResetAt"],
            false,
        );
    }
    push(
        "monthly",
        "30-day limit",
        &quota["monthlyPercent"],
        &quota["monthlyResetAt"],
        false,
    );
    if !monthly_only {
        if let Some(custom) = quota["customWindows"].as_array() {
            for window in custom {
                if let Some(label) = window["label"].as_str() {
                    push(label, label, &window["percent"], &window["resetAt"], false);
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
    json!({"id":source.name,"label":source.label,
        "unavailable":unavailable || malformed,"accounts":accounts})
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
        Some(json!({"id":format!("{id}:{index}"),"label":label,"email":email,"plan":row["plan"].as_str(),
            "active":active.map_or(row["active"].as_bool()==Some(true),|selected|selected==id),
            "unavailable":unavailable,
            "windows":if unavailable {vec![]} else {windows(&row["quota"],text(row,"plan"))}}))
    }).collect()
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
}

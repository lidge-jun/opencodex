//! Shared request encoding and compatibility projection for companion timelines.
use crate::companion_usage::{has_filters, selected, text};
use serde_json::Value;
use std::collections::BTreeSet;

pub fn timeline_query(settings: &Value) -> String {
    let settings = settings.get("settings").unwrap_or(settings);
    let mut url =
        reqwest::Url::parse("http://127.0.0.1/api/usage/timeline").expect("constant loopback URL");
    {
        let mut query = url.query_pairs_mut();
        for (query_key, key, fallback) in [
            ("hours", "chartHours", "24"),
            ("bucketMinutes", "bucketMinutes", "60"),
            ("metric", "tokenMetric", "total"),
            ("aggregation", "aggregation", "sum"),
            ("grouping", "chartGrouping", "model"),
        ] {
            let value = settings[key]
                .as_str()
                .map(str::to_owned)
                .or_else(|| settings[key].as_i64().map(|value| value.to_string()))
                .unwrap_or_else(|| fallback.into());
            query.append_pair(query_key, &value);
        }
        if let Some(models) = settings["models"]
            .as_array()
            .filter(|rows| !rows.is_empty())
        {
            query.append_pair(
                "models",
                &models
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        if let Some(providers) = settings["hiddenProviders"].as_array() {
            for provider in providers.iter().filter_map(Value::as_str) {
                query.append_pair("hiddenProvider", provider);
            }
        }
    }
    url.query().unwrap_or_default().into()
}

fn canonical(value: &Value) -> Option<BTreeSet<&str>> {
    let rows = value.as_array()?;
    if rows.len() > 100 {
        return None;
    }
    rows.iter().map(Value::as_str).collect()
}

pub fn timeline_rows<'a>(body: &'a Value, settings: &Value) -> Option<(Vec<&'a Value>, bool)> {
    let settings = settings.get("settings").unwrap_or(settings);
    let rows = body["series"].as_array()?;
    let incomplete = body["truncated"].as_bool() == Some(true)
        || body["missingMeasurements"]
            .as_f64()
            .is_some_and(|n| n > 0.0);
    if settings["models"]
        .as_array()
        .is_some_and(|rows| rows.is_empty())
    {
        return Some((vec![], incomplete));
    }
    let active = has_filters(settings);
    let echo = &body["appliedFilters"];
    let hidden = settings
        .get("hiddenProviders")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let matches = echo.is_object()
        && echo.get("models").is_some()
        && canonical(&echo["hiddenProviders"]).is_some()
        && canonical(&echo["hiddenProviders"]) == canonical(&hidden)
        && (if settings["models"].is_null() {
            echo["models"].is_null()
        } else {
            canonical(&echo["models"]).is_some()
                && canonical(&echo["models"]) == canonical(&settings["models"])
        });
    let visible = rows
        .iter()
        .filter(|row| {
            if text(row, "id") == "other" && text(row, "provider").is_empty() {
                return !active || matches;
            }
            selected(settings, row)
        })
        .collect();
    Some((
        visible,
        incomplete || ((active || !echo.is_null()) && !matches),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn query_encodes_nested_models_and_repeated_provider_exclusions() {
        let query = timeline_query(
            &json!({"models":["p/vendor/model+one"],"hiddenProviders":["a+b","hidden"]}),
        );
        let url = reqwest::Url::parse(&format!("http://127.0.0.1/?{query}")).unwrap();
        let pairs: Vec<_> = url.query_pairs().collect();
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "models" && value == "p/vendor/model+one"));
        assert_eq!(
            pairs
                .iter()
                .filter(|(key, _)| key == "hiddenProvider")
                .count(),
            2
        );
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "hiddenProvider" && value == "a+b"));
    }
    #[test]
    fn a_matching_echo_preserves_folded_rows_and_older_responses_stay_incomplete() {
        let mut body = json!({"series":[{"id":"visible/m","provider":"visible","model":"m"},
            {"id":"hidden/m","provider":"hidden","model":"m"},{"id":"other","provider":"","model":"other"}]});
        let settings = json!({"models":null,"hiddenProviders":["hidden"]});
        assert_eq!(timeline_rows(&body, &settings).unwrap().0.len(), 1);
        assert!(timeline_rows(&body, &settings).unwrap().1);
        body["appliedFilters"] = settings.clone();
        assert_eq!(timeline_rows(&body, &settings).unwrap().0.len(), 2);
        assert!(!timeline_rows(&body, &settings).unwrap().1);
        let models = json!({"models":["visible/m"],"hiddenProviders":[]});
        body["appliedFilters"] = models.clone();
        assert_eq!(timeline_rows(&body, &models).unwrap().0.len(), 2);
        assert_eq!(
            timeline_rows(&body, &json!({"models":[]})).unwrap().0.len(),
            0
        );
        body.as_object_mut().unwrap().remove("appliedFilters");
        let all = timeline_rows(&body, &json!({})).unwrap();
        assert_eq!(all.0.len(), 3);
        assert!(!all.1);
    }
}

//! Platform-neutral companion usage filtering; no application, transport or credential owner.
use serde_json::{json, Map, Value};

pub fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}

pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

pub fn hidden(settings: &Value, provider: &str) -> bool {
    settings["hiddenProviders"]
        .as_array()
        .is_some_and(|rows| rows.iter().any(|row| row.as_str() == Some(provider)))
}

pub fn selected(settings: &Value, row: &Value) -> bool {
    let provider = text(row, "provider");
    let model = text(row, "model");
    !hidden(settings, provider)
        && settings["models"].as_array().map_or(true, |models| {
            models.iter().any(|item| {
                item.as_str()
                    .is_some_and(|item| item == model || item == format!("{provider}/{model}"))
            })
        })
}

const TOTAL_KEYS: [&str; 9] = [
    "requests",
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheReadInputTokens",
    "estimatedCostUsd",
    "measuredRequests",
    "pricedRequests",
];

pub fn usage(body: &Value, settings: &Value) -> Option<(Value, Vec<Value>)> {
    let source = body["summary"].as_object()?;
    if body.get("error").is_some() {
        return None;
    }
    if body.get("models").is_some_and(|value| !value.is_array()) {
        return None;
    }
    let filtering = has_filters(settings);
    let empty_selection = settings["models"]
        .as_array()
        .is_some_and(|rows| rows.is_empty());
    let all = match body["models"].as_array() {
        _ if empty_selection => &[],
        Some(rows) => rows.as_slice(),
        None if !filtering => &[],
        None => return None,
    };
    if filtering
        && all.iter().any(|row| {
            text(row, "provider").is_empty()
                || text(row, "model").is_empty()
                || (text(row, "provider") == "other" && text(row, "model") == "other")
        })
    {
        return None;
    }
    let rows: Vec<_> = all.iter().filter(|row| selected(settings, row)).collect();
    let mut totals = Map::new();
    for key in TOTAL_KEYS {
        let value = if filtering {
            if rows.is_empty() {
                None
            } else {
                rows.iter()
                    .map(|row| number(&row[key]))
                    .collect::<Option<Vec<_>>>()
                    .map(|values| values.iter().sum())
            }
        } else {
            source.get(key).and_then(number)
        };
        totals.insert(key.into(), json!(value));
    }
    // Both spellings exist on management projections; prefer the exact cache-read field.
    if !totals["cacheReadInputTokens"].is_null() {
        totals.insert(
            "cachedInputTokens".into(),
            totals["cacheReadInputTokens"].clone(),
        );
    }
    if number(&body["summary"]["coverageRatio"]) == Some(0.0) && !filtering {
        totals.insert("measuredRequests".into(), json!(0));
    }
    totals.remove("cacheReadInputTokens");
    totals.insert(
        "incomplete".into(),
        json!(["usageIncomplete", "historyTruncated", "entriesTruncated"]
            .iter()
            .any(|key| body[key].as_bool() == Some(true))),
    );
    let models = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let unmeasured = number(&row["requests"]).is_some_and(|n| n > 0.0)
                && (number(&row["measuredRequests"]) == Some(0.0)
                    || number(&row["coverageRatio"]) == Some(0.0));
            json!({"id":format!("{}/{}/{}",text(row,"provider"),text(row,"model"),index),
            "label":text(row,"model"),"requests":number(&row["requests"]),
            "tokens":if unmeasured { None } else { number(&row["totalTokens"]) }})
        })
        .collect();
    Some((Value::Object(totals), models))
}

pub fn has_filters(settings: &Value) -> bool {
    settings["models"].is_array()
        || settings["hiddenProviders"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
}

pub fn filtered_summary(body: &Value, settings: &Value) -> Option<Value> {
    let settings = settings.get("settings").unwrap_or(settings);
    if body.get("error").is_some() {
        return None;
    }
    if has_filters(settings) {
        return usage(body, settings).map(|(summary, _)| summary);
    }
    let summary = body.get("summary").unwrap_or(body);
    summary.as_object().map(|_| summary.clone())
}

pub fn integer(value: &Value) -> Option<i64> {
    value.as_i64().filter(|n| *n >= 0).or_else(|| {
        number(value)
            .filter(|n| n.fract() == 0.0 && *n < 9_223_372_036_854_775_808.0)
            .map(|n| n as i64)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_accept_whole_json_doubles_without_truncation_or_overflow() {
        for value in [json!(0), json!(2), json!(2.0)] {
            assert!(integer(&value).is_some());
        }
        for value in [
            json!(-1),
            json!(2.5),
            json!(9_223_372_036_854_775_808_u64),
            json!("2"),
            Value::Null,
        ] {
            assert_eq!(integer(&value), None);
        }
        assert_eq!(integer(&json!(i64::MAX)), Some(i64::MAX));
    }
    #[test]
    fn filtering_preserves_missingness_and_refuses_unrecoverable_folded_attribution() {
        let settings = json!({"models":null,"hiddenProviders":["hidden"]});
        let mut body = json!({"summary":{"requests":9,"totalTokens":99},"models":[
            {"provider":"hidden","model":"m","requests":7,"totalTokens":94},
            {"provider":"visible","model":"m","requests":2,"totalTokens":5,"estimatedCostUsd":0.25}
        ]});
        let filtered = filtered_summary(&body, &settings).unwrap();
        assert_eq!(integer(&filtered["requests"]), Some(2));
        assert_eq!(integer(&filtered["totalTokens"]), Some(5));
        assert_eq!(filtered["estimatedCostUsd"], json!(0.25));
        assert!(filtered["inputTokens"].is_null());
        body["models"]
            .as_array_mut()
            .unwrap()
            .push(json!({"provider":"other","model":"other","totalTokens":1}));
        assert!(filtered_summary(&body, &settings).is_none());
        assert!(filtered_summary(&json!({"summary":{"totalTokens":99}}), &settings).is_none());
        assert_eq!(
            filtered_summary(&json!({"summary":{"totalTokens":0}}), &json!({})),
            Some(json!({"totalTokens":0}))
        );
        assert!(usage(&json!({"summary":{"totalTokens":0}}), &json!({})).is_some());
    }
}

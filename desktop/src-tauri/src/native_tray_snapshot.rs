//! Native display settings and timeline projection.
pub use crate::companion_usage::{hidden, number, text, usage};
use serde_json::{json, Value};

pub fn display_settings(settings: Option<&Value>) -> Value {
    let enabled = |key| settings.is_some_and(|s| s[key].as_bool() == Some(true));
    json!({
        "showToday": enabled("showToday"), "show30Days": settings.is_some(),
        "showChart": enabled("showChart"), "showModels": enabled("showModels"),
        "showAccounts": settings.map_or(true, |s| s["showAccounts"].as_bool() != Some(false)),
        "showCost": enabled("showCost"),
        "chartStyle": settings.map(|s| text(s, "chartStyle")).unwrap_or("line")
    })
}

pub fn empty() -> Value {
    json!({"schemaVersion":1,"refreshing":true,"errors":[],"updatedAt":null,
        "settings":display_settings(None),"today":null,"month":null,"models":[],"chart":null,"providers":[]})
}

pub fn chart(body: &Value, settings: &Value) -> Option<Value> {
    let start = number(&body["start"])?;
    let bucket = number(&body["bucketSeconds"])?;
    if bucket == 0.0 || start >= 253_402_300_800.0 {
        return None;
    }
    let (rows, incomplete) = crate::companion_query::timeline_rows(body, settings)?;
    let series: Option<Vec<_>> = rows
        .into_iter()
        .enumerate()
        .map(|(index, row)| {
            let points: Option<Vec<_>> = row["points"].as_array()?.iter().map(number).collect();
            let label = row["id"].as_str()?;
            Some(json!({"id":format!("{}:{index}",text(row,"id")),"label":label,"points":points?}))
        })
        .collect();
    Some(
        json!({"start":start,"bucketSeconds":bucket,"series":series?,
        "incomplete":incomplete}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_filters_and_does_not_invent_measurements_or_copy_secrets() {
        let settings = json!({"models":["a/kept"],"hiddenProviders":[]});
        let body = json!({"apiKey":"do-not-copy", "summary":{"totalTokens":100},"models":[
            {"provider":"a","model":"kept","requests":2,"measuredRequests":0,"totalTokens":0,"apiKey":"hidden"},
            {"provider":"b","model":"dropped","requests":3,"totalTokens":100}]});
        let (totals, models) = usage(&body, &settings).unwrap();
        assert_eq!(totals["requests"], 2.0);
        assert!(totals["inputTokens"].is_null());
        assert!(models[0]["tokens"].is_null());
        assert_eq!(models.len(), 1);
        assert!(!json!([totals, models]).to_string().contains("apiKey"));
    }
    #[test]
    fn no_matches_and_malformed_reports_remain_unknown() {
        let settings = json!({"models":[],"hiddenProviders":[]});
        let (totals, models) =
            usage(&json!({"summary":{"requests":4},"models":[]}), &settings).unwrap();
        assert!(totals["requests"].is_null());
        assert!(models.is_empty());
        assert!(usage(&json!({"summary":{},"models":"bad"}), &settings).is_none());
    }
    #[test]
    fn cache_alias_and_incomplete_chart_are_preserved() {
        let settings = json!({"models":null,"hiddenProviders":[]});
        let (totals,_)=usage(&json!({"summary":{"cacheReadInputTokens":9,"cachedInputTokens":2},"models":[],"historyTruncated":true}),&settings).unwrap();
        assert_eq!(totals["cachedInputTokens"], 9.0);
        assert_eq!(totals["incomplete"], true);
        let c = chart(
            &json!({"start":1000,"bucketSeconds":60,"series":[],"missingMeasurements":1}),
            &settings,
        )
        .unwrap();
        assert_eq!(c["incomplete"], true);
        assert!(chart(
            &json!({"start":1000,"bucketSeconds":0,"series":[]}),
            &settings
        )
        .is_none());
    }

    #[test]
    fn same_model_from_two_providers_keeps_distinct_series_labels() {
        let settings = json!({"models":null,"hiddenProviders":[]});
        let value = chart(
            &json!({"start":1000,"bucketSeconds":60,"series":[
            {"id":"first/shared","provider":"first","model":"shared","points":[1,2]},
            {"id":"second/shared","provider":"second","model":"shared","points":[3,4]}]}),
            &settings,
        )
        .unwrap();
        assert_eq!(value["series"][0]["label"], "first/shared");
        assert_eq!(value["series"][1]["label"], "second/shared");
        assert_ne!(value["series"][0]["id"], value["series"][1]["id"]);
    }
}

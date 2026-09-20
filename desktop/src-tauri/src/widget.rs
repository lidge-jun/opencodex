#[cfg(target_os = "macos")]
mod macos {
    use crate::{
        proxy::{ProxyClient, ProxyError},
        tray,
    };
    use serde::Serialize;
    use serde_json::{json, Value};
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };
    use uuid::Uuid;

    #[derive(Debug, Serialize, serde::Deserialize, Clone, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Today {
        requests: Option<i64>,
        total_tokens: Option<i64>,
        estimated_cost_usd: Option<f64>,
    }

    #[derive(Debug, Serialize, serde::Deserialize, Clone, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Quota {
        provider_label: String,
        window_label: String,
        percent: Option<f64>,
        reset_at: Option<f64>,
    }

    #[derive(Debug, Serialize, serde::Deserialize, Clone, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Series {
        id: String,
        points: Vec<f64>,
    }

    #[derive(Debug, Serialize, serde::Deserialize, Clone, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Chart {
        start: f64,
        bucket_seconds: i64,
        style: String,
        series: Vec<Series>,
    }

    #[derive(Debug, Serialize, serde::Deserialize, Clone, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Snapshot {
        schema_version: i64,
        state: String,
        state_title: String,
        detail: Option<String>,
        endpoint_display: String,
        menu_title: Option<String>,
        today: Option<Today>,
        quotas: Vec<Quota>,
        chart: Option<Chart>,
        last_updated: Option<f64>,
        generated_at: f64,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ErrorKind {
        Unreachable,
        Unauthorized,
        Http,
        Decode,
    }

    fn state_for_error(
        kind: ErrorKind,
        detail: Option<String>,
    ) -> (&'static str, &'static str, Option<String>) {
        match kind {
            ErrorKind::Unreachable => (
                "unreachable",
                "Stopped",
                Some("The proxy is not running.".into()),
            ),
            ErrorKind::Unauthorized => (
                "unauthorized",
                "Needs API key",
                Some("This proxy requires an API key.".into()),
            ),
            ErrorKind::Http | ErrorKind::Decode => ("degraded", "Degraded", detail),
        }
    }

    fn proxy_error(error: &ProxyError) -> (ErrorKind, Option<String>) {
        match error {
            ProxyError::Unreachable => (ErrorKind::Unreachable, None),
            ProxyError::Unauthorized => (ErrorKind::Unauthorized, None),
            ProxyError::Http(status) => (ErrorKind::Http, Some(format!("HTTP {status}"))),
            ProxyError::Decode(error) => (ErrorKind::Decode, Some(error.to_string())),
        }
    }

    fn number(value: Option<&Value>) -> Option<f64> {
        value.and_then(Value::as_f64)
    }

    fn integer(value: Option<&Value>) -> Option<i64> {
        value.and_then(Value::as_i64)
    }

    fn reset_at(value: Option<&Value>) -> Option<f64> {
        let value = number(value)?;
        Some(if value >= 1_000_000_000_000.0 {
            value / 1000.0
        } else {
            value
        })
    }

    fn quotas(value: &Value) -> Vec<Quota> {
        let Some(reports) = value.get("reports").and_then(Value::as_array) else {
            return Vec::new();
        };
        let mut rows = Vec::new();
        for report in reports {
            let provider_label = report
                .get("label")
                .or_else(|| report.get("provider"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            let Some(quota) = report.get("quota") else {
                continue;
            };
            let mut push = |percent: Option<&Value>, window_label: &str, reset: Option<&Value>| {
                if percent.is_some() || reset.is_some() {
                    rows.push(Quota {
                        provider_label: provider_label.clone(),
                        window_label: window_label.to_owned(),
                        percent: number(percent),
                        reset_at: reset_at(reset),
                    });
                }
            };
            push(
                quota.get("fiveHourPercent"),
                "5h",
                quota.get("fiveHourResetAt"),
            );
            push(
                quota.get("weeklyPercent"),
                "week",
                quota.get("weeklyResetAt"),
            );
            push(
                quota.get("monthlyPercent"),
                "month",
                quota.get("monthlyResetAt"),
            );
            if let Some(windows) = quota.get("customWindows").and_then(Value::as_array) {
                for window in windows {
                    let label = window
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or("window");
                    push(window.get("percent"), label, window.get("resetAt"));
                }
            }
        }
        rows
    }

    fn chart(value: &Value, settings: &Value) -> Option<Chart> {
        let start = number(value.get("start"))?;
        let bucket_seconds = integer(value.get("bucketSeconds"))?;
        let settings = settings.get("settings").unwrap_or(settings);
        let style = settings
            .get("chartStyle")
            .and_then(Value::as_str)
            .unwrap_or("line")
            .to_owned();
        let series = value
            .get("series")
            .and_then(Value::as_array)?
            .iter()
            .take(6)
            .filter_map(|item| {
                Some(Series {
                    id: item.get("id")?.as_str()?.to_owned(),
                    points: item
                        .get("points")?
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_f64)
                        .collect(),
                })
            })
            .collect();
        Some(Chart {
            start,
            bucket_seconds,
            style,
            series,
        })
    }

    fn timeline_query(settings: &Value) -> String {
        let settings = settings.get("settings").unwrap_or(settings);
        let get = |key: &str, fallback: &str| {
            settings
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or(fallback)
                .to_owned()
        };
        let hours = settings
            .get("chartHours")
            .and_then(Value::as_i64)
            .unwrap_or(24);
        let bucket_minutes = settings
            .get("bucketMinutes")
            .and_then(Value::as_i64)
            .unwrap_or(60);
        let metric = get("tokenMetric", "total");
        let aggregation = get("aggregation", "sum");
        let grouping = get("chartGrouping", "model");
        let mut query = format!(
            "hours={hours}&bucketMinutes={bucket_minutes}&metric={metric}&aggregation={aggregation}&grouping={grouping}"
        );
        if let Some(models) = settings.get("models").and_then(Value::as_array) {
            let models = models
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(",");
            if !models.is_empty() {
                query.push_str("&models=");
                query.push_str(&models);
            }
        }
        query
    }

    fn snapshot_path() -> PathBuf {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join("Library/Containers/com.opencodex.desktop.widget/Data/Library/Application Support/OpenCodex/snapshot.json")
    }

    fn now_seconds() -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64()
    }

    fn without_generated_at(snapshot: &Snapshot) -> Snapshot {
        let mut snapshot = snapshot.clone();
        snapshot.generated_at = 0.0;
        snapshot
    }

    fn write_if_changed(
        path: &std::path::Path,
        previous: Option<&Snapshot>,
        snapshot: &Snapshot,
    ) -> std::io::Result<bool> {
        if previous.map(without_generated_at).as_ref() == Some(&without_generated_at(snapshot)) {
            return Ok(false);
        }
        let Some(directory) = path.parent() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "snapshot path has no parent",
            ));
        };
        fs::create_dir_all(directory)?;
        let bytes = serde_json::to_vec(snapshot).map_err(std::io::Error::other)?;
        let temporary = directory.join(format!(".snapshot-{}.tmp", Uuid::new_v4()));
        fs::write(&temporary, bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
        }
        fs::rename(temporary, path)?;
        Ok(true)
    }

    fn make_snapshot(
        proxy: &ProxyClient,
        settings: &Value,
        health: &Value,
        today: Option<&Value>,
        quota_value: Option<&Value>,
        timeline_value: Option<&Value>,
    ) -> Snapshot {
        let endpoint = proxy.endpoint();
        let detail = {
            let parts = [health.get("status"), health.get("protection")]
                .into_iter()
                .filter_map(|value| value.and_then(Value::as_str))
                .filter(|part| !part.is_empty() && *part != "none")
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join(" · "))
        };
        let today_snapshot = today
            .and_then(|value| value.get("summary").or(Some(value)))
            .map(|summary| Today {
                requests: integer(summary.get("requests")),
                total_tokens: integer(summary.get("totalTokens")),
                estimated_cost_usd: number(summary.get("estimatedCostUsd")),
            });
        let quotas_value = quota_value.unwrap_or(&Value::Null);
        let menu_title = tray::render_title(settings, today.unwrap_or(&Value::Null), quotas_value);
        let chart = timeline_value.and_then(|value| chart(value, settings));
        Snapshot {
            schema_version: 1,
            state: "running".into(),
            state_title: "Running".into(),
            detail,
            endpoint_display: format!("{}:{}", endpoint.host, endpoint.port),
            menu_title,
            today: today_snapshot,
            quotas: quotas(quotas_value),
            chart,
            last_updated: timeline_value.map(|_| now_seconds()),
            generated_at: now_seconds(),
        }
    }

    pub async fn write(proxy: ProxyClient) {
        let health = match proxy.startup_health().await {
            Ok(value) => value,
            Err(error) => {
                let (kind, detail) = proxy_error(&error);
                let (state, state_title, detail) = state_for_error(kind, detail);
                let snapshot = Snapshot {
                    schema_version: 1,
                    state: state.into(),
                    state_title: state_title.into(),
                    detail,
                    endpoint_display: format!(
                        "{}:{}",
                        proxy.endpoint().host,
                        proxy.endpoint().port
                    ),
                    menu_title: None,
                    today: None,
                    quotas: Vec::new(),
                    chart: None,
                    last_updated: None,
                    generated_at: now_seconds(),
                };
                let path = snapshot_path();
                let previous = fs::read(&path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Snapshot>(&bytes).ok());
                if let Err(error) = write_if_changed(&path, previous.as_ref(), &snapshot) {
                    crate::logging::log_once("widget snapshot write failed", &error.to_string());
                }
                crate::logging::log_once("widget snapshot health failed", state);
                return;
            }
        };
        let settings = proxy
            .companion_settings()
            .await
            .unwrap_or_else(|_| json!({ "settings": {} }));
        let today = proxy.usage_today().await.ok();
        let quota_value = proxy.quotas().await.ok();
        let timeline_value = proxy.timeline(&timeline_query(&settings)).await.ok();
        let snapshot = make_snapshot(
            &proxy,
            &settings,
            &health,
            today.as_ref(),
            quota_value.as_ref(),
            timeline_value.as_ref(),
        );
        let path = snapshot_path();
        let previous = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Snapshot>(&bytes).ok());
        if let Err(error) = write_if_changed(&path, previous.as_ref(), &snapshot) {
            crate::logging::log_once("widget snapshot write failed", &error.to_string());
        }
    }

    pub fn refresh(proxy: &ProxyClient) {
        let proxy = proxy.clone();
        tauri::async_runtime::spawn(async move { write(proxy).await });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn serialization_uses_swift_field_names() {
            let snapshot = Snapshot {
                schema_version: 1,
                state: "running".into(),
                state_title: "Running".into(),
                detail: Some("ok".into()),
                endpoint_display: "127.0.0.1:10100".into(),
                menu_title: Some("2K".into()),
                today: Some(Today {
                    requests: Some(2),
                    total_tokens: Some(1234),
                    estimated_cost_usd: Some(0.12),
                }),
                quotas: vec![Quota {
                    provider_label: "OpenAI".into(),
                    window_label: "week".into(),
                    percent: Some(10.0),
                    reset_at: Some(1.0),
                }],
                chart: Some(Chart {
                    start: 1.0,
                    bucket_seconds: 3600,
                    style: "line".into(),
                    series: vec![Series {
                        id: "openai/gpt".into(),
                        points: vec![1.0, 2.0],
                    }],
                }),
                last_updated: Some(2.0),
                generated_at: 3.0,
            };
            assert_eq!(
                serde_json::to_string(&snapshot).unwrap(),
                r#"{"schemaVersion":1,"state":"running","stateTitle":"Running","detail":"ok","endpointDisplay":"127.0.0.1:10100","menuTitle":"2K","today":{"requests":2,"totalTokens":1234,"estimatedCostUsd":0.12},"quotas":[{"providerLabel":"OpenAI","windowLabel":"week","percent":10.0,"resetAt":1.0}],"chart":{"start":1.0,"bucketSeconds":3600,"style":"line","series":[{"id":"openai/gpt","points":[1.0,2.0]}]},"lastUpdated":2.0,"generatedAt":3.0}"#
            );
        }

        #[test]
        fn error_state_mapping_covers_four_kinds() {
            assert_eq!(
                state_for_error(ErrorKind::Unreachable, None).0,
                "unreachable"
            );
            assert_eq!(
                state_for_error(ErrorKind::Unauthorized, None).0,
                "unauthorized"
            );
            assert_eq!(
                state_for_error(ErrorKind::Http, Some("HTTP 500".into())).0,
                "degraded"
            );
            assert_eq!(
                state_for_error(ErrorKind::Decode, Some("bad".into())).0,
                "degraded"
            );
        }

        #[test]
        fn write_if_changed_ignores_generated_at() {
            let path = std::env::temp_dir().join(format!("ocx-widget-{}.json", std::process::id()));
            let snapshot = Snapshot {
                schema_version: 1,
                state: "running".into(),
                state_title: "Running".into(),
                detail: None,
                endpoint_display: "127.0.0.1:10100".into(),
                menu_title: None,
                today: None,
                quotas: Vec::new(),
                chart: None,
                last_updated: None,
                generated_at: 1.0,
            };
            assert!(write_if_changed(&path, None, &snapshot).unwrap());
            let mut changed = snapshot.clone();
            changed.generated_at = 2.0;
            assert!(!write_if_changed(&path, Some(&snapshot), &changed).unwrap());
            let _ = fs::remove_file(path);
        }

        #[test]
        fn chart_series_are_truncated_to_six() {
            let series = (0..8)
                .map(|index| json!({ "id": index.to_string(), "points": [1] }))
                .collect::<Vec<_>>();
            let value = json!({ "start": 1, "bucketSeconds": 60, "series": series });
            let result = chart(&value, &json!({ "settings": { "chartStyle": "line" } })).unwrap();
            assert_eq!(result.series.len(), 6);
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::refresh;

#[cfg(not(target_os = "macos"))]
pub(crate) fn refresh(_: &crate::proxy::ProxyClient) {}

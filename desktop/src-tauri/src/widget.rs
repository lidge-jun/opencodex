#[cfg(target_os = "macos")]
mod macos {
    use crate::companion_query::{timeline_query, timeline_rows};
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
        #[serde(default, skip_serializing_if = "is_false")]
        incomplete: bool,
    }

    fn is_false(value: &bool) -> bool {
        !value
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
        /// The port answered, but as something other than the runtime this shell is bound to.
        Foreign,
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
            // A runtime this app did not start is a different event from a fault, so it does not
            // borrow the vocabulary of one. "degraded" would claim the proxy is misbehaving and
            // "unreachable" would claim nothing is there; a user who started the runtime from npm
            // or the CLI themselves would read either as a defect in a setup that is working.
            // The widget has no red for this: `tone` in `app/Sources/OpenCodexWidget/Views.swift`
            // maps a state it does not know to the neutral secondary colour, which is the right
            // signal for "serving, just not ours".
            ErrorKind::Foreign => (
                "foreign",
                "External runtime",
                Some("This port is served by a runtime this app did not start.".into()),
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
            ProxyError::Foreign => (ErrorKind::Foreign, None),
        }
    }

    fn number(value: Option<&Value>) -> Option<f64> {
        value.and_then(Value::as_f64)
    }

    fn integer(value: Option<&Value>) -> Option<i64> {
        value.and_then(crate::companion_usage::integer)
    }

    fn reset_at(value: Option<&Value>) -> Option<f64> {
        let value = number(value)?;
        Some(if value >= 1_000_000_000_000.0 {
            value / 1000.0
        } else {
            value
        })
    }

    fn quotas(value: &Value, settings: &Value) -> Vec<Quota> {
        let Some(reports) = value.get("reports").and_then(Value::as_array) else {
            return Vec::new();
        };
        let mut rows = Vec::new();
        for report in reports {
            if crate::companion_usage::hidden(
                settings.get("settings").unwrap_or(settings),
                crate::companion_usage::text(report, "provider"),
            ) {
                continue;
            }
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
                // JSON null (or any non-number) is an absent window, not a row of dashes: a
                // weekly-only plan reports `fiveHourPercent: null` and must show weekly only.
                let percent = number(percent).filter(|value| value.is_finite() && *value >= 0.0);
                // Same bounds as the native panel's `reset`: after the millisecond conversion,
                // a time past year 9999 is not a reset the widget can show.
                let reset =
                    reset_at(reset).filter(|value| *value > 0.0 && *value < 253_402_300_800.0);
                if percent.is_some() || reset.is_some() {
                    rows.push(Quota {
                        provider_label: provider_label.clone(),
                        window_label: window_label.to_owned(),
                        percent,
                        reset_at: reset,
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
        let (rows, incomplete) = timeline_rows(value, settings)?;
        let series = rows
            .into_iter()
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
            incomplete,
        })
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

    /// What the widget displays apart from its age caption. `last_updated` moves on every
    /// successful poll; reloading for it alone would spend WidgetKit's budget every five minutes
    /// while the widget already renders that age as a self-updating relative date.
    fn displayed(snapshot: &Snapshot) -> Snapshot {
        let mut snapshot = without_generated_at(snapshot);
        snapshot.last_updated = None;
        snapshot
    }

    /// Rewrite an unchanged snapshot after this long, so the widget can still tell a live app from
    /// one that stopped writing. The widget marks a snapshot stale after two heartbeats
    /// (`WidgetSnapshot.staleAfter` in app/Sources/MenuBarCore/WidgetSnapshot.swift).
    const HEARTBEAT_SECONDS: f64 = 15.0 * 60.0;

    /// Whether `snapshot` should replace `previous` on disk. The heartbeat is measured from the
    /// file's own `generated_at`, so a restarted app decides the same way as a running one.
    /// Writing spends no WidgetKit budget, so the file always carries the latest poll time.
    fn should_write(previous: Option<&Snapshot>, snapshot: &Snapshot) -> bool {
        let Some(previous) = previous else {
            return true;
        };
        without_generated_at(previous) != without_generated_at(snapshot)
            || snapshot.generated_at - previous.generated_at >= HEARTBEAT_SECONDS
    }

    /// Minimum spacing between reload requests: at most 72 a day, inside the 40-70 Apple quotes
    /// as a typical budget once the widget's own 30-minute fallback timeline is counted separately.
    /// A change that lands inside the window is already on disk, and that fallback rereads it.
    const RELOAD_INTERVAL_SECONDS: f64 = 20.0 * 60.0;

    /// Whether a snapshot that was just written should ask WidgetKit for a reload: only when what
    /// the widget displays changed, and not sooner than `RELOAD_INTERVAL_SECONDS` after the last
    /// request. Timestamp-only writes and heartbeats never reload.
    fn should_reload(
        previous: Option<&Snapshot>,
        snapshot: &Snapshot,
        last_reload: Option<f64>,
        now: f64,
    ) -> bool {
        previous.map_or(true, |previous| displayed(previous) != displayed(snapshot))
            && last_reload.map_or(true, |last| now - last >= RELOAD_INTERVAL_SECONDS)
    }

    static LAST_RELOAD: std::sync::Mutex<Option<f64>> = std::sync::Mutex::new(None);

    fn write_if_changed(
        path: &std::path::Path,
        previous: Option<&Snapshot>,
        snapshot: &Snapshot,
    ) -> std::io::Result<bool> {
        if !should_write(previous, snapshot) {
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

    extern "C" {
        fn ocx_widget_reload_timelines();
    }

    /// Persist the snapshot and, when it was actually written, ask WidgetKit to reload the widget.
    fn publish(snapshot: &Snapshot) {
        let path = snapshot_path();
        let previous = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Snapshot>(&bytes).ok());
        match write_if_changed(&path, previous.as_ref(), snapshot) {
            Ok(true) => {
                let now = now_seconds();
                let mut last = LAST_RELOAD
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                if should_reload(previous.as_ref(), snapshot, *last, now) {
                    *last = Some(now);
                    // SAFETY: a no-argument Swift export that only enqueues work on the main queue.
                    unsafe { ocx_widget_reload_timelines() };
                }
            }
            Ok(false) => {}
            Err(error) => {
                crate::logging::log_once("widget snapshot write failed", &error.to_string())
            }
        }
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
            .and_then(|value| crate::companion_usage::filtered_summary(value, settings))
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
            quotas: quotas(quotas_value, settings),
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
                publish(&snapshot);
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
        publish(&snapshot);
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
                    incomplete: false,
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
        fn error_state_mapping_covers_every_kind() {
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
            assert_eq!(state_for_error(ErrorKind::Foreign, None).0, "foreign");
        }

        #[test]
        fn a_foreign_runtime_is_not_reported_as_a_failure() {
            // The mapping is the whole point of the variant. Folding it into either neighbour
            // tells a user whose own CLI or npm runtime holds the port that something is broken,
            // and the widget is the one surface where that claim is read without any context.
            assert_eq!(proxy_error(&ProxyError::Foreign).0, ErrorKind::Foreign);
            let (state, title, detail) = state_for_error(ErrorKind::Foreign, None);
            assert_eq!(state, "foreign");
            assert_eq!(title, "External runtime");
            assert!(detail.unwrap().contains("did not start"));
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
        fn polls_are_written_but_only_visible_changes_reload_and_not_too_often() {
            let previous = Snapshot {
                schema_version: 1,
                state: "running".into(),
                state_title: "Running".into(),
                detail: None,
                endpoint_display: "127.0.0.1:10100".into(),
                menu_title: Some("12".into()),
                today: None,
                quotas: Vec::new(),
                chart: None,
                last_updated: Some(1_000.0),
                generated_at: 1_000.0,
            };
            assert!(should_write(None, &previous), "first write");
            assert!(
                should_reload(None, &previous, None, 1_000.0),
                "first write reloads"
            );
            // Same content and poll time: nothing to write before the heartbeat.
            let mut idle = previous.clone();
            idle.generated_at = 1_300.0;
            assert!(!should_write(Some(&previous), &idle));
            idle.generated_at = previous.generated_at + HEARTBEAT_SECONDS;
            assert!(should_write(Some(&previous), &idle), "heartbeat rewrites");
            assert!(
                !should_reload(Some(&previous), &idle, None, idle.generated_at),
                "heartbeat never reloads"
            );
            // A new poll time is written so the file's "Updated" is current, but costs no reload.
            let mut polled = previous.clone();
            polled.generated_at = 1_300.0;
            polled.last_updated = Some(1_300.0);
            assert!(should_write(Some(&previous), &polled));
            assert!(!should_reload(Some(&previous), &polled, None, 1_300.0));
            // A visible change reloads, but not within the interval of the previous request.
            let mut counted = polled.clone();
            counted.menu_title = Some("13".into());
            assert!(should_write(Some(&previous), &counted));
            assert!(should_reload(Some(&previous), &counted, None, 1_300.0));
            assert!(!should_reload(
                Some(&previous),
                &counted,
                Some(1_300.0 - 60.0),
                1_300.0
            ));
            assert!(should_reload(
                Some(&previous),
                &counted,
                Some(1_300.0 - RELOAD_INTERVAL_SECONDS),
                1_300.0
            ));
        }

        #[test]
        fn a_failed_write_reports_an_error_instead_of_a_write() {
            // The parent is a file, so the directory cannot be created: `publish` must see an
            // error here and never reach the reload call.
            let blocker =
                std::env::temp_dir().join(format!("ocx-widget-blocker-{}", std::process::id()));
            fs::write(&blocker, b"x").unwrap();
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
            assert!(write_if_changed(&blocker.join("snapshot.json"), None, &snapshot).is_err());
            let _ = fs::remove_file(blocker);
        }

        #[test]
        fn quota_rows_skip_windows_the_plan_does_not_report() {
            let reports = json!({ "reports": [
                { "provider": "openai", "label": "OpenAI", "quota": {
                    "fiveHourPercent": null, "fiveHourResetAt": null,
                    "weeklyPercent": 49.0, "weeklyResetAt": 1_900_000_000 } },
                { "provider": "kimi", "label": "Kimi", "quota": {
                    "fiveHourPercent": 0, "weeklyPercent": 35 } },
                // A reset-only window whose time is out of range is not a window either.
                { "provider": "far", "label": "Far", "quota": { "weeklyResetAt": 1e20 } }
            ] });
            let rows = quotas(&reports, &json!({ "settings": {} }));
            let windows: Vec<_> = rows
                .iter()
                .map(|row| (row.provider_label.as_str(), row.window_label.as_str()))
                .collect();
            assert_eq!(
                windows,
                [("OpenAI", "week"), ("Kimi", "5h"), ("Kimi", "week")]
            );
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

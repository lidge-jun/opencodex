//! Independent, bounded reads; a failed section cannot discard another section's result.
use crate::companion_query::timeline_query;
use crate::{
    native_tray_accounts as accounts, native_tray_snapshot as snapshot, proxy::ProxyClient,
};
use serde_json::{json, Value};
use std::{
    future::Future,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{task::JoinSet, time::Instant};

const READ_BUDGET: Duration = Duration::from_secs(8);
const ACCOUNT_BUDGET: Duration = Duration::from_secs(12);

struct Section {
    key: &'static str,
    value: Option<Value>,
    models: Option<Vec<Value>>,
    error: &'static str,
}

async fn bounded<F: Future>(future: F, budget: Duration) -> Option<F::Output> {
    tokio::time::timeout(budget, future).await.ok()
}

fn merge(result: &mut Value, section: Section) {
    if let Some(value) = section.value {
        result[section.key] = value;
        if let Some(models) = section.models {
            result["models"] = json!(models);
        }
        result["updatedAt"] = json!(SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64());
    } else {
        result[section.key] = if section.key == "providers" {
            json!([])
        } else {
            Value::Null
        };
        if section.key == "today" {
            result["models"] = json!([]);
        }
        result["errors"]
            .as_array_mut()
            .expect("snapshot error array")
            .push(json!(section.error));
    }
}

pub async fn load(
    proxy: &ProxyClient,
    mut result: Value,
    publish: impl Fn(Value) + Send + Sync,
) -> Value {
    result["refreshing"] = json!(true);
    result["errors"] = json!([]);
    let settings = bounded(proxy.companion_settings(), READ_BUDGET)
        .await
        .and_then(Result::ok)
        .and_then(|v| {
            let s = &v["settings"];
            (s.is_object()
                && s["hiddenProviders"].is_array()
                && (s["models"].is_null() || s["models"].is_array()))
            .then(|| s.clone())
        });
    result["settings"] = snapshot::display_settings(settings.as_ref());
    let mut tasks = JoinSet::new();
    if let Some(settings) = &settings {
        for (range, key, error) in [
            ("today", "today", "Today's usage is unavailable."),
            ("30d", "month", "30-day usage is unavailable."),
        ] {
            let proxy = proxy.clone();
            let settings = settings.clone();
            tasks.spawn(async move {
                let projected =
                    bounded(proxy.get(&format!("/api/usage?range={range}")), READ_BUDGET)
                        .await
                        .and_then(Result::ok)
                        .and_then(|body| snapshot::usage(&body, &settings));
                match projected {
                    Some((totals, models)) => Section {
                        key,
                        value: Some(totals),
                        models: (key == "today").then_some(models),
                        error,
                    },
                    None => Section {
                        key,
                        value: None,
                        models: None,
                        error,
                    },
                }
            });
        }
        if settings["showChart"].as_bool() == Some(true) {
            let proxy = proxy.clone();
            let settings = settings.clone();
            tasks.spawn(async move {
                let value = bounded(proxy.timeline(&timeline_query(&settings)), READ_BUDGET)
                    .await
                    .and_then(Result::ok)
                    .and_then(|body| snapshot::chart(&body, &settings));
                Section {
                    key: "chart",
                    value,
                    models: None,
                    error: "Usage chart is unavailable.",
                }
            });
        }
    } else {
        result["errors"] = json!(["Display settings are unavailable."]);
    }
    if result["settings"]["showAccounts"].as_bool() == Some(true) {
        let proxy = proxy.clone();
        let settings = settings.clone();
        tasks.spawn(async move {
            let sources = bounded(proxy.get("/api/config"), READ_BUDGET)
                .await
                .and_then(Result::ok)
                .and_then(|v| accounts::sources(&v));
            let value = if let Some(sources) = sources {
                let selected = sources
                    .into_iter()
                    .filter(|source| {
                        settings
                            .as_ref()
                            .map_or(true, |s| !snapshot::hidden(s, &source.name))
                    })
                    .collect();
                Some(json!(load_providers(&proxy, selected).await))
            } else {
                None
            };
            Section {
                key: "providers",
                value,
                models: None,
                error: "Account limits are unavailable.",
            }
        });
    }
    publish(result.clone());
    while let Some(section) = tasks.join_next().await {
        match section {
            Ok(section) => merge(&mut result, section),
            Err(_) => result["errors"]
                .as_array_mut()
                .expect("snapshot error array")
                .push(json!("A usage section could not be loaded.")),
        }
        publish(result.clone());
    }
    result["refreshing"] = json!(false);
    result
}

async fn load_providers(proxy: &ProxyClient, sources: Vec<accounts::Source>) -> Vec<Value> {
    // Preserve successful rows at the deadline; untouched rows already say unavailable.
    let mut rows: Vec<_> = sources
        .iter()
        .map(|s| accounts::provider(s, None, s.path.is_some()))
        .collect();
    let mut pending = sources.into_iter().enumerate();
    let mut tasks = JoinSet::new();
    let deadline = Instant::now() + ACCOUNT_BUDGET;
    loop {
        while tasks.len() < 4 {
            let Some((index, source)) = pending.next() else {
                break;
            };
            let proxy = proxy.clone();
            tasks.spawn(async move {
                let Some(path) = &source.path else {
                    return (index, accounts::provider(&source, None, false));
                };
                let mut body = bounded(proxy.get(path), READ_BUDGET)
                    .await
                    .and_then(Result::ok);
                if source.name == "openai" {
                    if let (Some(body), Some(Ok(active))) = (
                        body.as_mut().and_then(Value::as_object_mut),
                        bounded(proxy.get("/api/codex-auth/active"), READ_BUDGET).await,
                    ) {
                        body.insert(
                            "activeCodexAccountId".into(),
                            json!(active["activeCodexAccountId"]
                                .as_str()
                                .unwrap_or("__main__")),
                        );
                    }
                }
                (
                    index,
                    accounts::provider(&source, body.as_ref(), body.is_none()),
                )
            });
        }
        match tokio::time::timeout_at(deadline, tasks.join_next()).await {
            Ok(Some(Ok((index, row)))) => rows[index] = row,
            Ok(Some(Err(_))) => {}
            Ok(None) | Err(_) => break,
        }
    }
    // Dropping JoinSet aborts in-flight requests, including when the root task is cancelled.
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timeline_query_uses_canonical_settings_and_escapes_model_names() {
        let query = timeline_query(
            &json!({"chartHours":24,"bucketMinutes":60,"tokenMetric":"input","aggregation":"max","chartGrouping":"modelAccount","models":["provider/model&x"]}),
        );
        assert!(query.contains("metric=input"));
        assert!(query.contains("aggregation=max"));
        assert!(query.contains("models=provider%2Fmodel%26x"));
    }
    #[test]
    fn successful_usage_survives_a_stalled_quota_section() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut result = snapshot::empty();
            merge(
                &mut result,
                Section {
                    key: "today",
                    value: Some(json!({"totalTokens":321})),
                    models: Some(vec![]),
                    error: "Usage failed",
                },
            );
            let value = bounded(std::future::pending::<Value>(), Duration::ZERO).await;
            merge(
                &mut result,
                Section {
                    key: "providers",
                    value,
                    models: None,
                    error: "Account limits are unavailable.",
                },
            );
            assert_eq!(result["today"]["totalTokens"], 321);
            assert_eq!(result["errors"], json!(["Account limits are unavailable."]));
            assert!(result["updatedAt"].as_f64().is_some());
        });
    }

    #[test]
    fn real_collector_publishes_usage_before_a_nonresponsive_account_endpoint() {
        use crate::{auth::Auth, endpoint::ProxyEndpoint};
        use std::{
            io::{Read, Write},
            net::{TcpListener, TcpStream},
            sync::{Arc, Condvar, Mutex},
            thread,
        };
        struct Fixture {
            port: u16,
            stop: Arc<(Mutex<bool>, Condvar)>,
            worker: Option<thread::JoinHandle<()>>,
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                *self.stop.0.lock().unwrap() = true;
                self.stop.1.notify_all();
                let _ = TcpStream::connect(("127.0.0.1", self.port));
                if let Some(worker) = self.worker.take() {
                    worker.join().unwrap();
                }
            }
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let stopped = stop.clone();
        let worker = thread::spawn(move || {
            let mut requests = Vec::new();
            for connection in listener.incoming() {
                if *stopped.0.lock().unwrap() {
                    break;
                }
                let mut stream = connection.unwrap();
                let stop = stopped.clone();
                requests.push(thread::spawn(move || {
                    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    let mut bytes = [0; 4096]; let count = stream.read(&mut bytes).unwrap();
                    let request = String::from_utf8_lossy(&bytes[..count]);
                    let path = request.split_whitespace().nth(1).unwrap_or("");
                    if path.starts_with("/api/oauth/accounts") {
                        let _guard = stop.1.wait_while(stop.0.lock().unwrap(), |stop| !*stop).unwrap();
                        return;
                    }
                    let body = if path == "/api/companion/settings" {
                        json!({"settings":{"showToday":true,"showChart":false,"showModels":true,"showAccounts":true,"showCost":true,"chartStyle":"line","models":null,"hiddenProviders":[]}})
                    } else if path == "/api/config" {
                        json!({"providers":{"test-oauth":{"authMode":"oauth"}}})
                    } else {
                        json!({"summary":{"requests":1,"measuredRequests":1,"totalTokens":321},"models":[]})
                    }.to_string();
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                    let _ = stream.write_all(response.as_bytes());
                }));
            }
            for request in requests {
                request.join().unwrap();
            }
        });
        let _fixture = Fixture {
            port,
            stop,
            worker: Some(worker),
        };
        let proxy = ProxyClient::new(
            ProxyEndpoint {
                host: "127.0.0.1",
                port,
            },
            Auth::new(std::env::temp_dir().join("native-tray-no-credentials")),
        )
        .unwrap();
        let snapshots = Mutex::new(Vec::new());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(load(&proxy, snapshot::empty(), |value| {
            snapshots.lock().unwrap().push(value)
        }));
        assert_eq!(result["today"]["totalTokens"], 321.0);
        assert_eq!(result["providers"][0]["unavailable"], true);
        assert_eq!(result["refreshing"], false);
        assert!(snapshots
            .lock()
            .unwrap()
            .iter()
            .any(|value: &Value| value["today"]["totalTokens"] == 321.0
                && value["refreshing"] == true
                && value["providers"].as_array().unwrap().is_empty()));
    }
}

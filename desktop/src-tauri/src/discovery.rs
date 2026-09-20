use serde::Deserialize;
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 10100;
const HOME_ENV: &str = "OPENCODEX_HOME";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProxyEndpoint {
    pub host: &'static str,
    pub port: u16,
}

impl ProxyEndpoint {
    pub fn url(&self, path: &str) -> String {
        format!("http://{}:{}{}", self.host, self.port, path)
    }
}

#[derive(Debug, Deserialize)]
struct RuntimePort {
    port: u16,
}

pub fn config_directory(environment: impl Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    environment(HOME_ENV)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(|value| expand_tilde(PathBuf::from(value), home))
        .unwrap_or_else(|| home.join(".opencodex"))
}

pub fn resolve(environment: impl Fn(&str) -> Option<String>, home: &Path) -> ProxyEndpoint {
    let directory = config_directory(environment, home);
    let path = directory.join("runtime-port.json");
    let port = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RuntimePort>(&bytes).ok())
        .map(|record| record.port)
        .filter(|port| (1..=u16::MAX).contains(port))
        .unwrap_or(DEFAULT_PORT);
    ProxyEndpoint {
        host: "127.0.0.1",
        port,
    }
}

fn expand_tilde(path: PathBuf, home: &Path) -> PathBuf {
    if path == Path::new("~") {
        return home.to_path_buf();
    }
    path.strip_prefix("~/")
        .map(|rest| home.join(rest))
        .unwrap_or(path)
}

pub fn current() -> (ProxyEndpoint, PathBuf) {
    let home = dirs_home();
    let directory = config_directory(|key| std::env::var(key).ok(), &home);
    let endpoint = resolve(|key| std::env::var(key).ok(), &home);
    (endpoint, directory)
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};

    #[test]
    fn resolves_home_override_and_runtime_port() {
        let root = std::env::temp_dir().join(format!("ocx-discovery-{}", std::process::id()));
        let home = root.join("home");
        let custom = home.join("custom");
        create_dir_all(&custom).unwrap();
        write(
            custom.join("runtime-port.json"),
            r#"{"pid":1,"port":12345}"#,
        )
        .unwrap();
        let endpoint = resolve(|key| (key == HOME_ENV).then(|| "~/custom".into()), &home);
        assert_eq!(
            endpoint,
            ProxyEndpoint {
                host: "127.0.0.1",
                port: 12345
            }
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn any_failure_falls_back_to_default() {
        let home = std::env::temp_dir().join("ocx-missing-home");
        let endpoint = resolve(|_| None, &home);
        assert_eq!(endpoint.port, DEFAULT_PORT);
    }

    #[test]
    fn empty_override_and_invalid_port_use_default() {
        let root =
            std::env::temp_dir().join(format!("ocx-discovery-invalid-{}", std::process::id()));
        let home = root.join("home");
        let directory = root.join("custom");
        create_dir_all(&directory).unwrap();
        write(directory.join("runtime-port.json"), r#"{"port":0}"#).unwrap();
        let endpoint = resolve(|key| (key == HOME_ENV).then(|| " ".into()), &home);
        assert_eq!(endpoint.port, DEFAULT_PORT);
        let _ = std::fs::remove_dir_all(root);
    }
}

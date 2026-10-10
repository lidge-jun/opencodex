#![cfg_attr(windows, windows_subsystem = "windows")]
//! Credential-free portable Codex fixture for the Bun module contracts.
use serde_json::json;
use std::{
    env, fs,
    io::{self, Write},
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let home = PathBuf::from(env::var_os("OPENCODEX_HOME").ok_or("fixture home missing")?);
    let args: Vec<_> = env::args().skip(1).collect();
    let version = args == ["--version"];
    if !version && args != ["debug", "models", "--bundled"] {
        return Err("unsupported fixture command".into());
    }
    let mode = fs::read_to_string(home.join("arm")).unwrap_or_default();
    let mut log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("fake-events.jsonl"))?;
    let epoch = || {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    };
    // Append each event as one serialized buffer; concurrent probes must not interleave fields.
    log.write_all(format!("{}\n", json!({"event":"start","at_ms":epoch(),"pid":std::process::id(),"role":0,"version":version,"armed":!mode.is_empty()})).as_bytes())?;
    if version {
        if mode == "version-gated" {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !home.join("version-release").exists() && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        println!("codex-cli 0.160.0");
    } else {
        if mode == "catalog-delay" {
            std::thread::sleep(Duration::from_millis(500));
        }
        if mode == "catalog-invalid" {
            println!("synthetic invalid catalog");
            return Ok(());
        }
        let instructions = if mode == "catalog-large" {
            "synthetic".repeat(262144)
        } else {
            "synthetic".into()
        };
        println!(
            "{}",
            json!({"models":[{"slug":"gpt-5.5","display_name":"fixture","base_instructions":instructions,
            "context_window":128000,"supported_reasoning_levels":[{"effort":"medium","description":"fixture"}],"default_reasoning_level":"medium"}]})
        );
    }
    io::stdout().flush()?;
    log.write_all(format!("{}\n", json!({"event":"end","at_ms":epoch(),"pid":std::process::id(),"role":0,"version":version})).as_bytes())?;
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1)
    }
}

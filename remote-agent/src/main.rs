mod assertion;
mod config;
mod control;
mod proxy;
mod relay;
mod supervisor;

use std::{path::PathBuf, process::Command as ProcessCommand};

use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use clap::{Parser, Subcommand};
use ed25519_dalek::SigningKey;
use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;

use config::{AgentConfig, save_secret};

#[derive(Parser)]
#[command(
    name = "opencodex-remote-agent",
    version,
    about = "Private OpenCodex Remote tunnel agent"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Pair {
        #[arg(long)]
        control_plane: String,
        #[arg(long)]
        code: String,
        #[arg(long, default_value = "/var/lib/opencodex-remote/agent.json")]
        config: PathBuf,
        #[arg(long, default_value = "/var/lib/opencodex-remote/tunnel-token")]
        tunnel_token_file: PathBuf,
    },
    Run {
        #[arg(long, default_value = "/var/lib/opencodex-remote/agent.json")]
        config: PathBuf,
    },
    /// Run the unprivileged, outbound-only relay used by `ocx gui` Remote.
    Relay {
        #[arg(long, default_value_os_t = relay::default_remote_state_path())]
        state: PathBuf,
    },
    PrepareNetwork {
        #[arg(long, default_value = "/var/lib/opencodex-remote/agent.json")]
        config: PathBuf,
    },
    PrintOpencodexConfig {
        #[arg(long, default_value = "/var/lib/opencodex-remote/agent.json")]
        config: PathBuf,
    },
}

fn initialize_logs() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .without_time()
        .with_target(false)
        .init();
}

#[tokio::main]
async fn main() -> Result<()> {
    initialize_logs();
    match Cli::parse().command {
        Command::Pair {
            control_plane,
            code,
            config,
            tunnel_token_file,
        } => {
            let key = SigningKey::from_bytes(&rand::random::<[u8; 32]>());
            let paired = control::pair(&control_plane, &code.trim().to_uppercase(), &key).await?;
            let private_origin_ip = paired
                .private_origin_ip
                .parse()
                .context("parse private origin IP")?;
            save_secret(&tunnel_token_file, &paired.tunnel_token)?;
            AgentConfig {
                control_plane_url: control_plane,
                agent_id: paired.agent_id,
                instance_id: paired.instance_id,
                signing_key: URL_SAFE_NO_PAD.encode(key.to_bytes()),
                tunnel_token_file,
                gateway: paired.gateway,
                private_origin_ip,
                opencodex_url: "http://127.0.0.1:10100".into(),
                ingress: format!("{private_origin_ip}:10101"),
            }
            .save(&config)?;
            println!(
                "Paired successfully. Run `opencodex-remote-agent prepare-network`, then start the Agent and merge the `print-opencodex-config` remoteAccess block into OpenCodex config."
            );
        }
        Command::PrintOpencodexConfig { config } => {
            let config = AgentConfig::load(&config)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "remoteAccess": {
                        "enabled": true,
                        "instanceId": config.instance_id,
                        "issuer": config.gateway.issuer,
                        "publicKeys": config.gateway.keys,
                    }
                }))?
            );
        }
        Command::PrepareNetwork { config } => {
            let config = AgentConfig::load(&config)?;
            let address = format!("{}/32", config.private_origin_ip);
            let status = ProcessCommand::new("ip")
                .args(["address", "replace", &address, "dev", "lo"])
                .status()
                .context("run ip address replace for private origin")?;
            if !status.success() {
                anyhow::bail!(
                    "failed to assign private origin IP to loopback; run prepare-network as root"
                );
            }
            println!("Private origin {address} is ready on loopback.");
        }
        Command::Run { config } => {
            let config = AgentConfig::load(&config)?;
            let shutdown = CancellationToken::new();
            let signal = shutdown.clone();
            tokio::spawn(async move {
                let _ = tokio::signal::ctrl_c().await;
                signal.cancel();
            });
            let proxy = tokio::spawn(proxy::serve(config.clone(), shutdown.clone()));
            let heartbeat = tokio::spawn(control::heartbeat_loop(config.clone(), shutdown.clone()));
            let tunnel = tokio::spawn(supervisor::supervise_cloudflared(
                config.tunnel_token_file.clone(),
                shutdown.clone(),
            ));
            tokio::select! {
                result = proxy => result.context("proxy task failed")??,
                result = heartbeat => result.context("heartbeat task failed")??,
                result = tunnel => result.context("cloudflared supervisor failed")??,
            }
            shutdown.cancel();
        }
        Command::Relay { state } => {
            let shutdown = CancellationToken::new();
            let signal = shutdown.clone();
            tokio::spawn(async move {
                let _ = tokio::signal::ctrl_c().await;
                signal.cancel();
            });
            relay::run(state, shutdown).await?;
        }
    }
    Ok(())
}

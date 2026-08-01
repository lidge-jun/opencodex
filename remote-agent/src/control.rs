use std::time::Duration;

use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use rand::Rng;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::config::{AgentConfig, GatewayConfig};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest<'a> {
    code: &'a str,
    public_key: String,
    version: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub agent_id: String,
    pub instance_id: String,
    pub tunnel_token: String,
    pub private_origin_ip: String,
    pub gateway: GatewayConfig,
}

#[derive(Deserialize)]
struct ChallengeResponse {
    challenge: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    token: String,
}

pub fn public_key_der(signing_key: &SigningKey) -> Vec<u8> {
    const ED25519_SPKI_PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    [
        ED25519_SPKI_PREFIX.as_slice(),
        signing_key.verifying_key().as_bytes(),
    ]
    .concat()
}

pub async fn pair(
    control_plane_url: &str,
    code: &str,
    signing_key: &SigningKey,
) -> Result<PairResponse> {
    let response = Client::new()
        .post(format!(
            "{}/agent/pair",
            control_plane_url.trim_end_matches('/')
        ))
        .json(&PairRequest {
            code,
            public_key: URL_SAFE_NO_PAD.encode(public_key_der(signing_key)),
            version: env!("CARGO_PKG_VERSION"),
        })
        .send()
        .await
        .context("pairing request failed")?;
    if !response.status().is_success() {
        anyhow::bail!(
            "pairing rejected: {}",
            response.text().await.unwrap_or_default()
        );
    }
    response.json().await.context("parse pairing response")
}

async fn agent_token(client: &Client, config: &AgentConfig, key: &SigningKey) -> Result<String> {
    let client_nonce = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>());
    let challenge: ChallengeResponse = client
        .post(format!(
            "{}/agent/challenge",
            config.control_plane_url.trim_end_matches('/')
        ))
        .json(&serde_json::json!({ "agentId": config.agent_id, "clientNonce": client_nonce }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let signature = key.sign(challenge.challenge.as_bytes());
    let token: TokenResponse = client
        .post(format!(
            "{}/agent/token",
            config.control_plane_url.trim_end_matches('/')
        ))
        .json(&serde_json::json!({
            "agentId": config.agent_id,
            "challenge": challenge.challenge,
            "signature": URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(token.token)
}

pub async fn heartbeat_loop(config: AgentConfig, shutdown: CancellationToken) -> Result<()> {
    let client = Client::builder().timeout(Duration::from_secs(15)).build()?;
    let key = config.signing_key()?;
    loop {
        if shutdown.is_cancelled() {
            return Ok(());
        }
        let healthy = client
            .get(format!(
                "{}/healthz",
                config.opencodex_url.trim_end_matches('/')
            ))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false);
        match agent_token(&client, &config, &key).await {
            Ok(token) => {
                let result = client
                    .post(format!("{}/agent/heartbeat", config.control_plane_url.trim_end_matches('/')))
                    .bearer_auth(token)
                    .json(&serde_json::json!({ "opencodexHealthy": healthy, "version": env!("CARGO_PKG_VERSION") }))
                    .send().await;
                if let Err(error) = result {
                    tracing::warn!(%error, "heartbeat failed");
                }
            }
            Err(error) => tracing::warn!(%error, "agent authentication failed"),
        }
        let jitter = rand::rng().random_range(-5_i64..=5);
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = tokio::time::sleep(Duration::from_secs((30 + jitter) as u64)) => {}
        }
    }
}

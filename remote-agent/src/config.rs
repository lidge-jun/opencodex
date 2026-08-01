use std::{
    fs,
    net::Ipv4Addr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayKey {
    pub kid: String,
    pub public_key_pem: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConfig {
    pub issuer: String,
    pub keys: Vec<GatewayKey>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub control_plane_url: String,
    pub agent_id: String,
    pub instance_id: String,
    pub signing_key: String,
    pub tunnel_token_file: PathBuf,
    pub gateway: GatewayConfig,
    pub private_origin_ip: Ipv4Addr,
    #[serde(default = "default_opencodex_url")]
    pub opencodex_url: String,
    #[serde(default = "default_ingress")]
    pub ingress: String,
}

fn default_opencodex_url() -> String {
    "http://127.0.0.1:10100".into()
}
fn default_ingress() -> String {
    "127.0.0.1:10101".into()
}

impl AgentConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
        let config: Self = serde_json::from_slice(&bytes).context("parse agent config")?;
        config.signing_key()?;
        config.validate_private_origin_ip()?;
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(self)?)?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
        fs::rename(&temporary, path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(())
    }

    pub fn signing_key(&self) -> Result<SigningKey> {
        let bytes = URL_SAFE_NO_PAD
            .decode(&self.signing_key)
            .context("decode signing key")?;
        let seed: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("signing key must contain 32 bytes"))?;
        Ok(SigningKey::from_bytes(&seed))
    }

    pub fn validate_private_origin_ip(&self) -> Result<()> {
        let octets = self.private_origin_ip.octets();
        if octets[0] != 10 || octets[1] < 192 {
            anyhow::bail!("private origin IP must be in 10.192.0.0/10");
        }
        if self.ingress != format!("{}:10101", self.private_origin_ip) {
            anyhow::bail!("ingress must match the assigned private origin IP on port 10101");
        }
        Ok(())
    }
}

pub fn save_secret(path: &Path, value: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, format!("{value}\n"))?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    fs::rename(&temporary, path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(private_origin_ip: Ipv4Addr, ingress: &str) -> AgentConfig {
        AgentConfig {
            control_plane_url: "https://remote.example.test".into(),
            agent_id: "agent".into(),
            instance_id: "instance".into(),
            signing_key: URL_SAFE_NO_PAD.encode([0_u8; 32]),
            tunnel_token_file: "/tmp/tunnel-token".into(),
            gateway: GatewayConfig {
                issuer: "issuer".into(),
                keys: vec![],
            },
            private_origin_ip,
            opencodex_url: default_opencodex_url(),
            ingress: ingress.into(),
        }
    }

    #[test]
    fn private_origin_ip_must_be_reserved_and_match_ingress() {
        let allowed = Ipv4Addr::new(10, 223, 1, 9);
        assert!(
            config(allowed, "10.223.1.9:10101")
                .validate_private_origin_ip()
                .is_ok()
        );
        assert!(
            config(Ipv4Addr::new(10, 10, 1, 9), "10.10.1.9:10101")
                .validate_private_origin_ip()
                .is_err()
        );
        assert!(
            config(allowed, "127.0.0.1:10101")
                .validate_private_origin_ip()
                .is_err()
        );
    }
}

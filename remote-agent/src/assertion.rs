use std::{
    collections::HashMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use axum::http::{HeaderMap, Method, Uri};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey, pkcs8::DecodePublicKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;

use crate::config::AgentConfig;

pub const ASSERTION_HEADER: &str = "x-opencodex-remote-assertion";
const AUDIENCE: &str = "opencodex-management";
const MAX_ASSERTION_BYTES: usize = 8 * 1024;

#[derive(Deserialize)]
struct Header {
    alg: String,
    typ: String,
    kid: String,
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    aud: String,
    instance_id: String,
    user_id: String,
    method: String,
    path_sha256: String,
    iat: i64,
    exp: i64,
    jti: String,
}

#[derive(Clone)]
pub struct AssertionVerifier {
    instance_id: String,
    issuer: String,
    keys: Arc<HashMap<String, VerifyingKey>>,
    replay: Arc<Mutex<HashMap<String, i64>>>,
}

impl AssertionVerifier {
    pub fn new(config: &AgentConfig) -> Result<Self> {
        let mut keys = HashMap::new();
        for key in &config.gateway.keys {
            keys.insert(
                key.kid.clone(),
                VerifyingKey::from_public_key_pem(&key.public_key_pem)
                    .context("decode gateway public key")?,
            );
        }
        if keys.is_empty() {
            bail!("at least one gateway public key is required");
        }
        Ok(Self {
            instance_id: config.instance_id.clone(),
            issuer: config.gateway.issuer.clone(),
            keys: Arc::new(keys),
            replay: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn verify(&self, method: &Method, uri: &Uri, headers: &HeaderMap) -> Result<String> {
        let token = headers
            .get(ASSERTION_HEADER)
            .and_then(|value| value.to_str().ok())
            .context("remote assertion required")?;
        if token.len() > MAX_ASSERTION_BYTES {
            bail!("remote assertion is too large");
        }
        let segments: Vec<_> = token.split('.').collect();
        if segments.len() != 3 {
            bail!("invalid remote assertion");
        }
        let header: Header = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segments[0])?)?;
        let claims: Claims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segments[1])?)?;
        if header.alg != "EdDSA" || header.typ != "JWT" {
            bail!("unsupported assertion algorithm");
        }
        if claims.iss != self.issuer
            || claims.aud != AUDIENCE
            || claims.instance_id != self.instance_id
        {
            bail!("assertion scope mismatch");
        }
        if claims.user_id.is_empty()
            || claims.user_id.len() > 128
            || claims.jti.is_empty()
            || claims.jti.len() > 128
        {
            bail!("invalid assertion identity");
        }
        if claims.method != method.as_str() || claims.path_sha256 != normalized_path_hash(uri)? {
            bail!("assertion request binding mismatch");
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
        if claims.iat > now + 5
            || claims.exp < now - 5
            || claims.exp <= claims.iat
            || claims.exp - claims.iat > 30
        {
            bail!("assertion expired");
        }
        let key = self
            .keys
            .get(&header.kid)
            .context("unknown assertion key")?;
        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(segments[2])?)?;
        key.verify(
            format!("{}.{}", segments[0], segments[1]).as_bytes(),
            &signature,
        )
        .context("invalid assertion signature")?;
        let mut replay = self.replay.lock().await;
        replay.retain(|_, expiry| *expiry + 5 >= now);
        if replay.contains_key(&claims.jti) {
            bail!("assertion replayed");
        }
        if replay.len() >= 4096
            && let Some(oldest) = replay
                .iter()
                .min_by_key(|(_, expiry)| *expiry)
                .map(|(jti, _)| jti.clone())
        {
            replay.remove(&oldest);
        }
        replay.insert(claims.jti, claims.exp);
        Ok(claims.user_id)
    }
}

pub fn normalized_path_hash(uri: &Uri) -> Result<String> {
    let parsed = Url::parse(&format!(
        "http://opencodex.invalid{}",
        uri.path_and_query()
            .map(|value| value.as_str())
            .unwrap_or("/")
    ))?;
    let mut pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));
    let mut canonical = parsed.path().to_string();
    if !pairs.is_empty() {
        let query: String = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        canonical.push('?');
        canonical.push_str(&query);
    }
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_query_order_is_stable() {
        let first: Uri = "/api/config?z=2&a=hello+world".parse().unwrap();
        let second: Uri = "/api/config?a=hello%20world&z=2".parse().unwrap();
        assert_eq!(
            normalized_path_hash(&first).unwrap(),
            normalized_path_hash(&second).unwrap()
        );
    }
}

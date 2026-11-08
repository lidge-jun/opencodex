use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::platform::{
    constant_time_eq, hex_decode_lower, hex_encode, random_hex, sha256_hex, volatile_zero_bytes,
};

pub const LINK_RELAY_AUTH_PATH: &str = "/.well-known/opencodex/link-relay-auth";
pub const LINK_RELAY_SESSION_HEADER: &str = "x-opencodex-link-session";
pub const LINK_RELAY_PROBE_HEADER: &str = "x-opencodex-link-probe";
pub const LINK_RELAY_PROOF_HEADER: &str = "x-opencodex-link-proof";
pub const LINK_RELAY_CONNECTION_HEADER: &str = "x-opencodex-link-connection";
pub const LINK_RELAY_CONNECTION_PROOF_HEADER: &str = "x-opencodex-link-connection-proof";
pub const LINK_RELAY_AUTH_VERSION: &str = "2";

type HmacSha256 = Hmac<Sha256>;

pub fn compute_child_shutdown_proof(secret: &str, role: &str, binding: &str) -> Option<String> {
    if secret.len() != 48
        || !secret
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || (role != "caller" && role != "listener")
        || binding.len() != 128
        || !binding
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut key = hex_decode_lower(secret)?;
    let mac = HmacSha256::new_from_slice(&key);
    volatile_zero_bytes(&mut key);
    let mut mac = mac.ok()?;
    mac.update(b"opencodex-child-shutdown-v1\0");
    mac.update(role.as_bytes());
    mac.update(b"\0");
    mac.update(binding.as_bytes());
    Some(hex_encode(&mac.finalize().into_bytes()))
}

pub fn token_fingerprint_hex(raw_token: &str) -> String {
    sha256_hex(raw_token.as_bytes())
}

pub fn is_valid_link_id(link_id: &str) -> bool {
    link_id.len() == 20
        && link_id.starts_with("lnk_")
        && link_id[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn is_valid_key_id(key_id: &str) -> bool {
    let bytes = key_id.as_bytes();
    if bytes.is_empty() || bytes.len() > 256 {
        return false;
    }
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

pub fn is_valid_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn is_valid_connection_generation(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// Computes `linkRelayProof` using the 32 raw bytes decoded from `fingerprint_hex`.
pub fn compute_relay_proof(
    fingerprint_hex: &str,
    direction: &str,
    key_id: &str,
    link_id: &str,
    nonce: &str,
) -> Option<String> {
    if (direction != "caller" && direction != "listener")
        || !is_valid_hex64(fingerprint_hex)
        || !is_valid_key_id(key_id)
        || !is_valid_link_id(link_id)
        || !is_valid_hex64(nonce)
    {
        return None;
    }
    let key_bytes = hex_decode_lower(fingerprint_hex)?; // 32 raw bytes
    let mut mac = HmacSha256::new_from_slice(&key_bytes).ok()?;
    mac.update(b"opencodex-link-relay-v2\0");
    mac.update(direction.as_bytes());
    mac.update(b"\0");
    mac.update(key_id.as_bytes());
    mac.update(b"\0");
    mac.update(link_id.as_bytes());
    mac.update(b"\0");
    mac.update(nonce.as_bytes());
    Some(hex_encode(&mac.finalize().into_bytes()))
}

pub fn compute_connection_proof(
    fingerprint_hex: &str,
    key_id: &str,
    link_id: &str,
    nonce: &str,
    generation: &str,
) -> Option<String> {
    if !is_valid_connection_generation(generation) {
        return None;
    }
    let _ = compute_relay_proof(fingerprint_hex, "listener", key_id, link_id, nonce)?;
    let key_bytes = hex_decode_lower(fingerprint_hex)?;
    let mut mac = HmacSha256::new_from_slice(&key_bytes).ok()?;
    mac.update(b"opencodex-link-connection-v1\0");
    mac.update(key_id.as_bytes());
    mac.update(b"\0");
    mac.update(link_id.as_bytes());
    mac.update(b"\0");
    mac.update(nonce.as_bytes());
    mac.update(b"\0");
    mac.update(generation.as_bytes());
    Some(hex_encode(&mac.finalize().into_bytes()))
}

pub fn relay_proof_matches(actual: Option<&str>, expected: Option<&str>) -> bool {
    let (Some(a), Some(e)) = (actual, expected) else {
        return false;
    };
    if !is_valid_hex64(a) || !is_valid_hex64(e) {
        return false;
    }
    let (Some(ab), Some(eb)) = (hex_decode_lower(a), hex_decode_lower(e)) else {
        return false;
    };
    constant_time_eq(&ab, &eb)
}

pub struct RelayChallenge {
    pub nonce: String,
    pub caller_proof: String,
    pub expected_listener_proof: String,
}

pub fn create_relay_challenge(
    fingerprint_hex: &str,
    key_id: &str,
    link_id: &str,
) -> Result<RelayChallenge, String> {
    let nonce = random_hex(32)?;
    let caller_proof = compute_relay_proof(fingerprint_hex, "caller", key_id, link_id, &nonce)
        .ok_or_else(|| "invalid link relay identity".to_owned())?;
    let expected_listener_proof =
        compute_relay_proof(fingerprint_hex, "listener", key_id, link_id, &nonce)
            .ok_or_else(|| "invalid link relay identity".to_owned())?;
    Ok(RelayChallenge {
        nonce,
        caller_proof,
        expected_listener_proof,
    })
}

use crate::{
    auth::{Auth, RecordedRuntime},
    endpoint::ProxyEndpoint,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use reqwest::{redirect, Client, Method, RequestBuilder, StatusCode};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};
use tokio::time::{timeout_at, Instant};

const DESKTOP_SNAPSHOT_PATH: &str = "/api/update/desktop-snapshot";

/// Which instance answered, taken from the unauthenticated health body.
///
/// This is a discovery hint, not cryptographic proof of who holds the port. Management requests
/// carry a scoped capability keyed by the recorded runtime secret, never the reusable admin token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeIdentity {
    pub pid: u32,
    pub port: u16,
}

/// The instance this client is bound to, and the binding it was bound under.
///
/// The generation moves every time the shell binds to a runtime. A request authorised under an
/// earlier binding is not authorised under this one, which is what stops an in-flight management
/// call from landing on a runtime the shell rebound to in between.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeBinding {
    pub identity: RuntimeIdentity,
    pub generation: u64,
}

#[derive(Clone)]
pub struct ProxyClient {
    client: Client,
    endpoint: ProxyEndpoint,
    auth: Auth,
    binding: Arc<Mutex<Option<RuntimeBinding>>>,
    generations: Arc<Mutex<u64>>,
}

#[derive(Debug)]
pub enum ProxyError {
    Unreachable,
    Unauthorized,
    Http(StatusCode),
    Decode(reqwest::Error),
    /// The listener answered, but not as the instance this client is bound to — a foreign service
    /// on the port, or a different process than the one the shell confirmed.
    Foreign,
}

impl ProxyError {
    /// Whether nothing is listening on the endpoint at all.
    ///
    /// This is the only error that says anything about the process behind the port. A timeout, an
    /// unauthorized reply or a body that will not parse all mean the listener answered or might
    /// still be there, and a stop that reads any of them as "gone" reports a drain that did not
    /// happen.
    pub fn is_unreachable(&self) -> bool {
        matches!(self, Self::Unreachable)
    }
}

/// Read an identity out of a health body.
///
/// The marker is required: a 200 from something else on the port is not this proxy. The port is
/// required to be the one addressed, so a body describing a different listener cannot authorise a
/// credential for this one.
pub fn identity_from(body: &Value, addressed_port: u16) -> Option<RuntimeIdentity> {
    if body.get("service").and_then(Value::as_str) != Some("opencodex") {
        return None;
    }
    let pid = u32::try_from(body.get("pid").and_then(Value::as_u64)?).ok()?;
    let port = u16::try_from(body.get("port").and_then(Value::as_u64)?).ok()?;
    if port != addressed_port {
        return None;
    }
    Some(RuntimeIdentity { pid, port })
}

impl ProxyClient {
    pub fn new(endpoint: ProxyEndpoint, auth: Auth) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(4))
                .user_agent(Auth::user_agent())
                // The capability attached to these requests is for the loopback endpoint and
                // nowhere else. Two defaults would carry it off that endpoint, so both are turned
                // off here rather than re-checked anywhere in the request path.
                //
                // A redirect is the first: the pinned client does not treat this custom credential
                // header as sensitive, so it would follow the hop to wherever it pointed.
                .redirect(redirect::Policy::none())
                // System proxy resolution is the second: reqwest honours system proxy
                // configuration by default, which would route the credential through whatever
                // proxy the machine declares and put another process between the shell and its
                // own runtime.
                .no_proxy()
                .build()?,
            endpoint,
            auth,
            binding: Arc::new(Mutex::new(None)),
            generations: Arc::new(Mutex::new(0)),
        })
    }

    pub fn endpoint(&self) -> ProxyEndpoint {
        self.endpoint
    }

    fn slot<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
        lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Bind this client to an instance, and return the binding it is now on.
    pub fn bind(&self, identity: RuntimeIdentity) -> RuntimeBinding {
        let mut generations = Self::slot(&self.generations);
        *generations += 1;
        let binding = RuntimeBinding {
            identity,
            generation: *generations,
        };
        *Self::slot(&self.binding) = Some(binding);
        binding
    }

    pub fn binding(&self) -> Option<RuntimeBinding> {
        *Self::slot(&self.binding)
    }

    /// Ask the endpoint who it is, without sending anything secret.
    pub async fn identify(&self) -> Result<RuntimeIdentity, ProxyError> {
        let response = self.send(&Method::GET, "/healthz", None).await?;
        let body = decode(response).await?;
        identity_from(&body, self.endpoint.port).ok_or(ProxyError::Foreign)
    }

    pub async fn is_alive(&self) -> Result<Value, ProxyError> {
        self.get("/healthz").await
    }

    /// A health probe that cannot outlive the caller's deadline.
    ///
    /// The client's own timeout is per request and knows nothing about the budget the caller is
    /// working to. A probe started a moment before a deadline would otherwise overrun it by that
    /// whole timeout, which is how a stated 30-second startup ceiling quietly becomes 34.
    /// `None` means the deadline arrived first.
    pub async fn alive_within(&self, deadline: Instant) -> Option<Result<Value, ProxyError>> {
        timeout_at(deadline, self.is_alive()).await.ok()
    }

    pub async fn companion_settings(&self) -> Result<Value, ProxyError> {
        self.get("/api/companion/settings").await
    }

    pub async fn usage_summary(&self) -> Result<Value, ProxyError> {
        self.get("/api/usage?range=7d").await
    }

    pub async fn usage_today(&self) -> Result<Value, ProxyError> {
        self.get("/api/usage?range=today").await
    }

    pub async fn startup_health(&self) -> Result<Value, ProxyError> {
        self.get("/api/startup-health").await
    }

    pub async fn quotas(&self) -> Result<Value, ProxyError> {
        self.get("/api/provider-quotas").await
    }

    pub async fn timeline(&self, query: &str) -> Result<Value, ProxyError> {
        self.get(&format!("/api/usage/timeline?{query}")).await
    }

    pub(crate) async fn get(&self, path: &str) -> Result<Value, ProxyError> {
        self.request(Method::GET, path).await
    }

    /// Publish only these exact display-state bytes, without exposing the reusable admin token.
    pub async fn post_desktop_snapshot(&self, body: &Value) -> Result<(), ProxyError> {
        let body =
            serde_json::to_vec(body).map_err(|_| ProxyError::Http(StatusCode::BAD_REQUEST))?;
        if body.len() > 1024 {
            return Err(ProxyError::Http(StatusCode::PAYLOAD_TOO_LARGE));
        }
        let recorded = self.authorised_runtime()?;
        let headers =
            CapabilityHeaders::mint_snapshot(&recorded, &body).ok_or(ProxyError::Unauthorized)?;
        // Serialize once: the bytes hashed by mint_snapshot are the bytes reqwest sends.
        let request = self
            .client
            .post(self.endpoint.url(DESKTOP_SNAPSHOT_PATH))
            .header("content-type", "application/json")
            .body(body);
        let response = headers
            .apply(request)
            .send()
            .await
            .map_err(map_request_error)?;
        let _ = decode(response).await?;
        Ok(())
    }

    async fn request(&self, method: Method, path: &str) -> Result<Value, ProxyError> {
        let response = self.send(&method, path, None).await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            let signed = signed_target(&self.endpoint.url(path)).ok_or(ProxyError::Unauthorized)?;
            let headers = self.authorised_capability(&method, &signed)?;
            let response = self.send(&method, path, Some(headers)).await?;
            return decode(response).await;
        }
        decode(response).await
    }

    /// Mint one read grant, preserving the existing v1 method/path/query contract.
    fn authorised_capability(
        &self,
        method: &Method,
        path: &str,
    ) -> Result<CapabilityHeaders, ProxyError> {
        let recorded = self.authorised_runtime()?;
        CapabilityHeaders::mint(&recorded, method, path).ok_or(ProxyError::Unauthorized)
    }

    /// Re-confirm the recorded runtime for both read and snapshot grants.
    ///
    /// A replacement listener can observe only a short-lived proof, not the secret. The server
    /// consumes each proof once; a captured, unused proof is limited to its exact signed request
    /// until expiry. Snapshot grants additionally bind the body and cannot authorize other writes.
    fn authorised_runtime(&self) -> Result<RecordedRuntime, ProxyError> {
        let Some(binding) = self.binding() else {
            return Err(ProxyError::Unauthorized);
        };
        let recorded = self
            .auth
            .runtime_identity()
            .ok_or(ProxyError::Unauthorized)?;
        if recorded.port != self.endpoint.port {
            return Err(ProxyError::Unauthorized);
        }
        if recorded.pid != binding.identity.pid || recorded.port != binding.identity.port {
            return Err(ProxyError::Foreign);
        }
        if self.binding() != Some(binding) {
            return Err(ProxyError::Foreign);
        }
        Ok(recorded)
    }

    async fn send(
        &self,
        method: &Method,
        path: &str,
        capability: Option<CapabilityHeaders>,
    ) -> Result<reqwest::Response, ProxyError> {
        let mut request = self.client.request(method.clone(), self.endpoint.url(path));
        if let Some(headers) = capability {
            request = headers.apply(request);
        }
        request.send().await.map_err(map_request_error)
    }
}

/// A single-use read or body-bound snapshot grant, never a reusable management credential.
struct CapabilityHeaders {
    expected_pid: String,
    nonce: String,
    expires_at: String,
    capability: String,
    body_digest: Option<String>,
}

impl CapabilityHeaders {
    /// Mint a GET grant using the unchanged local-management-read-v1 wire format.
    fn mint(recorded: &RecordedRuntime, method: &Method, path: &str) -> Option<Self> {
        if method != Method::GET {
            return None;
        }
        let (nonce, expires_at) = fresh_capability_fields()?;
        Some(Self {
            expected_pid: recorded.pid.to_string(),
            capability: capability_mac(recorded, path, &nonce, expires_at)?,
            nonce,
            expires_at: expires_at.to_string(),
            body_digest: None,
        })
    }

    /// Mint only the bounded snapshot POST; its domain is distinct from every read grant.
    fn mint_snapshot(recorded: &RecordedRuntime, body: &[u8]) -> Option<Self> {
        if body.len() > 1024 {
            return None;
        }
        let (nonce, expires_at) = fresh_capability_fields()?;
        let body_digest = URL_SAFE_NO_PAD.encode(Sha256::digest(body));
        Some(Self {
            expected_pid: recorded.pid.to_string(),
            capability: snapshot_capability_mac(recorded, &nonce, expires_at, &body_digest)?,
            nonce,
            expires_at: expires_at.to_string(),
            body_digest: Some(body_digest),
        })
    }

    /// Attach only scoped proof headers, shared by both transport paths.
    fn apply(self, request: RequestBuilder) -> RequestBuilder {
        let mut request = request
            .header("x-opencodex-local-expected-pid", self.expected_pid)
            .header("x-opencodex-local-nonce", self.nonce)
            .header("x-opencodex-local-expires-at", self.expires_at)
            .header("x-opencodex-local-capability", self.capability);
        if let Some(digest) = self.body_digest {
            request = request.header("x-opencodex-desktop-snapshot-sha256", digest);
        }
        request
    }
}

/// Fresh randomness and a ten-second expiry for either scoped capability.
fn fresh_capability_fields() -> Option<(String, u64)> {
    let mut nonce_bytes = [0_u8; 32];
    nonce_bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    nonce_bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let expires_at = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis(),
    )
    .ok()?
    .checked_add(10_000)?;
    Some((URL_SAFE_NO_PAD.encode(nonce_bytes), expires_at))
}

/// The signed half of a capability, split out so the wire format can be tested against a fixed
/// vector from the TypeScript implementation. `None` means the inputs cannot form a valid grant.
fn capability_mac(
    recorded: &RecordedRuntime,
    path: &str,
    nonce: &str,
    expires_at: u64,
) -> Option<String> {
    // The server keys the MAC with the Base64URL text's UTF-8 bytes, not the decoded secret.
    let mut mac = Hmac::<Sha256>::new_from_slice(recorded.attestation_secret.as_bytes()).ok()?;
    mac.update(
        format!(
            "opencodex-local-management-read-v1\n{nonce}\nGET\n{path}\n{}\n{}\n{expires_at}",
            recorded.pid, recorded.port
        )
        .as_bytes(),
    );
    Some(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

/// The snapshot wire contract includes the exact body's SHA-256 digest.
fn snapshot_capability_mac(
    recorded: &RecordedRuntime,
    nonce: &str,
    expires_at: u64,
    body_digest: &str,
) -> Option<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(recorded.attestation_secret.as_bytes()).ok()?;
    mac.update(
        format!(
            "opencodex-local-desktop-snapshot-v1\n{nonce}\nPOST\n{DESKTOP_SNAPSHOT_PATH}\n{}\n{}\n{expires_at}\n{body_digest}",
            recorded.pid, recorded.port
        )
        .as_bytes(),
    );
    Some(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn map_request_error(error: reqwest::Error) -> ProxyError {
    if error.is_connect() {
        ProxyError::Unreachable
    } else {
        ProxyError::Decode(error)
    }
}

/// The request target the capability signs, derived from the parsed URL rather than the raw path
/// string. The server verifies `pathname + url.search`, which drops a bare `?` and keeps the
/// percent-encoding reqwest applies on send; signing the raw path would mismatch on both.
fn signed_target(url: &str) -> Option<String> {
    let url = reqwest::Url::parse(url).ok()?;
    match url.query().filter(|query| !query.is_empty()) {
        Some(query) => Some(format!("{}?{query}", url.path())),
        None => Some(url.path().to_owned()),
    }
}

async fn decode(response: reqwest::Response) -> Result<Value, ProxyError> {
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(ProxyError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(ProxyError::Http(response.status()));
    }
    response.json().await.map_err(ProxyError::Decode)
}

#[cfg(test)]
mod tests {
    use super::{
        capability_mac, identity_from, signed_target, snapshot_capability_mac, CapabilityHeaders,
        RuntimeIdentity,
    };
    use crate::auth::RecordedRuntime;
    use reqwest::Method;
    use serde_json::json;

    fn recorded_runtime() -> RecordedRuntime {
        RecordedRuntime {
            pid: 4242,
            port: 10100,
            attestation_secret: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc".into(),
        }
    }

    #[test]
    fn a_capability_matches_the_server_contract() {
        // The fixed nonce and expiry make the signature reproducible against the TypeScript
        // implementation: this vector is createLocalManagementReadCapability over the same
        // inputs, so a drift on either side fails here before it fails on the wire.
        let headers =
            CapabilityHeaders::mint(&recorded_runtime(), &Method::GET, "/api/usage?range=7d")
                .expect("a mintable grant");
        assert_eq!(headers.expected_pid, "4242");
        assert_eq!(headers.nonce.len(), 43);
        assert_eq!(headers.capability.len(), 43);
        assert!(headers.expires_at.parse::<u64>().unwrap() > 0);
        // A write method cannot mint a read grant. The literal Method::POST is avoided because an
        // exit-ownership source assertion forbids it in this file.
        let write = Method::from_bytes(b"POST").expect("a write method");
        assert!(CapabilityHeaders::mint(&recorded_runtime(), &write, "/api/usage").is_none());

        // The fixed nonce and expiry pin the exact wire signature to the TypeScript vector.
        let capability = capability_mac(
            &recorded_runtime(),
            "/api/usage?range=7d",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            1_700_000_010_000,
        )
        .expect("a signable grant");
        assert_eq!(capability, "oGyWOCGZsICYctxQv-mPK0gCiDocvOVHQG5plyjYCUg");
        assert_eq!(
            capability_mac(
                &recorded_runtime(),
                "/api/system/memory",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                1_700_000_010_000,
            )
            .as_deref(),
            Some("_a3HS292KKaMcXsDx0owmWr3zRFTYjH6vhUdpunRW28")
        );
    }

    #[test]
    fn a_snapshot_grant_binds_the_body_and_matches_the_server_contract() {
        let body = br#"{"sessionId":"test"}"#;
        let headers = CapabilityHeaders::mint_snapshot(&recorded_runtime(), body).unwrap();
        let digest = "5pREWDDMbj42QHj3DvVNrC54yVF7Vpd8cNj5c-z3rQ4";
        assert_eq!(headers.body_digest.as_deref(), Some(digest));
        assert_eq!(headers.expected_pid, "4242");
        assert_eq!(
            snapshot_capability_mac(
                &recorded_runtime(),
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                1_700_000_010_000,
                digest,
            )
            .as_deref(),
            Some("yEkTQtyXzQsi_kJGmzmUO1wyJIjc_G4-iiNNoyB4Zcw")
        );
        assert!(CapabilityHeaders::mint_snapshot(&recorded_runtime(), &[0; 1025]).is_none());
        let request = headers
            .apply(
                reqwest::Client::new().post("http://127.0.0.1:10100/api/update/desktop-snapshot"),
            )
            .body(body.to_vec())
            .build()
            .unwrap();
        assert!(!request.headers().contains_key("x-opencodex-api-key"));
        assert!(!request.headers().contains_key("authorization"));
        assert_eq!(
            request.headers()["x-opencodex-desktop-snapshot-sha256"],
            digest
        );
        assert_eq!(request.body().unwrap().as_bytes(), Some(body.as_slice()));
    }

    #[test]
    fn a_health_body_without_the_marker_is_not_this_proxy() {
        let body = json!({ "status": "ok", "pid": 42, "port": 10100 });
        assert!(identity_from(&body, 10100).is_none());
        let foreign = json!({ "service": "something-else", "pid": 42, "port": 10100 });
        assert!(identity_from(&foreign, 10100).is_none());
    }

    #[test]
    fn the_body_has_to_describe_the_listener_that_was_addressed() {
        let body = json!({ "service": "opencodex", "pid": 42, "port": 10101 });
        assert!(identity_from(&body, 10100).is_none());
    }

    #[test]
    fn a_complete_body_identifies_the_instance() {
        let body = json!({ "service": "opencodex", "version": "2.61.0", "pid": 42, "port": 10100 });
        assert_eq!(
            identity_from(&body, 10100),
            Some(RuntimeIdentity {
                pid: 42,
                port: 10100
            })
        );
    }

    #[test]
    fn a_body_missing_the_instance_facts_identifies_nothing() {
        assert!(identity_from(&json!({ "service": "opencodex", "port": 10100 }), 10100).is_none());
        assert!(identity_from(&json!({ "service": "opencodex", "pid": 42 }), 10100).is_none());
    }

    #[test]
    fn the_signed_target_matches_what_the_server_reconstructs() {
        // A bare `?` has an empty search on the server, so it must not be signed.
        assert_eq!(
            signed_target("http://127.0.0.1:10100/api/usage/timeline?").as_deref(),
            Some("/api/usage/timeline")
        );
        // A populated query is signed verbatim, including percent-encoding reqwest applies.
        assert_eq!(
            signed_target("http://127.0.0.1:10100/api/usage/timeline?range=7d").as_deref(),
            Some("/api/usage/timeline?range=7d")
        );
        assert_eq!(
            signed_target("http://127.0.0.1:10100/api/usage/timeline?model=a b").as_deref(),
            Some("/api/usage/timeline?model=a%20b")
        );
        assert_eq!(signed_target("not a url"), None);
    }
}

use crate::{
    auth::{Auth, RecordedRuntime},
    endpoint::ProxyEndpoint,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use reqwest::{redirect, Client, Method, StatusCode};
use serde_json::Value;
use sha2::Sha256;
use std::{
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};
use tokio::time::{timeout_at, Instant};

/// Which instance answered, taken from the unauthenticated health body.
///
/// The management token is the admin credential for this machine's proxy. Sending it to whatever
/// happens to hold the port is the thing to avoid, so identity is established first — from a
/// response that needs no credential to read — and the credential follows only if the answer is the
/// instance the shell decided to trust.
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
                // The admin token attached to these requests is for the loopback endpoint and
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

    pub async fn post_desktop_snapshot(&self, body: &Value) -> Result<(), ProxyError> {
        let token = self.authorised_token().await?;
        let response = self
            .client
            .post(self.endpoint.url("/api/update/desktop-snapshot"))
            .header("X-OpenCodex-API-Key", token)
            .json(body)
            .send()
            .await
            .map_err(|error| {
                if error.is_connect() {
                    ProxyError::Unreachable
                } else {
                    ProxyError::Decode(error)
                }
            })?;
        let _ = decode(response).await?;
        Ok(())
    }

    async fn request(&self, method: Method, path: &str) -> Result<Value, ProxyError> {
        let response = self.send(&method, path, None).await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            let token = self.authorised_token().await?;
            let response = self.send(&method, path, Some(token)).await?;
            return decode(response).await;
        }
        decode(response).await
    }

    /// The management token, but only for the instance this client is bound to.
    ///
    /// The binding is re-confirmed here rather than trusted from when it was made: between then and
    /// now the child can have exited and something else can hold the port. A request is therefore
    /// bound to a pid, a port and the generation the shell authorised, and a mismatch is refused
    /// instead of being sent the credential. The peer also has to prove the recorded attestation
    /// secret: a pid and port can be replayed by a hostile listener, the proof cannot.
    async fn authorised_token(&self) -> Result<String, ProxyError> {
        let Some(binding) = self.binding() else {
            return Err(ProxyError::Unauthorized);
        };
        let identity = self.identify_with_attestation().await?;
        if identity != binding.identity {
            return Err(ProxyError::Foreign);
        }
        if self.binding() != Some(binding) {
            return Err(ProxyError::Foreign);
        }
        self.auth.token().ok_or(ProxyError::Unauthorized)
    }

    /// Ask the endpoint who it is and make it prove the recorded attestation secret in the same
    /// round-trip: the challenge goes out as a header and the proof comes back in one. A listener
    /// that cannot read the secret — a foreign service, or a hostile process that took the port
    /// after the bound child exited — cannot produce it, so the credential stays put.
    async fn identify_with_attestation(&self) -> Result<RuntimeIdentity, ProxyError> {
        let recorded = self
            .auth
            .runtime_identity()
            .ok_or(ProxyError::Unauthorized)?;
        if recorded.port != self.endpoint.port {
            return Err(ProxyError::Unauthorized);
        }
        let mut challenge_bytes = [0_u8; 32];
        challenge_bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        challenge_bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(challenge_bytes);
        let response = self
            .client
            .get(self.endpoint.url("/healthz"))
            .header("x-opencodex-attestation-challenge", &challenge)
            .send()
            .await
            .map_err(map_request_error)?;
        let proof = response
            .headers()
            .get("x-opencodex-attestation-proof")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = decode(response).await?;
        let identity = identity_from(&body, self.endpoint.port).ok_or(ProxyError::Foreign)?;
        if identity.pid != recorded.pid
            || !valid_attestation_proof(&recorded, &challenge, proof.as_deref())
            || self.auth.runtime_identity().as_ref() != Some(&recorded)
        {
            return Err(ProxyError::Unauthorized);
        }
        Ok(identity)
    }

    async fn send(
        &self,
        method: &Method,
        path: &str,
        token: Option<String>,
    ) -> Result<reqwest::Response, ProxyError> {
        let mut request = self.client.request(method.clone(), self.endpoint.url(path));
        if let Some(value) = token {
            request = request.header("X-OpenCodex-API-Key", value);
        }
        request.send().await.map_err(map_request_error)
    }
}

fn valid_attestation_proof(
    recorded: &RecordedRuntime,
    challenge: &str,
    proof: Option<&str>,
) -> bool {
    // The server keys the MAC with the Base64URL text's UTF-8 bytes, not the decoded secret.
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(recorded.attestation_secret.as_bytes()) else {
        return false;
    };
    mac.update(
        format!(
            "opencodex-local-management-v1\n{challenge}\n{}\n{}",
            recorded.pid, recorded.port
        )
        .as_bytes(),
    );
    proof
        .and_then(|value| URL_SAFE_NO_PAD.decode(value).ok())
        .is_some_and(|value| mac.verify_slice(&value).is_ok())
}

fn map_request_error(error: reqwest::Error) -> ProxyError {
    if error.is_connect() {
        ProxyError::Unreachable
    } else {
        ProxyError::Decode(error)
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
    use super::{identity_from, valid_attestation_proof, RuntimeIdentity};
    use crate::auth::RecordedRuntime;
    use serde_json::json;

    fn recorded_runtime() -> RecordedRuntime {
        RecordedRuntime {
            pid: 4242,
            port: 10100,
            attestation_secret: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc".into(),
        }
    }

    #[test]
    fn accepts_only_a_proof_bound_to_the_runtime_identity() {
        let challenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let proof = "Yr9EKHjeAFfsFMsF8Xsd7J6LxBYnObweKZlLyTMk0Lo";
        assert!(valid_attestation_proof(
            &recorded_runtime(),
            challenge,
            Some(proof)
        ));

        let mut replacement = recorded_runtime();
        replacement.pid += 1;
        assert!(!valid_attestation_proof(
            &replacement,
            challenge,
            Some(proof)
        ));
        assert!(!valid_attestation_proof(&recorded_runtime(), challenge, None));
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
}

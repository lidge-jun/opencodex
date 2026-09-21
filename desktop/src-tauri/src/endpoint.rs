//! The loopback endpoint the shell talks to.
//!
//! This file was `discovery.rs`, and it resolved the endpoint itself: it read `runtime-port.json`,
//! fell back to 10100 and let the shell start there, so a user with a configured `config.port` was
//! started on a port they had not chosen. Resolution belongs to the bundled CLI now — see
//! `resolve.rs` — and what is left here is the value it hands back.

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

#[cfg(test)]
mod tests {
    use super::ProxyEndpoint;

    #[test]
    fn the_endpoint_is_loopback_and_carries_its_port() {
        let endpoint = ProxyEndpoint {
            host: "127.0.0.1",
            port: 12345,
        };
        assert_eq!(endpoint.url("/healthz"), "http://127.0.0.1:12345/healthz");
        assert_eq!(endpoint.url(""), "http://127.0.0.1:12345");
    }
}

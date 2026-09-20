use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Auth {
    home: PathBuf,
    environment_token: Option<String>,
}

impl Auth {
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            environment_token: std::env::var("OPENCODEX_ADMIN_AUTH_TOKEN")
                .ok()
                .filter(|value| !value.is_empty()),
        }
    }

    pub fn token(&self) -> Option<String> {
        self.environment_token.clone().or_else(|| {
            std::fs::read_to_string(self.home.join("admin-api-token"))
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
    }

    pub fn user_agent() -> &'static str {
        concat!("OpenCodexDesktop/", env!("CARGO_PKG_VERSION"))
    }
}

#![deny(unsafe_op_in_unsafe_fn)]

pub mod cli;
pub mod codex_home;
pub mod codex_settings;
pub mod daemon;
pub mod http_wire;
pub mod journal;
pub mod link_ws;
pub mod link_ws_advert;
pub mod link_ws_frame;
pub mod parity;
pub mod platform;
pub mod relay;
pub mod relay_auth;
pub mod routes;
pub mod state;
pub mod test_hooks;
pub mod toml_surgeon;

/// OpenCodex wire/CLI protocol version reported by `ocx-child --version` and peer headers.
/// Kept >= 2.93.0 so Home enrollment (`>= 2.66.0`) and `ocx sync` fan-out (`>= 2.93.0`) accept it,
/// while decoupled from the crate's own `0.1.0` Cargo version.
pub const OCX_PROTOCOL_COMPAT_VERSION: &str = "2.98.0";
pub const DEFAULT_LISTEN_PORT: u16 = 10100;

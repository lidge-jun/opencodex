#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayAuthKind {
    Bearer,
    ApiKeyHeader,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteDecision {
    LocalHealthz,
    LocalReadyz,
    LocalShutdown,
    Reject403Origin,
    Reject426Websocket,
    Reject404,
    RelayData { auth: RelayAuthKind },
    RelayManagement,
}

const CONTEXT_PATHS: &[&str] = &[
    "/v1/alpha/history/v2/list_windows",
    "/v1/alpha/history/v2/list_items",
    "/v1/alpha/history/v2/read_item",
    "/v1/alpha/history/v2/search_contents",
    "/v1/alpha/notes/v2/thread_hint",
    "/v1/alpha/notes/v2/list_files_by_prefix",
    "/v1/alpha/notes/v2/read_file",
    "/v1/alpha/notes/v2/search_contents",
    "/v1/alpha/notes/v2/append_to_file",
    "/v1/alpha/notes/v2/write_file",
];

const POST_DATA_PATHS: &[&str] = &[
    "/v1/responses",
    "/v1/responses/compact",
    "/v1/messages",
    "/v1/messages/count_tokens",
    "/v1/chat/completions",
    "/v1/audio/transcriptions",
    "/v1/alpha/search",
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/live",
    "/v1/realtime/calls",
];

const LINK_MANAGEMENT_READ_PATHS: &[&str] = &[
    "/api/system/health",
    "/api/startup-health",
    "/api/providers",
    "/api/settings",
    "/api/usage",
    "/api/effort-caps",
    "/api/injection-model",
    "/api/shadow-call-settings",
    "/api/sidecar-settings",
    "/api/v2",
    "/api/provider-quotas",
    "/api/quota-pool",
    "/api/fallback",
    "/api/codex-auth/active",
    "/api/codex-auth/accounts",
    "/api/oauth/accounts",
    "/api/providers/keys",
    "/api/oauth/providers",
    "/api/catalog",
    "/api/system/memory",
    "/api/provider-presets",
    "/api/provider-context-caps",
];

const FORBIDDEN_MANAGEMENT_QUERY_KEYS: &[&str] = &["refresh", "reload", "force", "quota"];

pub fn link_data_route_allowed(method: &str, path: &str, has_upgrade: bool) -> bool {
    if has_upgrade {
        return false;
    }
    if path == "/readyz" {
        return method == "GET";
    }
    if path == "/v1/catalog" || path == "/v1/hub-state" {
        return method == "GET" || method == "HEAD";
    }
    if path == "/v1/usage" || path == "/v1/models" {
        return method == "GET";
    }
    if POST_DATA_PATHS.contains(&path) || CONTEXT_PATHS.contains(&path) {
        return method == "POST";
    }
    method == "GET" && path.starts_with("/v1/opencodex/artifacts/")
}

pub fn link_management_route_allowed(
    method: &str,
    path: &str,
    query: &str,
    has_upgrade: bool,
) -> bool {
    if has_upgrade {
        return false;
    }
    if path == "/v1/link-management/codex-settings" {
        return method == "GET" && query.is_empty();
    }
    let Some(suffix) = path.strip_prefix("/v1/link-management") else {
        return false;
    };
    if (method != "GET" && method != "HEAD") || !LINK_MANAGEMENT_READ_PATHS.contains(&suffix) {
        return false;
    }
    let raw_q = query.strip_prefix('?').unwrap_or(query);
    if raw_q.is_empty() {
        return true;
    }
    for pair in raw_q.split('&') {
        let key = pair.split('=').next().unwrap_or("").to_ascii_lowercase();
        if FORBIDDEN_MANAGEMENT_QUERY_KEYS.contains(&key.as_str()) {
            return false;
        }
    }
    true
}

fn is_loopback_hostname(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "[::1]" | "::1"
    )
}

fn parse_authority_hostname(authority: &str) -> Option<&str> {
    let trimmed = authority.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('@') || trimmed.contains(' ')
    {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix('[') {
        let end = rest.find(']')?;
        let tail = &rest[end + 1..];
        if !tail.is_empty() {
            let port = tail.strip_prefix(':')?;
            if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
        }
        return Some(&trimmed[..=end + 1]);
    }
    if let Some((h, p)) = trimmed.rsplit_once(':') {
        if h.contains(':')
            || h.is_empty()
            || (!p.is_empty() && !p.bytes().all(|b| b.is_ascii_digit()))
        {
            return None;
        }
        return Some(h);
    }
    Some(trimmed)
}

/// Mirrors `isAllowedRequestOrigin` (`src/server/auth-cors.ts:83-125`) for loopback listeners.
pub fn is_allowed_loopback_request_origin(
    host_header: Option<&str>,
    origin_header: Option<&str>,
) -> bool {
    if let Some(host_val) = host_header
        && let Some(hostname) = parse_authority_hostname(host_val)
        && !is_loopback_hostname(hostname)
    {
        return false;
    }
    let Some(origin) = origin_header else {
        return true;
    };
    let trimmed = origin.trim();
    let rest = if let Some(r) = trimmed.strip_prefix("http://") {
        r
    } else if let Some(r) = trimmed.strip_prefix("https://") {
        r
    } else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or("");
    let Some(hostname) = parse_authority_hostname(authority) else {
        return false;
    };
    is_loopback_hostname(hostname)
}

pub fn classify_child_ingress(
    method: &str,
    path: &str,
    query: &str,
    host_header: Option<&str>,
    origin_header: Option<&str>,
    upgrade_header: Option<&str>,
) -> RouteDecision {
    if method == "POST" && path == "/__ocx_child/shutdown" && upgrade_header.is_none() {
        return RouteDecision::LocalShutdown;
    }
    if let Some(upgrade) = upgrade_header {
        if path == "/v1/responses" && upgrade.trim().eq_ignore_ascii_case("websocket") {
            if !is_allowed_loopback_request_origin(host_header, origin_header) {
                return RouteDecision::Reject403Origin;
            }
            return RouteDecision::Reject426Websocket;
        }
        return RouteDecision::Reject404;
    }
    if path == "/healthz" && method == "GET" {
        return RouteDecision::LocalHealthz;
    }
    if path == "/readyz" {
        return if method == "GET" {
            RouteDecision::LocalReadyz
        } else {
            RouteDecision::Reject404
        };
    }
    if link_data_route_allowed(method, path, false) {
        if !is_allowed_loopback_request_origin(host_header, origin_header) {
            return RouteDecision::Reject403Origin;
        }
        let auth = if path == "/v1/usage" {
            RelayAuthKind::ApiKeyHeader
        } else {
            RelayAuthKind::Bearer
        };
        return RouteDecision::RelayData { auth };
    }
    if link_management_route_allowed(method, path, query, false) {
        if !is_allowed_loopback_request_origin(host_header, origin_header) {
            return RouteDecision::Reject403Origin;
        }
        return RouteDecision::RelayManagement;
    }
    RouteDecision::Reject404
}

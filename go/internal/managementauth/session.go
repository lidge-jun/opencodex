package managementauth

// Origin machinery and admin-token loading (ADR-0008, ticket #18). The origin
// functions mirror src/server/auth-cors.ts (parseHttpHost, isLoopbackHostname,
// isApiAuthRequired, managementRequestOrigin) because dashboard-session
// authorization compares the request's derived server origin against the
// origin recorded on the session at mint time; a mismatch must reject exactly
// when TypeScript rejects.

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// adminTokenPattern mirrors the token-file shape check in
// src/server/management-auth.ts (readExistingToken) and src/lib/admin-secrets.ts.
var adminTokenPattern = regexp.MustCompile(`^ocx_admin_[A-Za-z0-9_-]{43}$`)

// ADMIN_TOKEN_FILE mirrors src/lib/admin-secrets.ts.
const ADMIN_TOKEN_FILE = "admin-api-token"

// AdminTokenFilePath mirrors adminApiTokenFilePath.
func AdminTokenFilePath(configDir string) string {
	return filepath.Join(configDir, ADMIN_TOKEN_FILE)
}

// LoadAdminToken mirrors loadAdminTokenFromFile in src/lib/admin-secrets.ts:
// a regular, non-symlink file of at most 512 bytes whose trimmed content has
// the ocx_admin_ shape. It never creates or hardens the file: token-file
// creation and ACL hardening are the serving process's job at the flip, and a
// read-only sidecar must not mutate the parent's secret file pre-flip.
func LoadAdminToken(configDir string) string {
	path := AdminTokenFilePath(configDir)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 512 {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	token := strings.TrimSpace(string(raw))
	if !adminTokenPattern.MatchString(token) {
		return ""
	}
	return token
}

// EnvAdminToken mirrors the OPENCODEX_ADMIN_AUTH_TOKEN trim in
// src/server/management-auth.ts (environmentToken). No shape check applies to
// an environment token; equality is what matters.
func EnvAdminToken(environ func(string) string) string {
	return strings.TrimSpace(environ("OPENCODEX_ADMIN_AUTH_TOKEN"))
}

// EqualSecret mirrors equalSecret: timing-safe byte equality with a length
// pre-check, over UTF-8 encodings.
func EqualSecret(actual, expected string) bool {
	left := []byte(actual)
	right := []byte(expected)
	if len(left) != len(right) {
		return false
	}
	return equalCapabilityBytes(string(left), string(right))
}

// Request is the admission-relevant slice of one HTTP request: the full URL
// (protocol/host/path/search as TypeScript sees them), the method, and the
// headers with names lowercased. An absent header and an empty value are the
// same thing here; see capability.go for why that never changes a decision.
type Request struct {
	URL    string
	Method string
	Header map[string]string
}

// Get mirrors Headers.get with case-insensitive names.
func (r *Request) Get(name string) string {
	if r == nil || r.Header == nil {
		return ""
	}
	return r.Header[strings.ToLower(name)]
}

// parsedURL lazily parses r.URL; nil when unparseable.
func (r *Request) parsedURL() *url.URL {
	parsed, err := url.Parse(r.URL)
	if err != nil {
		return nil
	}
	return parsed
}

// MethodName returns the method upper-cased the way Go HTTP normalises it
// (the TS side receives whatever the client sent; the capability contracts
// require exact uppercase POST/GET so the comparison is by exact string).
func (r *Request) MethodName() string {
	return r.Method
}

// parseHTTPHost mirrors parseHttpHost in src/server/auth-cors.ts: parse the
// Host header as http://<host> and return the lowercased WHATWG hostname
// (IPv6 bracketed) and the URL port ("" when default/absent). Nil means the
// header was absent or unparseable.
func parseHTTPHost(value string) *struct {
	Hostname string
	Port     string
} {
	if value == "" {
		return nil
	}
	parsed, err := url.Parse("http://" + value)
	if err != nil {
		return nil
	}
	if parsed.Host == "" {
		return nil
	}
	return &struct {
		Hostname string
		Port     string
	}{Hostname: whatwgHostname(parsed), Port: parsed.Port()}
}

// whatwgHostname returns the hostname the way URL.hostname serialises it:
// lowercased, IPv6 bracketed. Go's Hostname() strips brackets and keeps case,
// so this rebuilds the WHATWG form.
func whatwgHostname(u *url.URL) string {
	host := u.Hostname()
	lower := strings.ToLower(host)
	if strings.Contains(lower, ":") {
		return "[" + lower + "]"
	}
	return lower
}

// isLoopbackHostname mirrors isLoopbackHostname in src/server/auth-cors.ts:
// the normalized hostname (trimmed, lowercased, one trailing dot stripped) is
// empty, "localhost", "127.0.0.1", "::1", or "[::1]". An empty input stays
// empty (loopback); the "127.0.0.1" default in the TS side applies only to
// undefined, which cannot occur here.
func isLoopbackHostname(hostname string) bool {
	normalized := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(hostname)), ".")
	switch normalized {
	case "", "localhost", "127.0.0.1", "::1", "[::1]":
		return true
	}
	return false
}

// IsApiAuthRequired mirrors isApiAuthRequired: false exactly when the
// configured hostname is a loopback hostname.
func IsApiAuthRequired(cfg ConfigView) bool {
	return !isLoopbackHostname(cfg.Hostname)
}

// ManagementRequestOrigin mirrors managementRequestOrigin in
// src/server/auth-cors.ts. It derives the origin a request was served from:
// for a loopback Host the observed protocol+host; for a non-loopback Host only
// when auth is required, preferring the hub's configured public origin when
// this process runs as a hub and one is configured. Empty means no origin.
func ManagementRequestOrigin(r *Request, cfg ConfigView) string {
	host := r.Get("host")
	parsedHost := parseHTTPHost(host)
	if parsedHost == nil {
		return ""
	}
	if isLoopbackHostname(parsedHost.Hostname) {
		parsed := r.parsedURL()
		if parsed == nil {
			return ""
		}
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return ""
		}
		origin, err := url.Parse(parsed.Scheme + "://" + host)
		if err != nil {
			return ""
		}
		return whatwgOrigin(origin)
	}
	if !IsApiAuthRequired(cfg) {
		return ""
	}
	if cfg.RuntimeRole == "hub" && cfg.HubManagementPublicOrigin != "" {
		configured, err := url.Parse(cfg.HubManagementPublicOrigin)
		if err == nil && configured.Host != "" {
			valid := (configured.Scheme == "http" || configured.Scheme == "https") &&
				configured.User == nil && (configured.Path == "" || configured.Path == "/") &&
				configured.RawQuery == "" && configured.Fragment == ""
			if valid {
				return whatwgOrigin(configured)
			}
		}
	}
	parsed := r.parsedURL()
	if parsed == nil {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	origin, err := url.Parse(parsed.Scheme + "://" + host)
	if err != nil {
		return ""
	}
	return whatwgOrigin(origin)
}

// RequestManagementCredential mirrors requestManagementCredential: the
// x-opencodex-api-key header trimmed, else the Authorization header with a
// case-insensitive "Bearer " prefix stripped and the result trimmed.
func RequestManagementCredential(r *Request) string {
	if value := strings.TrimSpace(r.Get("x-opencodex-api-key")); value != "" {
		return value
	}
	authorization := r.Get("authorization")
	if authorization == "" {
		return ""
	}
	stripped := bearerPrefixPattern.ReplaceAllString(authorization, "")
	return strings.TrimSpace(stripped)
}

var bearerPrefixPattern = regexp.MustCompile(`(?i)^Bearer\s+`)

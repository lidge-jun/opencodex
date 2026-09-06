package managementauth

// Process-scoped capability contracts (ADR-0008, ticket #18). Each mirrors the
// homonymous module under src/lib/: the payload string that the TypeScript
// side HMACs, the exact header names, the allowlist shapes, and the
// base64url-256 (43-char) secret/capability format. A capability minted by the
// TypeScript process must verify here byte-for-byte, and one minted here must
// verify on the TypeScript side — the differential oracle pins both
// directions. The payloads are versioned strings joined with \n; the trailing
// pieces are exactly as src/lib emits them, so an off-by-one field or an extra
// newline breaks parity immediately.
//
// Header modelling: an empty string means the header is absent. TypeScript
// distinguishes null (absent) from "" only for the pid parsers (absent vs
// invalid) and empty capability/browser-origin values, and every such
// distinction converges on the same admission decision (rejection), so folding
// "" into absent never changes an outcome the oracle can observe.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Contract header names, paths, methods, and TTLs mirror the TS constants.
const (
	LocalManagementExpectedPIDHeader = "x-opencodex-local-expected-pid"
	LocalManagementNonceHeader       = "x-opencodex-local-nonce"
	LocalManagementExpiresAtHeader   = "x-opencodex-local-expires-at"
	LocalManagementCapabilityHeader  = "x-opencodex-local-capability"
	LocalManagementCapabilityTTLMs   = 10_000

	LocalManagementReadPathCodexAccounts = "/api/codex-auth/accounts"
	LocalManagementReadPathSystemMemory  = "/api/system/memory"

	SystemRestartExpectedPIDHeader = "x-opencodex-restart-expected-pid"
	SystemRestartNonceHeader       = "x-opencodex-restart-nonce"
	SystemRestartCapabilityHeader  = "x-opencodex-restart-capability"
	SystemRestartMethod            = "POST"
	SystemRestartPath              = "/api/system/restart"

	LocalProviderReloadExpectedPIDHeader = "x-opencodex-provider-reload-expected-pid"
	LocalProviderReloadNonceHeader       = "x-opencodex-provider-reload-nonce"
	LocalProviderReloadExpiresAtHeader   = "x-opencodex-provider-reload-expires-at"
	LocalProviderReloadNameHeader        = "x-opencodex-provider-reload-name"
	LocalProviderReloadCapabilityHeader  = "x-opencodex-provider-reload-capability"
	LocalProviderReloadCapabilityTTLMs   = 10_000
	LocalProviderReloadMethod            = "POST"
	LocalProviderReloadPath              = "/api/providers/reload"

	GUIPairExpectedPIDHeader   = "x-opencodex-gui-pair-expected-pid"
	GUIPairNonceHeader         = "x-opencodex-gui-pair-nonce"
	GUIPairExpiresAtHeader     = "x-opencodex-gui-pair-expires-at"
	GUIPairBrowserOriginHeader = "x-opencodex-gui-pair-origin"
	GUIPairCapabilityHeader    = "x-opencodex-gui-pair-capability"
	GUIPairCapabilityTTLMs     = 10_000
	GUIPairMethod              = "POST"
	GUIPairPath                = "/api/gui/pairing-grants"

	localReadMethod = "GET"
)

var (
	// base64URL256 mirrors BASE64URL_256 in the TS contracts: a 256-bit
	// base64url string without padding (43 characters).
	base64URL256 = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	// providerNamePattern mirrors PROVIDER_NAME in
	// src/lib/local-provider-reload-contract.ts.
	providerNamePattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$`)
	// positiveDecimal mirrors the pid/expiry parsers: no leading zero, no zero.
	positiveDecimal = regexp.MustCompile(`^[1-9]\d*$`)
)

// IsBase64URL256 reports whether value is a 256-bit base64url string.
func IsBase64URL256(value string) bool {
	return base64URL256.MatchString(value)
}

// IsAttestationSecret mirrors isLocalAttestationSecret.
func IsAttestationSecret(value string) bool {
	return base64URL256.MatchString(value)
}

// IsLocalProviderReloadName mirrors isLocalProviderReloadName.
func IsLocalProviderReloadName(value string) bool {
	return providerNamePattern.MatchString(value)
}

// hmacBase64URL computes HMAC-SHA256 over payload keyed by secret, encoded
// base64url without padding — Node's .digest("base64url") format.
func hmacBase64URL(secret string, payload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// equalSecretByte is the timing-safe comparison every verify uses, with the
// TS length guard first.
func equalCapabilityBytes(expected, actual string) bool {
	if len(expected) != len(actual) {
		return false
	}
	return hmac.Equal([]byte(expected), []byte(actual))
}

// ExpectedPIDKind mirrors the kind-union parse in the TS contracts.
type ExpectedPIDKind string

const (
	ExpectedPIDAbsent  ExpectedPIDKind = "absent"
	ExpectedPIDInvalid ExpectedPIDKind = "invalid"
	ExpectedPIDPresent ExpectedPIDKind = "present"
)

// ParseExpectedPID mirrors parseExpectedLocalManagementPid and its siblings.
// value == "" models an absent header; anything that is not positive decimal
// digits is invalid.
func ParseExpectedPID(value string) (ExpectedPIDKind, int64) {
	if value == "" {
		return ExpectedPIDAbsent, 0
	}
	if !positiveDecimal.MatchString(value) {
		return ExpectedPIDInvalid, 0
	}
	parsed, err := parseDecimalInt64(value)
	if err != nil {
		return ExpectedPIDInvalid, 0
	}
	return ExpectedPIDPresent, parsed
}

// parseExpiryHeader mirrors the TS expiry checks: the raw header must match
// ^[1-9]\d*$ and parse to a safe integer, or the request is rejected before
// any capability verification runs.
func parseExpiryHeader(value string) (int64, bool) {
	if !positiveDecimal.MatchString(value) {
		return 0, false
	}
	parsed, err := parseDecimalInt64(value)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func parseDecimalInt64(value string) (int64, error) {
	var out int64
	for _, r := range value {
		if r < '0' || r > '9' {
			return 0, errNotDecimal
		}
		next := out*10 + int64(r-'0')
		if next < out {
			// Overflow cannot be a JS safe integer; do not wrap silently.
			return 0, errNotDecimal
		}
		out = next
	}
	return out, nil
}

var errNotDecimal = &notDecimalError{}

type notDecimalError struct{}

func (*notDecimalError) Error() string { return "not a decimal integer" }

func expiryWithin(now, expiresAt, ttl int64) bool {
	// TS: !Number.isSafeInteger(now) rejects; expiresAt <= now rejects;
	// expiresAt > now + TTL rejects.
	return expiresAt > now && expiresAt <= now+ttl
}

// ---------------------------------------------------------------------------
// Attestation (src/lib/local-management-attestation.ts)
// ---------------------------------------------------------------------------

func attestationPayload(challenge string, pid int64, port int) (string, bool) {
	if !base64URL256.MatchString(challenge) || pid <= 0 || port <= 0 || port > 65535 {
		return "", false
	}
	return "opencodex-local-management-v1\n" + challenge + "\n" + itoa(pid) + "\n" + itoaInt(port), true
}

// CreateLocalAttestationProof mirrors createLocalAttestationProof. Empty
// result means the inputs are invalid.
func CreateLocalAttestationProof(secret, challenge string, pid int64, port int) string {
	if !IsAttestationSecret(secret) {
		return ""
	}
	payload, ok := attestationPayload(challenge, pid, port)
	if !ok {
		return ""
	}
	return hmacBase64URL(secret, payload)
}

// VerifyLocalAttestationProof mirrors verifyLocalAttestationProof.
func VerifyLocalAttestationProof(secret, challenge string, pid int64, port int, proof string) bool {
	expected := CreateLocalAttestationProof(secret, challenge, pid, port)
	if expected == "" || !base64URL256.MatchString(proof) {
		return false
	}
	return equalCapabilityBytes(expected, proof)
}

// ---------------------------------------------------------------------------
// System restart (src/lib/system-restart-contract.ts)
// ---------------------------------------------------------------------------

func restartPayload(nonce, method, path string, pid int64, port int) (string, bool) {
	if !base64URL256.MatchString(nonce) || method != SystemRestartMethod || path != SystemRestartPath || pid <= 0 || port <= 0 || port > 65535 {
		return "", false
	}
	return "opencodex-system-restart-v1\n" + nonce + "\n" + method + "\n" + path + "\n" + itoa(pid) + "\n" + itoaInt(port), true
}

// CreateSystemRestartCapability mirrors createSystemRestartCapability.
func CreateSystemRestartCapability(secret, nonce, method, path string, pid int64, port int) string {
	if !IsAttestationSecret(secret) {
		return ""
	}
	payload, ok := restartPayload(nonce, method, path, pid, port)
	if !ok {
		return ""
	}
	return hmacBase64URL(secret, payload)
}

// VerifySystemRestartCapability mirrors verifySystemRestartCapability. The
// restart contract has no expiry window.
func VerifySystemRestartCapability(secret, nonce, method, path string, pid int64, port int, capability string) bool {
	if nonce == "" || !base64URL256.MatchString(capability) {
		return false
	}
	expected := CreateSystemRestartCapability(secret, nonce, method, path, pid, port)
	if expected == "" {
		return false
	}
	return equalCapabilityBytes(expected, capability)
}

// ---------------------------------------------------------------------------
// Local provider reload (src/lib/local-provider-reload-contract.ts)
// ---------------------------------------------------------------------------

func providerReloadPayload(nonce, method, path, name string, pid int64, port int, expiresAt int64) (string, bool) {
	if !base64URL256.MatchString(nonce) || method != LocalProviderReloadMethod || path != LocalProviderReloadPath {
		return "", false
	}
	if !IsLocalProviderReloadName(name) {
		return "", false
	}
	if pid <= 0 || port <= 0 || port > 65535 || expiresAt <= 0 {
		return "", false
	}
	return "opencodex-local-provider-reload-v1\n" + nonce + "\n" + method + "\n" + path + "\n" + name + "\n" + itoa(pid) + "\n" + itoaInt(port) + "\n" + itoa(expiresAt), true
}

// CreateLocalProviderReloadCapability mirrors createLocalProviderReloadCapability.
func CreateLocalProviderReloadCapability(secret, nonce, method, path, name string, pid int64, port int, expiresAt int64) string {
	if !IsAttestationSecret(secret) {
		return ""
	}
	payload, ok := providerReloadPayload(nonce, method, path, name, pid, port, expiresAt)
	if !ok {
		return ""
	}
	return hmacBase64URL(secret, payload)
}

// VerifyLocalProviderReloadCapability mirrors
// verifyLocalProviderReloadCapability. name == "" models an absent name
// header, which fails verification exactly as the TS null does.
func VerifyLocalProviderReloadCapability(secret, nonce, method, path, name string, pid int64, port int, expiresAt int64, capability string, now int64) bool {
	if nonce == "" || name == "" || !base64URL256.MatchString(capability) {
		return false
	}
	if !expiryWithin(now, expiresAt, LocalProviderReloadCapabilityTTLMs) {
		return false
	}
	expected := CreateLocalProviderReloadCapability(secret, nonce, method, path, name, pid, port, expiresAt)
	if expected == "" {
		return false
	}
	return equalCapabilityBytes(expected, capability)
}

// ---------------------------------------------------------------------------
// GUI pairing (src/lib/gui-pair-capability.ts)
// ---------------------------------------------------------------------------

// CanonicalGuiBrowserOrigin mirrors canonicalGuiBrowserOrigin. It returns ""
// for values that do not canonicalise.
func CanonicalGuiBrowserOrigin(value string) string {
	if value == "" || strings.TrimSpace(value) != value {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	if parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return ""
	}
	if parsed.Scheme == "http" || parsed.Scheme == "https" {
		return whatwgOrigin(parsed)
	}
	return parsed.Scheme + "://" + parsed.Host
}

func guiPairPayload(nonce, method, path, browserOrigin string, pid int64, port int, expiresAt int64) (string, bool) {
	if !base64URL256.MatchString(nonce) || method != GUIPairMethod || path != GUIPairPath {
		return "", false
	}
	canonical := CanonicalGuiBrowserOrigin(browserOrigin)
	if canonical == "" || canonical != browserOrigin {
		return "", false
	}
	if pid <= 0 || port <= 0 || port > 65535 || expiresAt <= 0 {
		return "", false
	}
	return "opencodex-gui-pair-v1\n" + nonce + "\n" + method + "\n" + path + "\n" + browserOrigin + "\n" + itoa(pid) + "\n" + itoaInt(port) + "\n" + itoa(expiresAt), true
}

// CreateGuiPairCapability mirrors createGuiPairCapability.
func CreateGuiPairCapability(secret, nonce, method, path, browserOrigin string, pid int64, port int, expiresAt int64) string {
	if !IsAttestationSecret(secret) {
		return ""
	}
	payload, ok := guiPairPayload(nonce, method, path, browserOrigin, pid, port, expiresAt)
	if !ok {
		return ""
	}
	return hmacBase64URL(secret, payload)
}

// VerifyGuiPairCapability mirrors verifyGuiPairCapability. browserOrigin == ""
// models an absent origin header.
func VerifyGuiPairCapability(secret, nonce, method, path, browserOrigin string, pid int64, port int, expiresAt int64, capability string, now int64) bool {
	if nonce == "" || browserOrigin == "" || !base64URL256.MatchString(capability) {
		return false
	}
	if !expiryWithin(now, expiresAt, GUIPairCapabilityTTLMs) {
		return false
	}
	expected := CreateGuiPairCapability(secret, nonce, method, path, browserOrigin, pid, port, expiresAt)
	if expected == "" {
		return false
	}
	return equalCapabilityBytes(expected, capability)
}

// ---------------------------------------------------------------------------
// Local management read (src/lib/local-management-capability.ts)
// ---------------------------------------------------------------------------

func localReadPayload(nonce, method, path string, pid int64, port int, expiresAt int64) (string, bool) {
	if !base64URL256.MatchString(nonce) || method != localReadMethod {
		return "", false
	}
	if path != LocalManagementReadPathCodexAccounts && path != LocalManagementReadPathSystemMemory {
		return "", false
	}
	if pid <= 0 || port <= 0 || port > 65535 || expiresAt <= 0 {
		return "", false
	}
	return "opencodex-local-management-read-v1\n" + nonce + "\n" + method + "\n" + path + "\n" + itoa(pid) + "\n" + itoaInt(port) + "\n" + itoa(expiresAt), true
}

// CreateLocalManagementReadCapability mirrors createLocalManagementReadCapability.
func CreateLocalManagementReadCapability(secret, nonce, method, path string, pid int64, port int, expiresAt int64) string {
	if !IsAttestationSecret(secret) {
		return ""
	}
	payload, ok := localReadPayload(nonce, method, path, pid, port, expiresAt)
	if !ok {
		return ""
	}
	return hmacBase64URL(secret, payload)
}

// VerifyLocalManagementReadCapability mirrors
// verifyLocalManagementReadCapability.
func VerifyLocalManagementReadCapability(secret, nonce, method, path string, pid int64, port int, expiresAt int64, capability string, now int64) bool {
	if nonce == "" || !base64URL256.MatchString(capability) {
		return false
	}
	if !expiryWithin(now, expiresAt, LocalManagementCapabilityTTLMs) {
		return false
	}
	expected := CreateLocalManagementReadCapability(secret, nonce, method, path, pid, port, expiresAt)
	if expected == "" {
		return false
	}
	return equalCapabilityBytes(expected, capability)
}

// whatwgOrigin reproduces URL.prototype.origin for http/https: scheme plus the
// serialized host, lowercased, with the scheme's default port dropped. IPv6
// hosts keep their brackets.
func whatwgOrigin(u *url.URL) string {
	host := u.Hostname()
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	port := u.Port()
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		port = ""
	}
	if port != "" {
		host += ":" + port
	}
	return u.Scheme + "://" + strings.ToLower(host)
}

func itoa(value int64) string {
	return strconv.FormatInt(value, 10)
}

func itoaInt(value int) string {
	return strconv.FormatInt(int64(value), 10)
}

package managementauth

// Write-relay proofs bind a TypeScript front-door admission to one specific
// request the Go sidecar is allowed to send back to its private parent bridge.
// They are deliberately separate from public management credentials: the
// sidecar receives neither an admin token nor a dashboard session secret.

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"sync"
	"time"
)

const (
	// WriteRelayNonceHeader carries a fresh base64url nonce from the admitting front door.
	WriteRelayNonceHeader = "X-Ocx-Go-Sidecar-Relay-Nonce"
	// WriteRelayPrincipalHeader carries the principal the front door admitted.
	WriteRelayPrincipalHeader = "X-Ocx-Go-Sidecar-Relay-Principal"
	// WriteRelayExpiresAtHeader is a decimal epoch-millisecond deadline.
	WriteRelayExpiresAtHeader = "X-Ocx-Go-Sidecar-Relay-Expires-At"
	// WriteRelayProofHeader carries the HMAC-SHA256 relay proof.
	WriteRelayProofHeader = "X-Ocx-Go-Sidecar-Relay-Proof"
	// WriteRelayReplayLimit bounds retained consumed nonces for one sidecar process.
	WriteRelayReplayLimit = 256
)

const writeRelayTTLMillis int64 = int64(30 * time.Second / time.Millisecond)

var writeRelayNoncePattern = regexp.MustCompile("^[A-Za-z0-9_-]{43}$")

// WriteRelayProof is the header-derived assertion to verify for one body.
// Method and Path are supplied from the actual sidecar request, rather than
// trusted from a header, so a proof cannot be replayed onto another route.
type WriteRelayProof struct {
	Nonce     string
	Principal Principal
	Method    string
	Path      string
	ExpiresAt int64
	Proof     string
}

// WriteRelayVerifier owns the bounded one-use nonce table for one sidecar
// process. It is safe for concurrent requests.
type WriteRelayVerifier struct {
	mu       sync.Mutex
	secret   string
	nowFn    func() int64
	consumed map[string]int64
}

// NewWriteRelayVerifier creates a verifier over the shared private bridge
// secret. An empty secret is deliberately unusable and fails every proof.
func NewWriteRelayVerifier(secret string) *WriteRelayVerifier {
	return &WriteRelayVerifier{
		secret: secret,
		// `time.Now().UnixMilli` would bind UnixMilli to the instant at verifier
		// construction. The relay's maximum-TTL check must use the request time.
		nowFn:    func() int64 { return time.Now().UnixMilli() },
		consumed: map[string]int64{},
	}
}

// WithClock replaces the wall-clock source for deterministic tests.
func (v *WriteRelayVerifier) WithClock(now func() int64) *WriteRelayVerifier {
	v.nowFn = now
	return v
}

// ParseWriteRelayExpiry accepts the canonical decimal header form used by the
// existing local capability contracts. It rejects zero, signs, whitespace and
// overflow rather than normalising attacker-controlled input.
func ParseWriteRelayExpiry(value string) (int64, bool) { return parseExpiryHeader(value) }

// CreateWriteRelayProof signs a one-use proof. Empty means the supplied
// binding is invalid. The HMAC payload is versioned and newline-delimited:
// nonce, principal, method, path, SHA-256(body) in lowercase hex, expiry.
func CreateWriteRelayProof(secret string, proof WriteRelayProof, body []byte) string {
	if secret == "" {
		return ""
	}
	payload, ok := writeRelayPayload(proof, body)
	if !ok {
		return ""
	}
	return hmacBase64URL(secret, payload)
}

// VerifyAndConsume checks the complete proof then records its nonce before a
// caller can dispatch the parent mutation. Reusing a nonce, a changed body,
// principal, method, path or expiry all fail. Consumption happens while the
// mutex is held so concurrent requests cannot both spend one proof.
func (v *WriteRelayVerifier) VerifyAndConsume(proof WriteRelayProof, body []byte) bool {
	if v == nil || v.secret == "" || !base64URL256.MatchString(proof.Proof) {
		return false
	}
	payload, ok := writeRelayPayload(proof, body)
	if !ok {
		return false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.nowFn()
	if !expiryWithin(now, proof.ExpiresAt, writeRelayTTLMillis) {
		return false
	}
	expected := hmacBase64URL(v.secret, payload)
	if expected == "" || !equalCapabilityBytes(expected, proof.Proof) {
		return false
	}
	pruneConsumed(v.consumed, now)
	if _, replayed := v.consumed[proof.Nonce]; replayed || len(v.consumed) >= WriteRelayReplayLimit {
		return false
	}
	v.consumed[proof.Nonce] = proof.ExpiresAt
	return true
}

func writeRelayPayload(proof WriteRelayProof, body []byte) (string, bool) {
	if !writeRelayNoncePattern.MatchString(proof.Nonce) || !isWriteRelayPrincipal(proof.Principal) {
		return "", false
	}
	if !writeRelayMethodPattern.MatchString(proof.Method) || !writeRelayPathPattern.MatchString(proof.Path) || proof.ExpiresAt <= 0 {
		return "", false
	}
	digest := sha256.Sum256(body)
	return "opencodex-go-write-relay-v1\n" + proof.Nonce + "\n" + string(proof.Principal) + "\n" + proof.Method + "\n" + proof.Path + "\n" + hex.EncodeToString(digest[:]) + "\n" + itoa(proof.ExpiresAt), true
}

var (
	writeRelayMethodPattern = regexp.MustCompile("^[A-Z]+$")
	writeRelayPathPattern   = regexp.MustCompile("^/[^?#\\r\\n]*$")
)

func isWriteRelayPrincipal(principal Principal) bool {
	switch principal {
	case PrincipalAdminToken, PrincipalGuiSession, PrincipalGuiPairCapability, PrincipalLocalReadCapability, PrincipalLocalProviderReloadCapability, PrincipalSystemRestartCapability:
		return true
	default:
		return false
	}
}

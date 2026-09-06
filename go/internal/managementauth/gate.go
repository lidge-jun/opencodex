package managementauth

// The admission gate itself (ADR-0008, ticket #18): the decision ordering,
// the dashboard-session authorization, the per-principal replay control, and
// the exact rejection responses. This mirrors resolveManagementAdmission and
// requireManagementAuth in src/server/management-auth.ts plus
// authorizeGuiSessionRequest in src/server/gui-session.ts.

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"sync"
	"time"
)

// Constants shared with the TS side.
const (
	loopbackGuiSessionTTLMs = 5 * 60_000
	remoteGuiSessionTTLMs   = 12 * 60 * 60_000

	// Replay-store limits mirror the TS module-level constants.
	localReadReplayLimit      = 256
	providerReloadReplayLimit = 256
	guiPairReplayLimit        = 256

	// Header names the session/credential paths read (fixed lowercase).
	xOpenCodexAPIKeyHeader = "x-opencodex-api-key"
	authorizationHeader    = "authorization"
	guiOriginHeader        = "x-opencodex-gui-origin"
	originHeader           = "origin"
	csrfHeader             = "x-opencodex-csrf-token"
	contentLengthHeader    = "content-length"
	transferEncodingHeader = "transfer-encoding"
)

// SessionAdmissionReason mirrors the ok:false reasons of GuiSessionAdmission.
type SessionAdmissionReason string

const (
	SessionMissing       SessionAdmissionReason = "missing"
	SessionExpired       SessionAdmissionReason = "expired"
	SessionServerOrigin  SessionAdmissionReason = "server-origin"
	SessionBrowserOrigin SessionAdmissionReason = "browser-origin"
	SessionCSRF          SessionAdmissionReason = "csrf"
)

// SessionAdmission mirrors GuiSessionAdmission.
type SessionAdmission struct {
	OK      bool
	Reason  SessionAdmissionReason
	Session Session
}

// AuthorizeSession mirrors authorizeGuiSessionRequest. It may mutate the
// sessions map exactly as the TS side does: an expired session is deleted and
// a remote session's expiry slides forward on success.
func AuthorizeSession(r *Request, cfg ConfigView, sessions map[string]Session, now int64) SessionAdmission {
	credential := RequestManagementCredential(r)
	if credential == "" {
		return SessionAdmission{OK: false, Reason: SessionMissing}
	}
	token, session, found := findSession(credential, sessions)
	if !found {
		return SessionAdmission{OK: false, Reason: SessionMissing}
	}
	if session.ExpiresAt <= now {
		delete(sessions, token)
		return SessionAdmission{OK: false, Reason: SessionExpired}
	}
	if ManagementRequestOrigin(r, cfg) != session.ServerOrigin {
		return SessionAdmission{OK: false, Reason: SessionServerOrigin}
	}
	claimedBrowserOrigin := r.Get(guiOriginHeader)
	browserOrigin := r.Get(originHeader)
	safeMethod := r.Method == "GET" || r.Method == "HEAD"
	if claimedBrowserOrigin != session.BrowserOrigin ||
		(browserOrigin != "" && browserOrigin != session.BrowserOrigin) ||
		(!safeMethod && browserOrigin != session.BrowserOrigin) {
		return SessionAdmission{OK: false, Reason: SessionBrowserOrigin}
	}
	if !safeMethod {
		csrf := strings.TrimSpace(r.Get(csrfHeader))
		if csrf == "" || !EqualSecret(csrf, session.CSRF) {
			return SessionAdmission{OK: false, Reason: SessionCSRF}
		}
	}
	if session.Issuance != "loopback" {
		session.ExpiresAt = now + remoteGuiSessionTTLMs
		sessions[token] = session
	}
	return SessionAdmission{OK: true, Session: session}
}

// findSession mirrors findSession: timing-safe token comparison over the
// session table.
func findSession(credential string, sessions map[string]Session) (string, Session, bool) {
	for token, session := range sessions {
		if EqualSecret(credential, token) {
			return token, session, true
		}
	}
	return "", Session{}, false
}

// Rejection is the exact response requireManagementAuth would return: the
// status and the JSON body bytes, byte-identical to Response.json on the TS
// side (compact JSON, no trailing newline).
type Rejection struct {
	Status int
	Body   string
}

// Decision is the outcome of one admission check.
type Decision struct {
	// Principal is non-empty exactly when the request is admitted.
	Principal Principal
	// Rejection is non-nil exactly when the request is not admitted.
	Rejection *Rejection
}

// Gate carries the process-scoped admission state and replay stores. One Gate
// serves one process, mirroring the module-level maps in management-auth.ts.
// Methods are safe for concurrent use; the TS side is single-threaded, so the
// mutex only protects the Go process's own concurrency.
type Gate struct {
	mu    sync.Mutex
	state State
	cfg   ConfigView
	local LocalContext
	nowFn func() int64

	consumedLocalRead      map[string]int64
	consumedProviderReload map[string]int64
	consumedGuiPair        map[string]int64
}

// NewGate builds a Gate over the given state, config view, and local context.
func NewGate(state State, cfg ConfigView, local LocalContext) *Gate {
	if state.Sessions == nil {
		state.Sessions = map[string]Session{}
	}
	return &Gate{
		state:                  state,
		cfg:                    cfg,
		local:                  local,
		nowFn:                  time.Now().UnixMilli,
		consumedLocalRead:      map[string]int64{},
		consumedProviderReload: map[string]int64{},
		consumedGuiPair:        map[string]int64{},
	}
}

// WithClock replaces the wall-clock source (tests only).
func (g *Gate) WithClock(now func() int64) *Gate {
	g.nowFn = now
	return g
}

// State returns a copy of the admission state (tests and management routes
// that need to inspect sessions).
func (g *Gate) State() State {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := g.state
	out.Sessions = map[string]Session{}
	for k, v := range g.state.Sessions {
		out.Sessions[k] = v
	}
	return out
}

// Sessions exposes the session table for direct manipulation (session routes
// mint and revoke through the TS side pre-flip; the Go side owns it at the
// flip).
func (g *Gate) Sessions() map[string]Session {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make(map[string]Session, len(g.state.Sessions))
	for k, v := range g.state.Sessions {
		out[k] = v
	}
	return out
}

// Admit mirrors resolveManagementAdmission plus the rejection mapping of
// requireManagementAuth: capabilities first (they do not need the state to be
// available), then the admin token, then a dashboard session.
func (g *Gate) Admit(r *Request) Decision {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.nowFn()

	if g.hasSystemRestartCapability(r) {
		return Decision{Principal: PrincipalSystemRestartCapability}
	}
	if g.hasLocalProviderReloadCapability(r, now) {
		return Decision{Principal: PrincipalLocalProviderReloadCapability}
	}
	if g.hasLocalReadCapability(r, now) {
		return Decision{Principal: PrincipalLocalReadCapability}
	}
	if g.hasGuiPairCapability(r, now) {
		return Decision{Principal: PrincipalGuiPairCapability}
	}
	if g.state.Available {
		actual := RequestManagementCredential(r)
		if actual != "" && EqualSecret(actual, g.state.Token) {
			return Decision{Principal: PrincipalAdminToken}
		}
		if admission := AuthorizeSession(r, g.cfg, g.state.Sessions, now); admission.OK {
			return Decision{Principal: PrincipalGuiSession}
		}
	}
	if !g.state.Available {
		return Decision{Rejection: &Rejection{
			Status: 503,
			Body:   unavailableBody(g.state.Reason),
		}}
	}
	return Decision{Rejection: &Rejection{
		Status: 401,
		Body:   unauthorizedBody,
	}}
}

// capabilityRequestPath extracts the URL pathname, mirroring new
// URL(req.url).pathname. Empty means unparseable.
func capabilityRequestPath(r *Request) string {
	parsed := r.parsedURL()
	if parsed == nil {
		return ""
	}
	return parsed.Path
}

func hasQuery(r *Request) bool {
	parsed := r.parsedURL()
	if parsed == nil {
		return true
	}
	return parsed.RawQuery != ""
}

func (g *Gate) hasSystemRestartCapability(r *Request) bool {
	if g.local.AttestationSecret == "" || r.Method != "POST" {
		return false
	}
	path := capabilityRequestPath(r)
	if path == "" || path != SystemRestartPath {
		return false
	}
	kind, pid := ParseExpectedPID(r.Get(SystemRestartExpectedPIDHeader))
	if kind != ExpectedPIDPresent || pid != int64(g.local.PID) {
		return false
	}
	return VerifySystemRestartCapability(
		g.local.AttestationSecret,
		r.Get(SystemRestartNonceHeader),
		r.Method,
		path,
		pid,
		g.local.Port,
		r.Get(SystemRestartCapabilityHeader),
	)
}

// hasEmptyBodyRequest mirrors the TS content-length === "0" and no
// transfer-encoding preconditions on the reload and gui-pair paths.
func hasEmptyBodyRequest(r *Request) bool {
	if r.Get(contentLengthHeader) != "0" {
		return false
	}
	return r.Get(transferEncodingHeader) == ""
}

func (g *Gate) hasLocalProviderReloadCapability(r *Request, now int64) bool {
	if g.local.AttestationSecret == "" || r.Method != "POST" {
		return false
	}
	path := capabilityRequestPath(r)
	if path == "" || path != LocalProviderReloadPath {
		return false
	}
	if hasQuery(r) {
		return false
	}
	if !hasEmptyBodyRequest(r) {
		return false
	}
	kind, pid := ParseExpectedPID(r.Get(LocalProviderReloadExpectedPIDHeader))
	if kind != ExpectedPIDPresent || pid != int64(g.local.PID) {
		return false
	}
	expiresAt, ok := parseExpiryHeader(r.Get(LocalProviderReloadExpiresAtHeader))
	if !ok {
		return false
	}
	name := r.Get(LocalProviderReloadNameHeader)
	capability := r.Get(LocalProviderReloadCapabilityHeader)
	if !VerifyLocalProviderReloadCapability(
		g.local.AttestationSecret,
		r.Get(LocalProviderReloadNonceHeader),
		r.Method,
		path,
		name,
		pid,
		g.local.Port,
		expiresAt,
		capability,
		now,
	) {
		return false
	}
	pruneConsumed(g.consumedProviderReload, now)
	if capability == "" || consumedHas(g.consumedProviderReload, capability) {
		return false
	}
	if len(g.consumedProviderReload) >= providerReloadReplayLimit {
		return false
	}
	g.consumedProviderReload[capability] = expiresAt
	return true
}

func (g *Gate) hasLocalReadCapability(r *Request, now int64) bool {
	if g.local.AttestationSecret == "" || r.Method != "GET" {
		return false
	}
	path := capabilityRequestPath(r)
	if path == "" {
		return false
	}
	if hasQuery(r) {
		return false
	}
	kind, pid := ParseExpectedPID(r.Get(LocalManagementExpectedPIDHeader))
	if kind != ExpectedPIDPresent || pid != int64(g.local.PID) {
		return false
	}
	expiresAt, ok := parseExpiryHeader(r.Get(LocalManagementExpiresAtHeader))
	if !ok {
		return false
	}
	capability := r.Get(LocalManagementCapabilityHeader)
	if !VerifyLocalManagementReadCapability(
		g.local.AttestationSecret,
		r.Get(LocalManagementNonceHeader),
		r.Method,
		path,
		pid,
		g.local.Port,
		expiresAt,
		capability,
		now,
	) {
		return false
	}
	pruneConsumed(g.consumedLocalRead, now)
	if capability == "" || consumedHas(g.consumedLocalRead, capability) {
		return false
	}
	if len(g.consumedLocalRead) >= localReadReplayLimit {
		return false
	}
	g.consumedLocalRead[capability] = expiresAt
	return true
}

func (g *Gate) hasGuiPairCapability(r *Request, now int64) bool {
	if g.local.AttestationSecret == "" || r.Method != "POST" {
		return false
	}
	path := capabilityRequestPath(r)
	if path == "" || path != GUIPairPath {
		return false
	}
	if hasQuery(r) {
		return false
	}
	if !hasEmptyBodyRequest(r) {
		return false
	}
	kind, pid := ParseExpectedPID(r.Get(GUIPairExpectedPIDHeader))
	if kind != ExpectedPIDPresent || pid != int64(g.local.PID) {
		return false
	}
	expiresAt, ok := parseExpiryHeader(r.Get(GUIPairExpiresAtHeader))
	if !ok {
		return false
	}
	capability := r.Get(GUIPairCapabilityHeader)
	if !VerifyGuiPairCapability(
		g.local.AttestationSecret,
		r.Get(GUIPairNonceHeader),
		r.Method,
		path,
		r.Get(GUIPairBrowserOriginHeader),
		pid,
		g.local.Port,
		expiresAt,
		capability,
		now,
	) {
		return false
	}
	pruneConsumed(g.consumedGuiPair, now)
	if capability == "" {
		return false
	}
	digest := sha256Base64URL(capability)
	if consumedHas(g.consumedGuiPair, digest) {
		return false
	}
	if len(g.consumedGuiPair) >= guiPairReplayLimit {
		return false
	}
	g.consumedGuiPair[digest] = expiresAt
	return true
}

func pruneConsumed(store map[string]int64, now int64) {
	for consumed, retainedUntil := range store {
		if retainedUntil <= now {
			delete(store, consumed)
		}
	}
}

func consumedHas(store map[string]int64, key string) bool {
	_, ok := store[key]
	return ok
}

// sha256Base64URL mirrors the SHA-256 base64url digest the TS side uses to key
// the gui-pair replay store.
func sha256Base64URL(value string) string {
	sum := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// unauthorizedBody is the exact 401 body requireManagementAuth returns.
const unauthorizedBody = `{"error":"opencodex admin token required"}`

// unavailableBody is the exact 503 body for an unavailable management state;
// the reason string is JSON-escaped the way Response.json escapes it.
func unavailableBody(reason string) string {
	escaped := strings.ReplaceAll(reason, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	return `{"error":"management API unavailable","reason":"` + escaped + `","hint":"Set OPENCODEX_ADMIN_AUTH_TOKEN to bypass file-backed admin token ACL hardening"}`
}

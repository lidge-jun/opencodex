// Package managementauth reproduces the TypeScript management admission
// model (ADR-0008, ticket #18: "Go management auth/session model").
//
// src/server/management-auth.ts decides whether a management request is
// admitted and under which principal: a process-scoped capability
// (system-restart, local-provider-reload, local-read, gui-pair), the admin
// token, or a dashboard session. This package mirrors that decision logic so a
// request answered by Go without the TypeScript front door having already
// admitted it is authorised identically — the acceptance criterion is
// "under-privileged requests rejected identically to TypeScript", and the
// differential oracle (tests/go-auth-parity.test.ts) proves it by running the
// same request vectors through src/server/management-auth.ts and this package
// and comparing the resulting principal-or-rejection byte for byte.
//
// State-source note: the four capability checks are pure functions of their
// inputs (request headers, the local context's attestation secret/pid/port);
// the admin token is env/disk state; the dashboard session table is owned by
// whatever process mints sessions. The TS front door still admits every
// request before forwarding pre-flip (src/server/index.ts), so this gate is
// exercised live only once Go serves management routes without that front door
// (the write batches' state-reset differential and the authorization gate,
// tickets #21-#23/#26). Until then it is substrate, proven by the oracle.
package managementauth

// Principal mirrors ManagementPrincipal in src/server/management-auth.ts.
type Principal string

const (
	// PrincipalAdminToken is the raw token from disk/env.
	PrincipalAdminToken Principal = "admin-token"
	// PrincipalGuiSession is a session token this process minted for a browser.
	PrincipalGuiSession Principal = "gui-session"
	// PrincipalGuiPairCapability is a process-scoped HMAC for the pairing-grant path.
	PrincipalGuiPairCapability Principal = "gui-pair-capability"
	// PrincipalLocalReadCapability is a process-scoped HMAC for two allowlisted GETs.
	PrincipalLocalReadCapability Principal = "local-read-capability"
	// PrincipalLocalProviderReloadCapability is a process-scoped HMAC for the reload POST.
	PrincipalLocalProviderReloadCapability Principal = "local-provider-reload-capability"
	// PrincipalSystemRestartCapability is a process-scoped HMAC for the restart POST.
	PrincipalSystemRestartCapability Principal = "system-restart-capability"
)

// Session mirrors GuiSessionRecord in src/server/gui-session.ts.
type Session struct {
	ServerOrigin  string
	BrowserOrigin string
	CSRF          string
	ExpiresAt     int64 // epoch milliseconds
	Issuance      string
}

// State mirrors ManagementAuthState in src/server/management-auth.ts. Sessions
// are owned by the process that mints them; the Go gate carries the table so
// validation mutates it the way the TypeScript side does (expiry deletion,
// remote-session sliding).
type State struct {
	Available bool
	Token     string
	Source    string // "environment" | "file"
	Reason    string // set when !Available
	Sessions  map[string]Session
}

// LocalContext mirrors LocalManagementAuthContext: the process-scoped
// attestation secret, pid, and listening port that capability HMACs bind to.
type LocalContext struct {
	AttestationSecret string
	PID               int
	Port              int
}

// ConfigView is the slice of OcxConfig that the admission logic reads
// (config.hostname via isApiAuthRequired, runtimeRole and
// hub.managementPublicOrigin via managementRequestOrigin). Everything else is
// irrelevant to validation; see src/server/auth-cors.ts.
type ConfigView struct {
	Hostname                  string
	RuntimeRole               string
	HubManagementPublicOrigin string
}

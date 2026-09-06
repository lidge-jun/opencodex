package managementauth

import (
	"os"
	"path/filepath"
	"testing"
)

// Fixed clock base for deterministic expiry/replay tests. Values mirror what
// the TS side calls now: epoch milliseconds.
const testNow = 1_800_000_000_000

func testGate(t *testing.T, state State, cfg ConfigView) *Gate {
	t.Helper()
	gate := NewGate(state, cfg, LocalContext{
		AttestationSecret: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
		PID:               4242,
		Port:              10100,
	})
	return gate.WithClock(func() int64 { return testNow })
}

func req(method, rawURL string, headers map[string]string) *Request {
	lower := make(map[string]string, len(headers))
	for name, value := range headers {
		lower[lowerHeader(name)] = value
	}
	return &Request{URL: rawURL, Method: method, Header: lower}
}

func lowerHeader(name string) string {
	out := make([]byte, 0, len(name))
	for i := 0; i < len(name); i++ {
		c := name[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out = append(out, c)
	}
	return string(out)
}

func availableState(token string) State {
	return State{Available: true, Token: token, Source: "environment", Sessions: map[string]Session{}}
}

func TestBase64URLAndSecretShape(t *testing.T) {
	if !IsBase64URL256("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG") {
		t.Fatal("43-char base64url secret must be valid")
	}
	if IsBase64URL256("short") || IsBase64URL256("not+valid/forty3chars") {
		t.Fatal("invalid base64url shapes must be rejected")
	}
	if !IsAttestationSecret("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG") {
		t.Fatal("attestation secret shape check must accept a 43-char base64url value")
	}
	if !EqualSecret("ocx_admin_x", "ocx_admin_x") {
		t.Fatal("equal secrets must compare equal")
	}
	if EqualSecret("ocx_admin_x", "ocx_admin_y") || EqualSecret("a", "ab") {
		t.Fatal("unequal secrets must compare unequal")
	}
}

func TestParseExpectedPID(t *testing.T) {
	cases := []struct {
		value string
		kind  ExpectedPIDKind
		pid   int64
	}{
		{"", ExpectedPIDAbsent, 0},
		{"0", ExpectedPIDInvalid, 0},
		{"007", ExpectedPIDInvalid, 0},
		{"-1", ExpectedPIDInvalid, 0},
		{"4242", ExpectedPIDPresent, 4242},
		{"1", ExpectedPIDPresent, 1},
		{"1.5", ExpectedPIDInvalid, 0},
		{"abc", ExpectedPIDInvalid, 0},
	}
	for _, c := range cases {
		kind, pid := ParseExpectedPID(c.value)
		if kind != c.kind || pid != c.pid {
			t.Errorf("ParseExpectedPID(%q) = (%s, %d), want (%s, %d)", c.value, kind, pid, c.kind, c.pid)
		}
	}
}

func TestCapabilityRoundTrips(t *testing.T) {
	secret := "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
	nonce := "GFEDCBA9876543210zyxwvutsrqponmlkjihgfedcba"
	pid := int64(4242)
	port := 10100
	now := int64(testNow)
	expiresAt := now + 5_000

	if len(nonce) != 43 {
		t.Fatalf("nonce fixture must be 43 chars, got %d", len(nonce))
	}

	// System restart: no expiry window; any time verifies.
	cap := CreateSystemRestartCapability(secret, nonce, SystemRestartMethod, SystemRestartPath, pid, port)
	if cap == "" {
		t.Fatal("restart capability must mint")
	}
	if !VerifySystemRestartCapability(secret, nonce, SystemRestartMethod, SystemRestartPath, pid, port, cap) {
		t.Fatal("restart capability must verify")
	}
	if VerifySystemRestartCapability(secret, nonce, "PUT", SystemRestartPath, pid, port, cap) {
		t.Fatal("restart capability for a different method must not verify")
	}
	if VerifySystemRestartCapability(secret, nonce, SystemRestartMethod, SystemRestartPath, pid, port, cap+"A") {
		t.Fatal("tampered restart capability must not verify")
	}

	// Local read: TTL window enforced.
	readCap := CreateLocalManagementReadCapability(secret, nonce, "GET", LocalManagementReadPathSystemMemory, pid, port, expiresAt)
	if readCap == "" {
		t.Fatal("read capability must mint")
	}
	if !VerifyLocalManagementReadCapability(secret, nonce, "GET", LocalManagementReadPathSystemMemory, pid, port, expiresAt, readCap, now) {
		t.Fatal("read capability must verify within its TTL")
	}
	if VerifyLocalManagementReadCapability(secret, nonce, "GET", LocalManagementReadPathSystemMemory, pid, port, expiresAt, readCap, expiresAt+1) {
		t.Fatal("read capability must not verify after expiry")
	}
	if VerifyLocalManagementReadCapability(secret, nonce, "GET", LocalManagementReadPathSystemMemory, pid, port, expiresAt, readCap, now+LocalManagementCapabilityTTLMs+1) {
		t.Fatal("read capability must not verify beyond the TTL ceiling")
	}
	if VerifyLocalManagementReadCapability(secret, nonce, "GET", "/api/system/memory/", pid, port, expiresAt, readCap, now) {
		t.Fatal("read capability for a non-allowlisted path must not verify")
	}
	if VerifyLocalManagementReadCapability(secret, nonce, "GET", "/api/system/memory", pid, port, expiresAt, "", now) {
		t.Fatal("missing capability must not verify")
	}

	// Provider reload: name binding.
	reloadCap := CreateLocalProviderReloadCapability(secret, nonce, LocalProviderReloadMethod, LocalProviderReloadPath, "openai", pid, port, expiresAt)
	if reloadCap == "" {
		t.Fatal("reload capability must mint")
	}
	if !VerifyLocalProviderReloadCapability(secret, nonce, LocalProviderReloadMethod, LocalProviderReloadPath, "openai", pid, port, expiresAt, reloadCap, now) {
		t.Fatal("reload capability must verify")
	}
	if VerifyLocalProviderReloadCapability(secret, nonce, LocalProviderReloadMethod, LocalProviderReloadPath, "other", pid, port, expiresAt, reloadCap, now) {
		t.Fatal("reload capability for another provider name must not verify")
	}
	if CreateLocalProviderReloadCapability(secret, nonce, LocalProviderReloadMethod, LocalProviderReloadPath, "not valid!", pid, port, expiresAt) != "" {
		t.Fatal("reload capability with an invalid provider name must not mint")
	}

	// GUI pair: browser-origin canonicalisation is part of the payload.
	guiCap := CreateGuiPairCapability(secret, nonce, GUIPairMethod, GUIPairPath, "https://ocx.example", pid, port, expiresAt)
	if guiCap == "" {
		t.Fatal("gui-pair capability must mint")
	}
	if !VerifyGuiPairCapability(secret, nonce, GUIPairMethod, GUIPairPath, "https://ocx.example", pid, port, expiresAt, guiCap, now) {
		t.Fatal("gui-pair capability must verify")
	}
	if VerifyGuiPairCapability(secret, nonce, GUIPairMethod, GUIPairPath, "https://ocx.example:443", pid, port, expiresAt, guiCap, now) {
		t.Fatal("gui-pair capability payload binds the canonical origin; default-port spelling must not verify")
	}
	if got := CreateGuiPairCapability(secret, nonce, GUIPairMethod, GUIPairPath, "https://ocx.example:443", pid, port, expiresAt); got != "" {
		t.Fatalf("minting with a non-canonical origin must be refused, got %q", got)
	}

	// Attestation proof.
	proof := CreateLocalAttestationProof(secret, "QAZWSXEDCRFVTGBYHNUJMIKOLPqazwsxedcrfvtgbay", pid, port)
	if proof == "" {
		t.Fatal("attestation proof must mint")
	}
	if !VerifyLocalAttestationProof(secret, "QAZWSXEDCRFVTGBYHNUJMIKOLPqazwsxedcrfvtgbay", pid, port, proof) {
		t.Fatal("attestation proof must verify")
	}
}

func TestCanonicalGuiBrowserOrigin(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://ocx.example", "https://ocx.example"},
		{"https://ocx.example:443", "https://ocx.example"},
		{"http://ocx.example:8080", "http://ocx.example:8080"},
		{"http://localhost:10100", "http://localhost:10100"},
		{"https://ocx.example/", "https://ocx.example"},
		{"https://ocx.example/path", ""},
		{"https://user:pass@ocx.example", ""},
		{"https://ocx.example?q=1", ""},
		{"https://ocx.example#f", ""},
		{" not-trimmed ", ""},
		{"chrome-extension://abc", "chrome-extension://abc"},
		{"file:///etc/hosts", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := CanonicalGuiBrowserOrigin(c.in); got != c.want {
			t.Errorf("CanonicalGuiBrowserOrigin(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestManagementRequestOrigin(t *testing.T) {
	loopback := ConfigView{Hostname: "127.0.0.1"}
	remote := ConfigView{Hostname: "0.0.0.0"}
	hub := ConfigView{Hostname: "0.0.0.0", RuntimeRole: "hub", HubManagementPublicOrigin: "https://ocx.example"}

	cases := []struct {
		name string
		r    *Request
		cfg  ConfigView
		want string
	}{
		{
			name: "loopback observed origin with port",
			r:    req("GET", "http://127.0.0.1:10100/api/config", map[string]string{"Host": "127.0.0.1:10100"}),
			cfg:  loopback,
			want: "http://127.0.0.1:10100",
		},
		{
			name: "loopback default port dropped",
			r:    req("GET", "http://localhost/api/config", map[string]string{"Host": "localhost"}),
			cfg:  loopback,
			want: "http://localhost",
		},
		{
			name: "localhost trailing dot is loopback",
			r:    req("GET", "http://localhost.:10100/api/config", map[string]string{"Host": "localhost.:10100"}),
			cfg:  loopback,
			want: "http://localhost.:10100",
		},
		{
			name: "non-loopback without api auth has no origin",
			r:    req("GET", "http://mynode.lan:10100/api/config", map[string]string{"Host": "mynode.lan:10100"}),
			cfg:  ConfigView{Hostname: "localhost"},
			want: "",
		},
		{
			name: "non-loopback observed origin when api auth required",
			r:    req("GET", "http://mynode.lan:10100/api/config", map[string]string{"Host": "mynode.lan:10100"}),
			cfg:  remote,
			want: "http://mynode.lan:10100",
		},
		{
			name: "hub uses its configured public origin",
			r:    req("GET", "http://10.0.0.5:10100/api/config", map[string]string{"Host": "10.0.0.5:10100"}),
			cfg:  hub,
			want: "https://ocx.example",
		},
		{
			name: "missing host header has no origin",
			r:    req("GET", "http://127.0.0.1:10100/api/config", nil),
			cfg:  loopback,
			want: "",
		},
	}
	for _, c := range cases {
		if got := ManagementRequestOrigin(c.r, c.cfg); got != c.want {
			t.Errorf("%s: origin = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestAdminTokenAdmission(t *testing.T) {
	token := "ocx_admin_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
	gate := testGate(t, availableState(token), ConfigView{Hostname: "127.0.0.1"})

	// Correct token via the API-key header.
	decision := gate.Admit(req("GET", "http://127.0.0.1:10100/api/config", map[string]string{
		"x-opencodex-api-key": token,
		"host":                "127.0.0.1:10100",
	}))
	if decision.Principal != PrincipalAdminToken {
		t.Fatalf("correct token must admit as admin-token, got %q (rejection %+v)", decision.Principal, decision.Rejection)
	}

	// Wrong token, state available -> 401 with the exact TS body.
	decision = gate.Admit(req("GET", "http://127.0.0.1:10100/api/config", map[string]string{
		"authorization": "Bearer wrong-token",
		"host":          "127.0.0.1:10100",
	}))
	if decision.Rejection == nil || decision.Rejection.Status != 401 {
		t.Fatalf("wrong token must be rejected with 401, got %+v", decision.Rejection)
	}
	if decision.Rejection.Body != `{"error":"opencodex admin token required"}` {
		t.Fatalf("401 body = %q", decision.Rejection.Body)
	}

	// Bearer stripping is case-insensitive and whitespace-trimmed.
	decision = gate.Admit(req("GET", "http://127.0.0.1:10100/api/config", map[string]string{
		"authorization": "bearer  " + token + "  ",
		"host":          "127.0.0.1:10100",
	}))
	if decision.Principal != PrincipalAdminToken {
		t.Fatalf("bearer-prefixed token must admit, got %q", decision.Principal)
	}

	// Unavailable state -> 503 with reason and hint.
	unavailable := State{Available: false, Reason: "management token initialization failed"}
	decision = testGate(t, unavailable, ConfigView{Hostname: "127.0.0.1"}).Admit(
		req("GET", "http://127.0.0.1:10100/api/config", nil),
	)
	if decision.Rejection == nil || decision.Rejection.Status != 503 {
		t.Fatalf("unavailable state must reject with 503, got %+v", decision.Rejection)
	}
	want := `{"error":"management API unavailable","reason":"management token initialization failed","hint":"Set OPENCODEX_ADMIN_AUTH_TOKEN to bypass file-backed admin token ACL hardening"}`
	if decision.Rejection.Body != want {
		t.Fatalf("503 body:\n got %q\nwant %q", decision.Rejection.Body, want)
	}
}

func TestCapabilityAdmissionOrderAndReplay(t *testing.T) {
	state := availableState("ocx_admin_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")
	secret := "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
	local := LocalContext{AttestationSecret: secret, PID: 4242, Port: 10100}
	gate := NewGate(state, ConfigView{Hostname: "127.0.0.1"}, local).WithClock(func() int64 { return testNow })
	expiresAt := int64(testNow + 5_000)
	nonce := "GFEDCBA9876543210zyxwvutsrqponmlkjihgfedcba"

	// A valid local-read capability admits with the capability principal even
	// though the admin token is wrong on the request.
	cap := CreateLocalManagementReadCapability(secret, nonce, "GET", LocalManagementReadPathCodexAccounts, 4242, 10100, expiresAt)
	r := req("GET", "http://127.0.0.1:10100/api/codex-auth/accounts", map[string]string{
		"host":                           "127.0.0.1:10100",
		LocalManagementExpectedPIDHeader: "4242",
		LocalManagementNonceHeader:       nonce,
		LocalManagementExpiresAtHeader:   "1800000005000",
		LocalManagementCapabilityHeader:  cap,
	})
	decision := gate.Admit(r)
	if decision.Principal != PrincipalLocalReadCapability {
		t.Fatalf("capability must admit ahead of the token check, got %q", decision.Principal)
	}

	// A second, distinct request with the same capability is a replay and must
	// be rejected exactly like the TS consumed-capability store rejects it.
	replay := req("GET", "http://127.0.0.1:10100/api/codex-auth/accounts", map[string]string{
		"host":                           "127.0.0.1:10100",
		LocalManagementExpectedPIDHeader: "4242",
		LocalManagementNonceHeader:       nonce,
		LocalManagementExpiresAtHeader:   "1800000005000",
		LocalManagementCapabilityHeader:  cap,
	})
	decision = gate.Admit(replay)
	if decision.Principal != "" || decision.Rejection == nil || decision.Rejection.Status != 401 {
		t.Fatalf("replayed capability must be rejected with 401, got %+v", decision)
	}

	// Wrong expected pid never reaches verification.
	wrongPid := req("GET", "http://127.0.0.1:10100/api/codex-auth/accounts", map[string]string{
		LocalManagementExpectedPIDHeader: "1",
		LocalManagementCapabilityHeader:  cap,
	})
	if decision := gate.Admit(wrongPid); decision.Principal != "" {
		t.Fatalf("wrong expected pid must reject, got %q", decision.Principal)
	}

	// A query string disqualifies the narrow local-read grant.
	withQuery := req("GET", "http://127.0.0.1:10100/api/codex-auth/accounts?x=1", map[string]string{
		LocalManagementExpectedPIDHeader: "4242",
	})
	if decision := gate.Admit(withQuery); decision.Principal != "" {
		t.Fatalf("query-bearing local read must reject, got %q", decision.Principal)
	}

	// Non-POST never matches the gui-pair path.
	pairCap := CreateGuiPairCapability(secret, nonce, GUIPairMethod, GUIPairPath, "http://localhost:5173", 4242, 10100, expiresAt)
	pairReq := req("GET", "http://127.0.0.1:10100/api/gui/pairing-grants", map[string]string{
		GUIPairExpectedPIDHeader:   "4242",
		GUIPairCapabilityHeader:    pairCap,
		GUIPairBrowserOriginHeader: "http://localhost:5173",
		GUIPairExpiresAtHeader:     "1800000005000",
		GUIPairNonceHeader:         nonce,
		"content-length":           "0",
	})
	if decision := gate.Admit(pairReq); decision.Principal != "" {
		t.Fatalf("GET on the gui-pair POST path must reject, got %q", decision.Principal)
	}
}

func TestSessionAuthorization(t *testing.T) {
	state := availableState("ocx_admin_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")
	cfg := ConfigView{Hostname: "127.0.0.1"}
	gate := testGate(t, state, cfg)

	// Mint a session the way the TS side does (loopback issuance records the
	// observed origin as both server and browser origin).
	mint := req("GET", "http://127.0.0.1:10100/api/session/bootstrap", map[string]string{"host": "127.0.0.1:10100"})
	serverOrigin := ManagementRequestOrigin(mint, cfg)
	if serverOrigin != "http://127.0.0.1:10100" {
		t.Fatalf("fixture origin = %q", serverOrigin)
	}
	token := "ocx_session_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	session := Session{
		ServerOrigin:  serverOrigin,
		BrowserOrigin: serverOrigin,
		CSRF:          "csrf-token-value-1234567890123456789012345",
		ExpiresAt:     testNow + loopbackGuiSessionTTLMs,
		Issuance:      "loopback",
	}
	sessions := map[string]Session{token: session}
	gate.state.Sessions = sessions

	// A safe GET with the session token and matching origin admits.
	good := req("GET", "http://127.0.0.1:10100/api/config", map[string]string{
		"host":                   "127.0.0.1:10100",
		"x-opencodex-api-key":    token,
		"x-opencodex-gui-origin": serverOrigin,
	})
	decision := gate.Admit(good)
	if decision.Principal != PrincipalGuiSession {
		t.Fatalf("valid session GET must admit as gui-session, got %q", decision.Principal)
	}

	// An unsafe POST without the CSRF token rejects with the exact reason.
	mutation := req("POST", "http://127.0.0.1:10100/api/config", map[string]string{
		"host":                   "127.0.0.1:10100",
		"x-opencodex-api-key":    token,
		"origin":                 serverOrigin,
		"x-opencodex-gui-origin": serverOrigin,
	})
	admission := AuthorizeSession(mutation, cfg, sessions, testNow)
	if admission.OK || admission.Reason != SessionCSRF {
		t.Fatalf("unsafe session mutation without CSRF must reject with csrf reason, got %+v", admission)
	}
	if decision := gate.Admit(mutation); decision.Principal != "" {
		t.Fatalf("session mutation without CSRF must not admit, got %q", decision.Principal)
	}

	// With the correct CSRF header it admits.
	withCSRF := req("POST", "http://127.0.0.1:10100/api/config", map[string]string{
		"host":                   "127.0.0.1:10100",
		"x-opencodex-api-key":    token,
		"origin":                 serverOrigin,
		"x-opencodex-gui-origin": serverOrigin,
		"x-opencodex-csrf-token": session.CSRF,
	})
	if decision := gate.Admit(withCSRF); decision.Principal != PrincipalGuiSession {
		t.Fatalf("session mutation with CSRF must admit, got %q", decision.Principal)
	}

	// A mismatched browser origin rejects.
	mismatched := req("GET", "http://127.0.0.1:10100/api/config", map[string]string{
		"host":                   "127.0.0.1:10100",
		"x-opencodex-api-key":    token,
		"x-opencodex-gui-origin": "http://evil.example",
	})
	if decision := gate.Admit(mismatched); decision.Principal != "" {
		t.Fatalf("mismatched browser origin must reject, got %q", decision.Principal)
	}

	// An expired session deletes and rejects.
	expiredToken := "ocx_session_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
	sessions[expiredToken] = Session{
		ServerOrigin:  serverOrigin,
		BrowserOrigin: serverOrigin,
		CSRF:          "x",
		ExpiresAt:     testNow - 1,
		Issuance:      "loopback",
	}
	expired := req("GET", "http://127.0.0.1:10100/api/config", map[string]string{
		"host":                "127.0.0.1:10100",
		"x-opencodex-api-key": expiredToken,
	})
	admission = AuthorizeSession(expired, cfg, sessions, testNow)
	if admission.OK || admission.Reason != SessionExpired {
		t.Fatalf("expired session must reject with expired reason, got %+v", admission)
	}
	if _, stillPresent := sessions[expiredToken]; stillPresent {
		t.Fatal("expired session must be deleted from the table")
	}
}

func TestAdminTokenFileLoad(t *testing.T) {
	dir := t.TempDir()
	valid := "ocx_admin_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"

	t.Run("missing file yields no token", func(t *testing.T) {
		if got := LoadAdminToken(dir); got != "" {
			t.Fatalf("missing token file must load no token, got %q", got)
		}
	})

	t.Run("valid file loads", func(t *testing.T) {
		path := AdminTokenFilePath(dir)
		if err := os.WriteFile(path, []byte(valid+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := LoadAdminToken(dir); got != valid {
			t.Fatalf("valid token file must load, got %q", got)
		}
	})

	t.Run("malformed content yields no token", func(t *testing.T) {
		sub := t.TempDir()
		path := filepath.Join(sub, "admin-api-token")
		if err := os.WriteFile(path, []byte("not-a-token\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := LoadAdminToken(sub); got != "" {
			t.Fatalf("malformed token file must load no token, got %q", got)
		}
	})

	t.Run("oversized file yields no token", func(t *testing.T) {
		sub := t.TempDir()
		path := filepath.Join(sub, "admin-api-token")
		big := make([]byte, 600)
		for i := range big {
			big[i] = 'a'
		}
		if err := os.WriteFile(path, big, 0o600); err != nil {
			t.Fatal(err)
		}
		if got := LoadAdminToken(sub); got != "" {
			t.Fatalf("oversized token file must load no token, got %q", got)
		}
	})
}

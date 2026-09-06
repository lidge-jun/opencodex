package ocxcli

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/managementauth"
	_ "modernc.org/sqlite"
)

const doctorSystemMemoryPath = "/api/system/memory"
const doctorCodexAccountsPath = "/api/codex-auth/accounts"

type DoctorManagementReader struct {
	Runtime RuntimeState
	Client  *http.Client
	Now     func() time.Time
	Nonce   func() (string, error)
}

func doctorManagementNonce() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func (r DoctorManagementReader) Get(ctx context.Context, path string) (*http.Response, error) {
	if r.Runtime.PID <= 0 || r.Runtime.Port < 1 || r.Runtime.Port > 65535 || !managementauth.IsAttestationSecret(r.Runtime.AttestationSecret) {
		return nil, errors.New("unattested target")
	}
	nonceFn := r.Nonce
	if nonceFn == nil {
		nonceFn = doctorManagementNonce
	}
	nonce, err := nonceFn()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	if r.Now != nil {
		now = r.Now()
	}
	expires := now.Add(10 * time.Second).UnixMilli()
	cap := managementauth.CreateLocalManagementReadCapability(r.Runtime.AttestationSecret, nonce, http.MethodGet, path, r.Runtime.PID, r.Runtime.Port, expires)
	if cap == "" {
		return nil, errors.New("capability unavailable")
	}
	host := strings.Trim(r.Runtime.Hostname, "[] ")
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://%s:%d%s", host, r.Runtime.Port, path), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set(managementauth.LocalManagementExpectedPIDHeader, fmt.Sprint(r.Runtime.PID))
	req.Header.Set(managementauth.LocalManagementNonceHeader, nonce)
	req.Header.Set(managementauth.LocalManagementExpiresAtHeader, fmt.Sprint(expires))
	req.Header.Set(managementauth.LocalManagementCapabilityHeader, cap)
	c := r.Client
	if c == nil {
		c = &http.Client{Timeout: 2 * time.Second}
	}
	return c.Do(req)
}

func FetchDoctorServiceMemory(ctx context.Context, r DoctorManagementReader) DoctorServiceMemoryReport {
	response, err := r.Get(ctx, doctorSystemMemoryPath)
	if err != nil {
		return DoctorServiceMemoryReport{Status: "unreachable", Error: "fetch failed"}
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return DoctorServiceMemoryReport{Status: "unauthorized"}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return DoctorServiceMemoryReport{Status: "unreachable", Error: fmt.Sprintf("http %d", response.StatusCode)}
	}
	var body struct {
		PID                                                  int
		BunVersion                                           string
		Platform                                             string
		RSS, HeapUsed, External, ArrayBuffers, ObservedBytes int64
		ObservedMetric, StreamMode                           string
	}
	if json.NewDecoder(response.Body).Decode(&body) != nil || body.PID != int(r.Runtime.PID) || body.BunVersion == "" {
		return DoctorServiceMemoryReport{Status: "unreachable", Error: "malformed response"}
	}
	return DoctorServiceMemoryReport{Status: "ok", Data: DoctorServiceMemoryData{PID: body.PID, BunVersion: body.BunVersion, Platform: body.Platform, RSS: body.RSS, HeapUsed: body.HeapUsed, External: body.External, ArrayBuffers: body.ArrayBuffers, ObservedBytes: body.ObservedBytes, ObservedMetric: body.ObservedMetric, StreamMode: body.StreamMode}}
}

type DoctorOAuthHealthSource string

const (
	DoctorOAuthManagementAPI  DoctorOAuthHealthSource = "management-api"
	DoctorOAuthUnavailable    DoctorOAuthHealthSource = "unavailable"
	DoctorOAuthAuthFailed     DoctorOAuthHealthSource = "management-auth-failed"
	DoctorOAuthAPIUnavailable DoctorOAuthHealthSource = "management-api-unavailable"
)

type DoctorOAuthAccount struct {
	ID, Status, Reason, Until string
	NeedsReauth               bool
}

func doctorMaskAccountID(id string) string {
	id = strings.TrimSpace(id)
	if id == "" || len(id) <= 4 {
		return "account-…"
	}
	return "account-…" + id[len(id)-4:]
}

func FormatDoctorOAuthLive(source DoctorOAuthHealthSource, accounts []DoctorOAuthAccount) []string {
	lines := []string{"OAuth reliability"}
	switch source {
	case DoctorOAuthUnavailable:
		lines = append(lines, "  [WARN] Codex account health unavailable (proxy not running). Action: start the proxy and re-run \x60ocx doctor\x60 to inspect live cooldown/reauth")
	case DoctorOAuthAuthFailed:
		lines = append(lines, "  [WARN] Codex account health unavailable (proxy running; management authentication failed). Action: verify the admin token configuration, restart the proxy, and re-run \x60ocx doctor\x60")
	case DoctorOAuthAPIUnavailable:
		lines = append(lines, "  [WARN] Codex account health unavailable (proxy running; management API response failed). Action: inspect the proxy service log, restart the proxy if needed, and re-run \x60ocx doctor\x60")
	}
	for _, account := range accounts {
		if account.Status == "healthy" {
			continue
		}
		masked := doctorMaskAccountID(account.ID)
		switch account.Status {
		case "reauth_required":
			lines = append(lines, "  [WARN] Account "+masked+" requires reauthentication. Action: reauthenticate via the dashboard Codex account pool")
		case "cooldown":
			prefix := "quota limited"
			if account.Reason == "rate_limit" {
				prefix = "rate limited"
			}
			lines = append(lines, "  [WARN] Account "+masked+" is "+prefix+" until "+account.Until+". Action: wait until "+account.Until+" or start a new session with another eligible account")
		case "warning":
			detail := strings.ReplaceAll(account.Reason, "_", " ")
			if detail == "" {
				detail = "unhealthy"
			}
			lines = append(lines, "  [WARN] Account "+masked+" has a "+detail+". Action: reauthenticate via the dashboard Codex account pool")
		}
	}
	return append(lines, "  [OK] Codex forward path uses pass-through client metadata (build-time invariant; not a runtime scan).")
}

func CollectDoctorLiveCodexAccounts(ctx context.Context, r *DoctorManagementReader) (DoctorOAuthHealthSource, []DoctorOAuthAccount) {
	if r == nil {
		return DoctorOAuthUnavailable, nil
	}
	response, err := r.Get(ctx, doctorCodexAccountsPath)
	if err != nil {
		return DoctorOAuthAPIUnavailable, nil
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return DoctorOAuthAuthFailed, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return DoctorOAuthAPIUnavailable, nil
	}
	var body struct {
		Accounts []struct {
			ID          string
			NeedsReauth bool
			Health      struct{ Status, Reason, Until string }
		}
	}
	if json.NewDecoder(response.Body).Decode(&body) != nil || body.Accounts == nil {
		return DoctorOAuthAPIUnavailable, nil
	}
	accounts := make([]DoctorOAuthAccount, 0, len(body.Accounts))
	for _, a := range body.Accounts {
		if a.ID == "" {
			continue
		}
		status := a.Health.Status
		if status != "healthy" && status != "cooldown" && status != "reauth_required" && status != "warning" {
			if a.NeedsReauth {
				status, a.Health.Reason = "reauth_required", "refresh_failed"
			} else {
				status = "healthy"
			}
		}
		accounts = append(accounts, DoctorOAuthAccount{a.ID, status, a.Health.Reason, a.Health.Until, a.NeedsReauth})
	}
	return DoctorOAuthManagementAPI, accounts
}

type DoctorCatalogProbe struct {
	PIDs              []int
	Starts            map[int]*time.Time
	CatalogMtime      *time.Time
	EnumerationFailed bool
}

func CollectDoctorCatalogState(p DoctorCatalogProbe) DoctorCatalogState {
	if len(p.PIDs) == 0 {
		if p.EnumerationFailed {
			return DoctorCatalogState{State: "unknown"}
		}
		return DoctorCatalogState{State: "not_running"}
	}
	if p.CatalogMtime == nil {
		return DoctorCatalogState{State: "unknown"}
	}
	for _, pid := range p.PIDs {
		s := p.Starts[pid]
		if s == nil {
			return DoctorCatalogState{State: "unknown"}
		}
		if !s.After(*p.CatalogMtime) {
			return DoctorCatalogState{State: "stale", PIDs: append([]int(nil), p.PIDs...)}
		}
	}
	return DoctorCatalogState{State: "fresh", PIDs: append([]int(nil), p.PIDs...)}
}

type DoctorHistoryPending struct {
	PendingRows, BackupEntries int
	Failed                     bool
	FailureReason              string
}

func DoctorHistoryBackupPath(stateDB, home string) string {
	p, err := filepath.Abs(stateDB)
	if err != nil {
		p = stateDB
	}
	if os.PathSeparator == '\\' {
		p = strings.ToLower(p)
	}
	sum := sha256.Sum256([]byte(p))
	return filepath.Join(home, fmt.Sprintf("codex-history-backup-%x.json", sum[:8]))
}
func CollectDoctorHistoryPending(stateDB, backup string) DoctorHistoryPending {
	raw, err := os.ReadFile(backup)
	if err != nil {
		if os.IsNotExist(err) {
			return DoctorHistoryPending{}
		}
		return DoctorHistoryPending{Failed: true, FailureReason: "permission"}
	}
	var manifest struct {
		Version     int
		StateDBPath string
		Entries     map[string]json.RawMessage
	}
	if json.Unmarshal(raw, &manifest) != nil || (manifest.Version != 1 && manifest.Version != 2) || manifest.Entries == nil {
		return DoctorHistoryPending{Failed: true, FailureReason: "integrity"}
	}
	want, _ := filepath.Abs(stateDB)
	got, _ := filepath.Abs(manifest.StateDBPath)
	if want != got {
		return DoctorHistoryPending{Failed: true, FailureReason: "integrity"}
	}
	n := len(manifest.Entries)
	if _, err := os.Stat(stateDB); err != nil {
		if n == 0 && os.IsNotExist(err) {
			return DoctorHistoryPending{}
		}
		return DoctorHistoryPending{BackupEntries: n, Failed: true, FailureReason: "integrity"}
	}
	db, err := sql.Open("sqlite", "file:"+stateDB+"?mode=ro&_pragma=busy_timeout(100)")
	if err != nil {
		return DoctorHistoryPending{BackupEntries: n, Failed: true, FailureReason: "integrity"}
	}
	defer db.Close()
	var one int
	if err := db.QueryRow("SELECT 1 FROM threads LIMIT 1").Scan(&one); err != nil && err != sql.ErrNoRows {
		return DoctorHistoryPending{BackupEntries: n, Failed: true, FailureReason: "integrity"}
	}
	return DoctorHistoryPending{BackupEntries: n}
}
func FormatDoctorHistoryPending(d DoctorHistoryPending) []string {
	if d.Failed {
		if d.FailureReason == "busy" {
			return []string{"  --     history database, backup manifest, or rollout file is busy — exact metadata restore is pending"}
		}
		if d.FailureReason == "permission" {
			return []string{"  --     state DB or backup manifest access was denied — restore state unknown"}
		}
		return []string{"  --     backup manifest or restore target failed integrity checks — manual review required"}
	}
	if d.PendingRows == 0 && d.BackupEntries == 0 {
		return []string{"  ok     no manifest-backed provider metadata pending; untracked routed history is unchanged"}
	}
	word := "entries"
	if d.BackupEntries == 1 {
		word = "entry"
	}
	return []string{fmt.Sprintf("  --     %d backup manifest %s pending exact metadata restore", d.BackupEntries, word)}
}

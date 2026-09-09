package ocxcli

// Claude auth-presence detection — the Go mirror of src/claude/auth-detect.ts
// and src/claude/auth-mode.ts (issue #56 slice).
//
// THREE presence values, not two: "unknown" means a source could not be READ
// (denied keychain, unreadable file, corrupt JSON) — treating that as absent
// would silently flip a subscriber into proxy mode, the exact failure this unit
// exists to prevent. The resolver maps unknown to the historical default
// (subscription), never to proxy.

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ClaudeAuthPresence mirrors AuthPresence.
type claudeAuthPresence string

const (
	claudeAuthPresent claudeAuthPresence = "present"
	claudeAuthAbsent  claudeAuthPresence = "absent"
	claudeAuthUnknown claudeAuthPresence = "unknown"
)

// claudeAuthSourceID mirrors AuthSourceId.
type claudeAuthSourceID string

const (
	claudeSourceClaudeJSONOAuth  claudeAuthSourceID = "claude-json-oauth"     // S1
	claudeSourceCredentialsFile  claudeAuthSourceID = "claude-credentials-file" // S2
	claudeSourceMacOSKeychain    claudeAuthSourceID = "macos-keychain"        // S3
	claudeSourceExportedEnv      claudeAuthSourceID = "exported-env"          // S5
)

const (
	// claudeProxyMarker mirrors PROXY_MARKER — the one opencodex-owned dummy token.
	claudeProxyMarker = "opencodex-proxy"
	claudeKeychainService = "Claude Code-credentials"
	// `security` exit code for "the item does not exist": a real absent.
	claudeKeychainItemNotFound = 44
	claudeKeychainTimeout      = 1500 * time.Millisecond
)

type claudeAuthSourceResult struct {
	Source   claudeAuthSourceID
	Presence claudeAuthPresence
	Detail   string
}

type claudeAuthDetectDeps struct {
	// Read the parsed ~/.claude.json (nil+ok=false when missing; error=ok=true when
	// corrupt/unreadable — callers record unknown, not absent).
	readClaudeJSON func() (map[string]any, bool, error)
	// Whether <config-dir>/.credentials.json exists; error propagates as unknown.
	credentialsFileExists func() (bool, error)
	// present/absent/unknown for the macOS keychain probe; absent off-Darwin.
	keychainProbe func() claudeAuthPresence
	// The environment to inspect for S5 — the same env the launch will use.
	env func() map[string]string
	// Token values opencodex itself put into the environment.
	ownTokens []string
}

type claudeAuthDetectResult struct {
	Presence        claudeAuthPresence
	FoundBy         claudeAuthSourceID
	Sources         []claudeAuthSourceResult
	StaleProxyMarker bool
}

// ClaudeResolvedAuthMode mirrors ResolvedAuthMode.
type claudeResolvedAuthMode struct {
	MarkerMode string // "proxy" | "subscription"
	Origin     string // "manual" | "auto-present" | "auto-absent" | "auto-unknown"
	FoundBy    string
	Detection  claudeAuthDetectResult
}

// claudeAuthOrigin for MarkerMode values.
const (
	claudeMarkerProxy        = "proxy"
	claudeMarkerSubscription = "subscription"
	claudeOriginManual       = "manual"
	claudeOriginAutoPresent  = "auto-present"
	claudeOriginAutoAbsent   = "auto-absent"
	claudeOriginAutoUnknown  = "auto-unknown"
)

func claudeOwnAdmissionTokens(apiKeys []string) []string {
	var out []string
	for _, key := range apiKeys {
		if key != "" {
			out = append(out, key)
		}
	}
	return out
}

func claudeHomeDir(env map[string]string) string {
	if from := strings.TrimSpace(env["HOME"]); from != "" {
		return from
	}
	if from := strings.TrimSpace(env["USERPROFILE"]); from != "" {
		return from
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// claudeConfigDirFromEnv mirrors claudeConfigDir: CLAUDE_CONFIG_DIR override
// honored, else ~/.claude.
func claudeConfigDirFromEnv(env map[string]string) string {
	if explicit := strings.TrimSpace(env["CLAUDE_CONFIG_DIR"]); explicit != "" {
		return explicit
	}
	return filepath.Join(claudeHomeDir(env), ".claude")
}

// claudeDefaultAuthDetectDeps mirrors defaultAuthDetectDeps: real filesystem and
// keychain IO. `launchEnv` is the environment the launch will use (S5 reads it
// and config-dir derivation follows its HOME/CLAUDE_CONFIG_DIR).
func claudeDefaultAuthDetectDeps(launchEnv map[string]string, ownTokens []string) claudeAuthDetectDeps {
	configDir := claudeConfigDirFromEnv(launchEnv)
	return claudeAuthDetectDeps{
		readClaudeJSON: func() (map[string]any, bool, error) {
			path := filepath.Join(claudeHomeDir(launchEnv), ".claude.json")
			if custom := strings.TrimSpace(launchEnv["CLAUDE_CONFIG_DIR"]); custom != "" {
				path = filepath.Join(configDir, "..", ".claude.json")
			}
			data, err := os.ReadFile(path)
			if err != nil {
				if os.IsNotExist(err) {
					return nil, false, nil
				}
				return nil, true, err
			}
			var parsed map[string]any
			if err := json.Unmarshal(data, &parsed); err != nil {
				return nil, true, err
			}
			return parsed, true, nil
		},
		credentialsFileExists: func() (bool, error) {
			_, err := os.Stat(filepath.Join(configDir, ".credentials.json"))
			if err == nil {
				return true, nil
			}
			if os.IsNotExist(err) {
				return false, nil
			}
			return false, err
		},
		keychainProbe: func() claudeAuthPresence {
			if runtime.GOOS != "darwin" {
				return claudeAuthAbsent
			}
			cmd := exec.Command("security", "find-generic-password", "-s", claudeKeychainService)
			// Metadata only: no -g and no -w, those flags print the password itself.
			if err := cmd.Start(); err != nil {
				return claudeAuthUnknown
			}
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case <-time.After(claudeKeychainTimeout):
				_ = cmd.Process.Kill()
				return claudeAuthUnknown
			case err := <-done:
				if err == nil {
					return claudeAuthPresent
				}
				if exitErr, ok := err.(*exec.ExitError); ok {
					if exitErr.ExitCode() == claudeKeychainItemNotFound {
						return claudeAuthAbsent
					}
				}
				return claudeAuthUnknown
			}
		},
		env:       func() map[string]string { return launchEnv },
		ownTokens: ownTokens,
	}
}

func detectClaudeJSON(deps claudeAuthDetectDeps) claudeAuthSourceResult {
	parsed, ok, err := deps.readClaudeJSON()
	if err != nil {
		return claudeAuthSourceResult{Source: claudeSourceClaudeJSONOAuth, Presence: claudeAuthUnknown, Detail: "unreadable"}
	}
	if !ok {
		return claudeAuthSourceResult{Source: claudeSourceClaudeJSONOAuth, Presence: claudeAuthAbsent}
	}
	account, exists := parsed["oauthAccount"]
	if exists {
		if accountMap, ok := account.(map[string]any); ok {
			email, _ := accountMap["emailAddress"].(string)
			if strings.TrimSpace(email) != "" {
				return claudeAuthSourceResult{Source: claudeSourceClaudeJSONOAuth, Presence: claudeAuthPresent, Detail: "oauthAccount"}
			}
		}
	}
	return claudeAuthSourceResult{Source: claudeSourceClaudeJSONOAuth, Presence: claudeAuthAbsent}
}

func detectClaudeCredentials(deps claudeAuthDetectDeps) claudeAuthSourceResult {
	exists, err := deps.credentialsFileExists()
	if err != nil {
		return claudeAuthSourceResult{Source: claudeSourceCredentialsFile, Presence: claudeAuthUnknown, Detail: "unreadable"}
	}
	if exists {
		return claudeAuthSourceResult{Source: claudeSourceCredentialsFile, Presence: claudeAuthPresent}
	}
	return claudeAuthSourceResult{Source: claudeSourceCredentialsFile, Presence: claudeAuthAbsent}
}

func detectClaudeKeychain(deps claudeAuthDetectDeps) claudeAuthSourceResult {
	return claudeAuthSourceResult{Source: claudeSourceMacOSKeychain, Presence: deps.keychainProbe()}
}

func detectClaudeExportedEnv(deps claudeAuthDetectDeps) claudeAuthSourceResult {
	env := deps.env()
	isOwn := func(value string) bool {
		return value == claudeProxyMarker || containsString(deps.ownTokens, value)
	}
	if apiKey := strings.TrimSpace(env["ANTHROPIC_API_KEY"]); apiKey != "" && !isOwn(apiKey) {
		return claudeAuthSourceResult{Source: claudeSourceExportedEnv, Presence: claudeAuthPresent, Detail: "ANTHROPIC_API_KEY"}
	}
	if token := strings.TrimSpace(env["ANTHROPIC_AUTH_TOKEN"]); token != "" && !isOwn(token) {
		return claudeAuthSourceResult{Source: claudeSourceExportedEnv, Presence: claudeAuthPresent, Detail: "ANTHROPIC_AUTH_TOKEN"}
	}
	return claudeAuthSourceResult{Source: claudeSourceExportedEnv, Presence: claudeAuthAbsent}
}

// claudeDetectAuth mirrors detectClaudeAuth.
func claudeDetectAuth(deps claudeAuthDetectDeps) claudeAuthDetectResult {
	sources := []claudeAuthSourceResult{
		detectClaudeJSON(deps),
		detectClaudeCredentials(deps),
		detectClaudeKeychain(deps),
		detectClaudeExportedEnv(deps),
	}
	staleProxyMarker := false
	if env := deps.env(); strings.TrimSpace(env["ANTHROPIC_AUTH_TOKEN"]) == claudeProxyMarker {
		staleProxyMarker = true
	}
	for _, source := range sources {
		if source.Presence == claudeAuthPresent {
			return claudeAuthDetectResult{Presence: claudeAuthPresent, FoundBy: source.Source, Sources: sources, StaleProxyMarker: staleProxyMarker}
		}
	}
	for _, source := range sources {
		if source.Presence == claudeAuthUnknown {
			return claudeAuthDetectResult{Presence: claudeAuthUnknown, Sources: sources, StaleProxyMarker: staleProxyMarker}
		}
	}
	return claudeAuthDetectResult{Presence: claudeAuthAbsent, Sources: sources, StaleProxyMarker: staleProxyMarker}
}

// claudeResolveAuthMode mirrors resolveClaudeAuthMode.
func claudeResolveAuthMode(claudeCode *claudeCodeView, detection claudeAuthDetectResult) claudeResolvedAuthMode {
	if claudeCode != nil {
		switch claudeCode.AuthMode {
		case claudeMarkerProxy:
			return claudeResolvedAuthMode{MarkerMode: claudeMarkerProxy, Origin: claudeOriginManual, Detection: detection}
		case claudeMarkerSubscription:
			return claudeResolvedAuthMode{MarkerMode: claudeMarkerSubscription, Origin: claudeOriginManual, Detection: detection}
		}
	}
	switch detection.Presence {
	case claudeAuthPresent:
		mode := claudeResolvedAuthMode{MarkerMode: claudeMarkerSubscription, Origin: claudeOriginAutoPresent, Detection: detection}
		if detection.FoundBy != "" {
			mode.FoundBy = string(detection.FoundBy)
		}
		return mode
	case claudeAuthAbsent:
		return claudeResolvedAuthMode{MarkerMode: claudeMarkerProxy, Origin: claudeOriginAutoAbsent, Detection: detection}
	default:
		return claudeResolvedAuthMode{MarkerMode: claudeMarkerSubscription, Origin: claudeOriginAutoUnknown, Detection: detection}
	}
}


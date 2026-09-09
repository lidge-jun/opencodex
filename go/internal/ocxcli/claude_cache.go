package ocxcli

// Claude gateway-model cache + connected catalog decode — the Go mirror of
// src/claude/gateway-cache.ts and readConnectedClaudeContextWindows in
// src/cli/claude.ts (issue #56 slice).
//
// Claude Code refreshes ~/.claude/cache/gateway-models.json ONLY when it holds a
// credential (q5l(): if(!ANTHROPIC_AUTH_TOKEN && !apiKey) return). Our
// subscription-preserving launch deliberately sets no token, so we pre-write the
// cache in the exact on-disk schema the CLI uses:
//
//	{ baseUrl, fetchedAt, models: [{ id, display_name? }] }  (mode 0600)
//
// The picker validates only baseUrl === ANTHROPIC_BASE_URL.

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// claudeConfigDir mirrors claudeConfigDir(): CLAUDE_CONFIG_DIR override honored,
// else ~/.claude. `home` is os.UserHomeDir's result; envOverride is the process
// environment map.
func claudeConfigDir(home, envClaudeConfigDir string) string {
	if strings.TrimSpace(envClaudeConfigDir) != "" {
		return strings.TrimSpace(envClaudeConfigDir)
	}
	return filepath.Join(home, ".claude")
}

type claudeGatewayModelRow struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name,omitempty"`
}

// claudeWriteGatewayModelCache mirrors writeGatewayModelCache. Returns the path
// or "" on failure (best-effort, never throws).
func claudeWriteGatewayModelCache(baseURL string, models []claudeGatewayModelRow, configDir string) string {
	var usable []claudeGatewayModelRow
	for _, model := range models {
		// Mirror the CLI's /^(claude|anthropic)/i usable-id filter.
		if !claudeUsableGatewayID(model.ID) {
			continue
		}
		usable = append(usable, model)
	}
	cacheDir := filepath.Join(configDir, "cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return ""
	}
	path := filepath.Join(cacheDir, "gateway-models.json")
	payload := struct {
		BaseURL   string                  `json:"baseUrl"`
		FetchedAt int64                   `json:"fetchedAt"`
		Models    []claudeGatewayModelRow `json:"models"`
	}{BaseURL: baseURL, FetchedAt: time.Now().UnixMilli(), Models: usable}
	data, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return ""
	}
	return path
}

func claudeUsableGatewayID(id string) bool {
	if id == "" {
		return false
	}
	lower := strings.ToLower(id)
	return strings.HasPrefix(lower, "claude") || strings.HasPrefix(lower, "anthropic")
}

// claudeServiceFileToken mirrors serviceFileToken: OCX_API_TOKEN_FILE override
// or the default service token path, read from the config dir. `home`/env mirror
// the process environment (service installs put the token on disk).
func claudeServiceFileToken(configDir, envTokenFile string) string {
	if strings.TrimSpace(envTokenFile) == "" {
		state := readServiceAPITokenState(configDir)
		if state.kind == "present" {
			return state.token
		}
		return ""
	}
	// Explicit OCX_API_TOKEN_FILE override: mirror loadServiceTokenFromFile's
	// bounded regular-file read on the named path.
	info, err := os.Lstat(envTokenFile)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxServiceAPITokenBytes {
		return ""
	}
	raw, err := os.ReadFile(envTokenFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

type claudeCacheRefreshOptions struct {
	Timeout     time.Duration
	ConfigDir   string
	APIKeys     []string
	EnvToken    string // OPENCODEX_API_AUTH_TOKEN trimmed
	ServiceFile string // service-file token resolved by the caller
	HTTPClient  *http.Client
}

// claudeRefreshGatewayCacheFromProxy mirrors refreshGatewayModelCacheFromProxy.
// Returns the written cache path or "" on any failure (null in TS).
func claudeRefreshGatewayCacheFromProxy(route claudeLaunchRoute, opts claudeCacheRefreshOptions) string {
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	var baseURL, admissionToken string
	if route.target != nil {
		baseURL = urlOriginNode(route.target.BaseURL)
		admissionToken = route.target.AdmissionToken
	} else {
		baseURL = "http://127.0.0.1:" + strconv.Itoa(route.port)
		admissionToken = opts.EnvToken
		if admissionToken == "" {
			admissionToken = opts.ServiceFile
		}
		if admissionToken == "" && len(opts.APIKeys) > 0 {
			admissionToken = strings.TrimSpace(opts.APIKeys[0])
		}
	}
	configDir := opts.ConfigDir
	if configDir == "" {
		home, _ := os.UserHomeDir()
		configDir = filepath.Join(home, ".claude")
	}
	req, err := http.NewRequest(http.MethodGet, baseURL+"/v1/models?limit=1000&ids=cli", nil)
	if err != nil {
		return ""
	}
	req.Header.Set("anthropic-version", "2023-06-01")
	if strings.TrimSpace(admissionToken) != "" {
		req.Header.Set("x-opencodex-api-key", admissionToken)
	}
	res, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return ""
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return ""
	}
	var parsed struct {
		Data []map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.Data == nil {
		return ""
	}
	var models []claudeGatewayModelRow
	for _, raw := range parsed.Data {
		var row claudeGatewayModelRow
		if err := json.Unmarshal(raw["id"], &row.ID); err != nil {
			continue
		}
		if row.ID == "" {
			continue
		}
		if err := json.Unmarshal(raw["display_name"], &row.DisplayName); err != nil {
			row.DisplayName = ""
		}
		models = append(models, row)
	}
	return claudeWriteGatewayModelCache(baseURL, models, configDir)
}

// claudeReadConnectedContextWindows mirrors readConnectedClaudeContextWindows:
// decode the connected hub's catalog file into the selector-form window map.
func claudeReadConnectedContextWindows(path string) map[string]int64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]int64{}
	}
	var parsed struct {
		Models []map[string]json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return map[string]int64{}
	}
	out := map[string]int64{}
	put := func(key string, value int64) {
		if _, exists := out[key]; !exists {
			out[key] = value
		}
	}
	for _, row := range parsed.Models {
		var slug string
		if err := json.Unmarshal(row["slug"], &slug); err != nil {
			continue
		}
		var window float64
		if err := json.Unmarshal(row["context_window"], &window); err != nil {
			continue
		}
		if slug == "" || window <= 0 {
			continue
		}
		put(slug, int64(window))
		slash := strings.Index(slug, "/")
		if slash > 0 && slash < len(slug)-1 {
			provider := slug[:slash]
			id := slug[slash+1:]
			if alias, ok := claudeAliasForRoute(provider, id); ok {
				put(alias, int64(window))
			}
			put(claudeDesktop3pAlias(provider, id), int64(window))
		} else {
			if alias, ok := claudeAliasForNative(slug); ok {
				put(alias, int64(window))
			}
			put(claudeDesktop3pAlias(claudeNativeProvider, slug), int64(window))
		}
	}
	return out
}

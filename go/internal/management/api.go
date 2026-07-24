package management

import (
	"net/http"
	"runtime"
	"sync"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

type Options struct {
	Config      *config.Config
	ConfigPath  string
	Registry    types.Registry
	UsageLog    *usage.Log
	DebugLog    *usage.DebugLog
	RequestLogs *RequestLog
	OAuth       OAuthBackend
	FetchModels ModelFetcher
	StorageHome string
	Version     string
	Stop        func()
}

type API struct {
	mu           sync.RWMutex
	config       *config.Config
	configPath   string
	registry     types.Registry
	usageLog     *usage.Log
	debugLog     *usage.DebugLog
	requestLogs  *RequestLog
	oauth        OAuthBackend
	fetchModels  ModelFetcher
	storageHome  string
	version      string
	stop         func()
	customModels map[string]CustomModel
	aliases      map[string]string
	contextCaps  map[string]int
	combos       map[string]Combo
	agents       AgentSettings
	debugEnabled bool
}

func New(options Options) (*API, error) {
	cfg := options.Config
	if cfg == nil && options.ConfigPath != "" {
		loaded, err := config.Load(options.ConfigPath)
		if err != nil {
			return nil, err
		}
		cfg = loaded
	}
	if cfg == nil {
		value := config.Default()
		cfg = &value
	}
	if options.RequestLogs == nil {
		options.RequestLogs = NewRequestLog(200)
	}
	options.RequestLogs.SetUsageLog(options.UsageLog)
	return &API{config: cfg, configPath: options.ConfigPath, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, oauth: options.OAuth, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, customModels: map[string]CustomModel{}, aliases: map[string]string{}, contextCaps: map[string]int{}, combos: map[string]Combo{}, agents: AgentSettings{MaxConcurrency: 1, MultiAgentMode: "default"}}, nil
}

// NewAPI names the management composition point explicitly while preserving
// New for existing callers.
func NewAPI(options Options) (*API, error) { return New(options) }

var routes = []string{
	"GET /api/config", "PUT /api/config", "GET /api/settings", "PUT /api/settings", "GET /api/diagnostics/project-config",
	"GET /api/providers", "POST /api/providers", "PATCH /api/providers", "DELETE /api/providers", "POST /api/providers/test", "GET /api/provider-presets",
	"GET /api/models", "GET /api/custom-models", "POST /api/custom-models", "PUT /api/custom-models/{id}", "DELETE /api/custom-models/{id}", "GET /api/model-aliases", "PUT /api/model-aliases", "GET /api/provider-context-caps", "PUT /api/provider-context-caps",
	"GET /api/oauth/providers", "POST /api/oauth/login", "POST /api/oauth/login/cancel", "POST /api/oauth/login/code", "GET /api/oauth/status", "POST /api/oauth/logout", "GET /api/oauth/accounts", "PUT /api/oauth/accounts/active", "PUT /api/oauth/accounts/alias", "DELETE /api/oauth/accounts",
	"GET /api/combos", "PUT /api/combos", "DELETE /api/combos", "POST /api/combos/reset",
	"GET /api/logs", "DELETE /api/logs", "GET /api/debug", "PUT /api/debug", "GET /api/debug/usage-logs", "DELETE /api/debug/usage-logs", "GET /api/usage", "DELETE /api/usage", "GET /api/storage",
	"GET /api/system", "GET /api/system/memory", "GET /api/system/runtime", "GET /api/subagent-models", "PUT /api/subagent-models", "GET /api/injection-model", "PUT /api/injection-model", "GET /api/effort-caps", "PUT /api/effort-caps", "GET /api/v2", "PUT /api/v2", "POST /api/stop",
}

func RegisteredRoutes() []string { return append([]string(nil), routes...) }
func (a *API) Register(mux *http.ServeMux) {
	for _, route := range routes {
		mux.Handle(route, a)
	}
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.ContentLength > maxManagementBody {
		writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	for _, handler := range []func(http.ResponseWriter, *http.Request) bool{a.handleConfig, a.handleProviders, a.handleOAuth, a.handleModels, a.handleCombos, a.handleLogs, a.handleSystem, a.handleAgents} {
		if handler(w, r) {
			return
		}
	}
	if r.URL.Path == "/api/stop" && r.Method == http.MethodPost {
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "Proxy stopping."})
		if a.stop != nil {
			go a.stop()
		}
		return
	}
	writeError(w, http.StatusNotFound, "management route not found")
}

func (a *API) saveLocked() error {
	if a.configPath == "" {
		return nil
	}
	return config.Save(a.configPath, a.config)
}
func (a *API) runtimeInfo() map[string]any {
	return map[string]any{"version": a.version, "goVersion": runtime.Version(), "platform": runtime.GOOS, "architecture": runtime.GOARCH}
}

var _ types.ManagementRouter = (*API)(nil)

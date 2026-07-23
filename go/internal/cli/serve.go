package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/adapter/anthropic"
	"github.com/lidge-jun/opencodex-go/internal/adapter/google"
	"github.com/lidge-jun/opencodex-go/internal/adapter/kiro"
	openaiadapter "github.com/lidge-jun/opencodex-go/internal/adapter/openai"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func runServe(_ context.Context, args []string, streams IO) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(streams.Err)
	hostOverride := flags.String("host", "", "listen host")
	portOverride := flags.Int("port", -1, "listen port")
	configFile := flags.String("config", "", "configuration file")
	tokenFile := flags.String("token-file", "", "service token file")
	codexHome := flags.String("codex-home", "", "Codex home for service mode")
	serviceMode := flags.Bool("service", false, "run under a service manager")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected serve arguments: %v", flags.Args())
	}
	if *configFile != "" {
		_ = os.Setenv("OPENCODEX_HOME", filepath.Dir(*configFile))
	}
	if *codexHome != "" {
		_ = os.Setenv("CODEX_HOME", *codexHome)
	}
	if *serviceMode {
		_ = os.Setenv("OCX_SERVICE", "1")
	}
	var cfg *config.Config
	var err error
	if *configFile != "" {
		cfg, err = config.Load(*configFile)
	} else {
		cfg, _, err = loadConfig()
	}
	if err != nil {
		return err
	}
	if *hostOverride != "" {
		cfg.Host = *hostOverride
	}
	if *portOverride >= 0 {
		cfg.Port = *portOverride
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	serviceTokenFile := *tokenFile
	if serviceTokenFile == "" {
		serviceTokenFile = os.Getenv("OCX_API_TOKEN_FILE")
	}
	token, err := platform.LoadServiceToken(os.Getenv("OPENCODEX_API_AUTH_TOKEN"), serviceTokenFile)
	if err != nil {
		return err
	}
	if token == "" {
		token = cfg.AuthToken
	}
	reg := configuredRegistry(*cfg)
	auth, err := configuredAuth(*cfg)
	if err != nil {
		return err
	}
	stop := &stopRouter{channel: make(chan struct{})}
	proxy := server.New(server.Config{Registry: reg, Auth: auth, ResolveAdapter: adapterResolver(reg, *cfg), Token: token, Version: Version, Management: stop})
	httpServer := proxy.HTTPServer(net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	listener, listenErr := net.Listen("tcp", httpServer.Addr)
	if listenErr != nil {
		return listenErr
	}
	actualPort := listener.Addr().(*net.TCPAddr).Port
	if err := writeRuntimeFiles(actualPort); err != nil {
		_ = listener.Close()
		return err
	}
	defer removeRuntimeFiles()
	fmt.Fprintf(streams.Out, "OpenCodex proxy listening on %s\n", listener.Addr())
	return serveListener(httpServer, proxy.Lifecycle(), listener, stop.channel)
}

type stopRouter struct {
	once    sync.Once
	channel chan struct{}
}

func (s *stopRouter) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/stop", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"ok":true,"status":"stopping"}`))
		s.once.Do(func() { close(s.channel) })
	})
}

func serveListener(httpServer *http.Server, lifecycle *server.Lifecycle, listener net.Listener, stop <-chan struct{}) error {
	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.Serve(listener) }()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-signals:
	case <-stop:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_ = lifecycle.Drain(ctx)
	return httpServer.Shutdown(ctx)
}

func configuredRegistry(cfg config.Config) *registry.ProviderRegistry {
	base := registry.New().Entries()
	index := make(map[string]int, len(base))
	for position, entry := range base {
		index[entry.ID] = position
	}
	for name, provider := range cfg.Providers {
		entry := registry.Provider{ID: name, Label: name, Adapter: provider.Adapter, BaseURL: provider.BaseURL, DefaultModel: provider.DefaultModel}
		for _, model := range provider.Models {
			entry.Models = append(entry.Models, registry.ModelDefinition{ID: model})
		}
		if position, ok := index[name]; ok {
			preset := base[position]
			preset.Adapter, preset.BaseURL, preset.DefaultModel = entry.Adapter, entry.BaseURL, entry.DefaultModel
			if len(entry.Models) > 0 {
				preset.Models = entry.Models
			}
			base[position] = preset
		} else {
			base = append(base, entry)
		}
	}
	return registry.New(base...)
}

func configuredAuth(cfg config.Config) (*oauth.AuthResolver, error) {
	dir, err := configDir()
	if err != nil {
		return nil, err
	}
	configs := map[string]oauth.ProviderAuthConfig{"openai": {Mode: oauth.AuthModeForward}}
	reg := registry.New()
	for name, provider := range cfg.Providers {
		mode := oauth.AuthModeOAuth
		if preset, ok := reg.Lookup(name); ok {
			switch preset.AuthKind {
			case registry.AuthForward:
				mode = oauth.AuthModeForward
			case registry.AuthKey, registry.AuthLocal:
				mode = oauth.AuthModeAPIKey
			}
		} else if provider.APIKey != "" {
			mode = oauth.AuthModeAPIKey
		}
		configs[name] = oauth.ProviderAuthConfig{Mode: mode, APIKey: provider.APIKey}
	}
	return oauth.NewAuthResolver(oauth.NewCredentialStore(filepath.Join(dir, "auth.json")), configs, nil), nil
}

func adapterResolver(reg *registry.ProviderRegistry, cfg config.Config) server.AdapterResolver {
	return func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error) {
		entry, ok := reg.Lookup(model.Provider)
		if !ok {
			return nil, fmt.Errorf("unknown provider %q", model.Provider)
		}
		provider := cfg.Providers[model.Provider]
		secret := provider.APIKey
		if auth != nil {
			if auth.APIKey != "" {
				secret = auth.APIKey
			} else if auth.AccessToken != "" {
				secret = auth.AccessToken
			}
		}
		headers := transport.Headers
		switch entry.Adapter {
		case "openai-chat", "mimo-free", "cursor":
			return &openaiadapter.ChatAdapter{BaseURL: transport.BaseURL, APIKey: secret, Headers: headers}, nil
		case "openai-responses":
			return &openaiadapter.ResponsesAdapter{BaseURL: transport.BaseURL, APIKey: secret, Headers: headers, IncomingHeaders: incoming, ForwardAuth: entry.AuthKind == registry.AuthForward}, nil
		case "anthropic":
			return &anthropic.Adapter{BaseURL: transport.BaseURL, APIKey: secret, Headers: headers}, nil
		case "azure-openai":
			return &openaiadapter.AzureAdapter{BaseURL: transport.BaseURL, APIKey: secret, Headers: headers}, nil
		case "google":
			mode := google.ModeAIStudio
			if model.Provider == "google-vertex" {
				mode = google.ModeVertex
			}
			if model.Provider == "google-antigravity" {
				mode = google.ModeCloudCodeAssist
			}
			return google.NewAdapter(mode, transport, auth), nil
		case "kiro":
			return kiro.NewAdapter(transport.BaseURL, secret), nil
		default:
			return nil, fmt.Errorf("adapter %q is not supported", entry.Adapter)
		}
	}
}

func runtimePaths() (string, string, error) {
	dir, err := configDir()
	if err != nil {
		return "", "", err
	}
	return filepath.Join(dir, "ocx.pid"), filepath.Join(dir, "runtime-port"), nil
}

func writeRuntimeFiles(port int) error {
	pidPath, portPath, err := runtimePaths()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(pidPath), 0o700); err != nil {
		return err
	}
	if data, readErr := os.ReadFile(pidPath); readErr == nil {
		if pid, parseErr := strconv.Atoi(string(data)); parseErr == nil && platform.ProcessAlive(pid) {
			return fmt.Errorf("proxy already running with PID %d", pid)
		}
	}
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		return err
	}
	return os.WriteFile(portPath, []byte(strconv.Itoa(port)), 0o600)
}

func removeRuntimeFiles() {
	pidPath, portPath, _ := runtimePaths()
	_ = os.Remove(pidPath)
	_ = os.Remove(portPath)
}

package cli

import (
	"bufio"
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
)

func runInit(args []string, streams IO) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx init")
	}
	reader := bufio.NewReader(streams.In)
	fmt.Fprint(streams.Out, "Provider name (for example openrouter, anthropic-apikey, ollama): ")
	name, err := reader.ReadString('\n')
	if err != nil && len(name) == 0 {
		return err
	}
	name = strings.TrimSpace(name)
	preset, ok := registry.New().Lookup(name)
	if !ok {
		return fmt.Errorf("unknown provider %q; use `ocx provider add` for a custom provider", name)
	}
	provider := config.ProviderConfig{Adapter: preset.Adapter, BaseURL: preset.BaseURL, DefaultModel: preset.DefaultModel, AllowPrivateNetwork: preset.AllowPrivateNetworkDefault}
	for _, model := range preset.Models {
		provider.Models = append(provider.Models, model.ID)
	}
	if preset.AuthKind == registry.AuthKey && !preset.KeyOptional {
		fmt.Fprint(streams.Out, "API key (stored in ~/.opencodex/config.json with mode 0600): ")
		key, readErr := reader.ReadString('\n')
		if readErr != nil && len(key) == 0 {
			return readErr
		}
		provider.APIKey = strings.TrimSpace(key)
		if provider.APIKey == "" {
			return fmt.Errorf("API key is required for %s", name)
		}
	}
	cfg, path, err := loadConfig()
	if err != nil {
		return err
	}
	if cfg.Providers == nil {
		cfg.Providers = make(map[string]config.ProviderConfig)
	}
	cfg.Providers[name] = provider
	cfg.DefaultProvider = name
	if err := config.Save(path, cfg); err != nil {
		return err
	}
	fmt.Fprintf(streams.Out, "Configured %s as the default provider.\n", name)
	return nil
}

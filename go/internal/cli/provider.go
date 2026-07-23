package cli

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
)

func configDir() (string, error) {
	if value := strings.TrimSpace(os.Getenv("OPENCODEX_HOME")); value != "" {
		if strings.HasPrefix(value, "~/") {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			value = filepath.Join(home, strings.TrimPrefix(value, "~/"))
		}
		return filepath.Abs(value)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".opencodex"), nil
}

func configPath() (string, error) {
	dir, err := configDir()
	return filepath.Join(dir, "config.json"), err
}

func loadConfig() (*config.Config, string, error) {
	path, err := configPath()
	if err != nil {
		return nil, "", err
	}
	cfg, err := config.Load(path)
	if os.IsNotExist(err) || err != nil && strings.Contains(err.Error(), "no such file") {
		defaults := config.Default()
		return &defaults, path, nil
	}
	return cfg, path, err
}

func runProvider(args []string, streams IO) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: ocx provider <list|add|remove|default>")
	}
	cfg, path, err := loadConfig()
	if err != nil {
		return err
	}
	switch args[0] {
	case "list":
		names := make([]string, 0, len(cfg.Providers))
		for name := range cfg.Providers {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			marker := " "
			if name == cfg.DefaultProvider {
				marker = "*"
			}
			provider := cfg.Providers[name]
			fmt.Fprintf(streams.Out, "%s %-24s %-18s %s\n", marker, name, provider.Adapter, provider.BaseURL)
		}
		return nil
	case "add":
		return providerAdd(cfg, path, args[1:], streams)
	case "remove":
		if len(args) != 2 {
			return fmt.Errorf("usage: ocx provider remove <name>")
		}
		if _, ok := cfg.Providers[args[1]]; !ok {
			return fmt.Errorf("provider %q is not configured", args[1])
		}
		delete(cfg.Providers, args[1])
		if cfg.DefaultProvider == args[1] {
			cfg.DefaultProvider = "openai"
		}
		return config.Save(path, cfg)
	case "default", "set-default":
		if len(args) != 2 {
			return fmt.Errorf("usage: ocx provider default <name>")
		}
		if args[1] != "openai" {
			if _, ok := cfg.Providers[args[1]]; !ok {
				return fmt.Errorf("provider %q is not configured", args[1])
			}
		}
		cfg.DefaultProvider = args[1]
		return config.Save(path, cfg)
	default:
		return fmt.Errorf("unknown provider subcommand %q", args[0])
	}
}

func providerAdd(cfg *config.Config, path string, args []string, streams IO) error {
	flags := flag.NewFlagSet("provider add", flag.ContinueOnError)
	flags.SetOutput(streams.Err)
	adapter := flags.String("adapter", "", "adapter name")
	baseURL := flags.String("base-url", "", "provider base URL")
	apiKey := flags.String("api-key", "", "API key or environment reference")
	model := flags.String("model", "", "default model")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return fmt.Errorf("usage: ocx provider add <name> [--adapter NAME --base-url URL]")
	}
	name := strings.TrimSpace(flags.Arg(0))
	provider := config.ProviderConfig{Adapter: *adapter, BaseURL: *baseURL, APIKey: *apiKey, DefaultModel: *model}
	if preset, ok := registry.New().Lookup(name); ok {
		if provider.Adapter == "" {
			provider.Adapter = preset.Adapter
		}
		if provider.BaseURL == "" {
			provider.BaseURL = preset.BaseURL
		}
		if provider.DefaultModel == "" {
			provider.DefaultModel = preset.DefaultModel
		}
		for _, row := range preset.Models {
			provider.Models = append(provider.Models, row.ID)
		}
		provider.AllowPrivateNetwork = preset.AllowPrivateNetworkDefault
	}
	if provider.Adapter == "" || provider.BaseURL == "" {
		return fmt.Errorf("custom providers require --adapter and --base-url")
	}
	if cfg.Providers == nil {
		cfg.Providers = make(map[string]config.ProviderConfig)
	}
	cfg.Providers[name] = provider
	if err := config.Save(path, cfg); err != nil {
		return err
	}
	fmt.Fprintf(streams.Out, "Configured provider %s.\n", name)
	return nil
}

package cli

import (
	"fmt"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func runModels(args []string, streams IO) error {
	command := "list"
	if len(args) > 0 {
		command, args = args[0], args[1:]
	}
	cfg, path, err := loadConfig()
	if err != nil {
		return err
	}
	switch command {
	case "list":
		filter := ""
		if len(args) == 2 && args[0] == "--provider" {
			filter = args[1]
		} else if len(args) != 0 {
			return fmt.Errorf("usage: ocx models list [--provider NAME]")
		}
		var rows []string
		for name, provider := range cfg.Providers {
			if filter != "" && filter != name {
				continue
			}
			for _, model := range provider.Models {
				rows = append(rows, name+"/"+model)
			}
		}
		sort.Strings(rows)
		for _, row := range rows {
			fmt.Fprintln(streams.Out, row)
		}
		return nil
	case "add", "remove":
		if len(args) != 2 {
			return fmt.Errorf("usage: ocx models %s <provider> <model>", command)
		}
		name, model := strings.TrimSpace(args[0]), strings.TrimSpace(args[1])
		provider, ok := cfg.Providers[name]
		if !ok {
			return fmt.Errorf("provider %q is not configured", name)
		}
		if command == "add" {
			for _, existing := range provider.Models {
				if existing == model {
					return nil
				}
			}
			provider.Models = append(provider.Models, model)
			sort.Strings(provider.Models)
		} else {
			models := provider.Models[:0]
			for _, existing := range provider.Models {
				if existing != model {
					models = append(models, existing)
				}
			}
			provider.Models = models
		}
		cfg.Providers[name] = provider
		return config.Save(path, cfg)
	default:
		return fmt.Errorf("unknown models subcommand %q", command)
	}
}

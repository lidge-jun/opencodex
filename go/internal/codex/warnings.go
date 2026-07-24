package codex

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
)

type ProjectConfigIssueCode string

const (
	IssueProviderTable ProjectConfigIssueCode = "model_providers_table"
	IssueProfile       ProjectConfigIssueCode = "profile_selector"
	IssueRootProvider  ProjectConfigIssueCode = "model_provider_root"
)

type ProjectConfigWarning struct {
	Path        string
	Code        ProjectConfigIssueCode
	Provider    string
	ProfileName string
	Message     string
}

type EffectiveProjectRouting struct {
	Provider    string
	ProfileName string
	Via         string
}

func ResolveEffectiveProjectRouting(content []byte) (EffectiveProjectRouting, error) {
	var document map[string]any
	if err := toml.Unmarshal(content, &document); err != nil {
		return EffectiveProjectRouting{}, fmt.Errorf("parse project Codex config: %w", err)
	}
	profile, _ := document["profile"].(string)
	rootProvider, _ := document["model_provider"].(string)
	if profile != "" {
		if profiles, ok := asTable(document["profiles"]); ok {
			if selected, ok := asTable(profiles[profile]); ok {
				if provider, ok := selected["model_provider"].(string); ok && provider != "" {
					return EffectiveProjectRouting{Provider: provider, ProfileName: profile, Via: "profile"}, nil
				}
			}
		}
		if rootProvider != "" {
			return EffectiveProjectRouting{Provider: rootProvider, ProfileName: profile, Via: "root"}, nil
		}
		return EffectiveProjectRouting{ProfileName: profile}, nil
	}
	if rootProvider != "" {
		return EffectiveProjectRouting{Provider: rootProvider, Via: "root"}, nil
	}
	return EffectiveProjectRouting{}, nil
}

func AnalyzeProjectConfig(content []byte, configPath string) ([]ProjectConfigWarning, error) {
	routing, err := ResolveEffectiveProjectRouting(content)
	if err != nil {
		return nil, err
	}
	if routing.Provider == "" || routing.Provider == "openai" || routing.Provider == "opencodex" {
		return nil, nil
	}
	var document map[string]any
	if err := toml.Unmarshal(content, &document); err != nil {
		return nil, err
	}
	hasProviderTable := false
	if providers, ok := asTable(document["model_providers"]); ok {
		_, hasProviderTable = providers[routing.Provider]
	}
	warning := ProjectConfigWarning{Path: configPath, Provider: routing.Provider, ProfileName: routing.ProfileName}
	switch {
	case hasProviderTable:
		warning.Code = IssueProviderTable
		warning.Message = fmt.Sprintf("project Codex config selects %q and defines [model_providers.%s], bypassing OpenCodex", routing.Provider, routing.Provider)
	case routing.Via == "profile":
		warning.Code = IssueProfile
		warning.Message = fmt.Sprintf("project profile %q selects model_provider %q, bypassing OpenCodex", routing.ProfileName, routing.Provider)
	default:
		warning.Code = IssueRootProvider
		warning.Message = fmt.Sprintf("project Codex config selects model_provider %q, bypassing OpenCodex", routing.Provider)
	}
	return []ProjectConfigWarning{warning}, nil
}

// DiscoverProjectCodexConfigs recursively finds .codex/config.toml under root.
func DiscoverProjectCodexConfigs(root string, maxDepth int) ([]string, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if maxDepth <= 0 {
		maxDepth = 12
	}
	var found []string
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		depth := 0
		if relative != "." {
			depth = len(strings.Split(relative, string(filepath.Separator)))
		}
		if entry.IsDir() {
			if depth > maxDepth || entry.Name() == ".git" || entry.Name() == "node_modules" || entry.Name() == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Name() == "config.toml" && filepath.Base(filepath.Dir(path)) == ".codex" {
			found = append(found, path)
		}
		return nil
	})
	sort.Strings(found)
	return found, err
}

func CollectProjectConfigWarnings(root string, maxDepth int) ([]ProjectConfigWarning, error) {
	paths, err := DiscoverProjectCodexConfigs(root, maxDepth)
	if err != nil {
		return nil, err
	}
	var warnings []ProjectConfigWarning
	for _, path := range paths {
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		items, parseErr := AnalyzeProjectConfig(content, path)
		if parseErr != nil {
			continue
		}
		warnings = append(warnings, items...)
	}
	return warnings, nil
}

package claude

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	agentOwnedPrefix     = "ocx-"
	agentGeneratedMarker = "generated-by: opencodex"
)

var agentNameCleaner = regexp.MustCompile(`[^a-z0-9]+`)

type AgentModel struct {
	Provider string
	ID       string
}

type AgentConfig struct {
	Models                   []AgentModel
	DefaultModel             string
	ConfigDir                string
	AutoContext              AutoContextMode
	BlockedSkills            []string
	DisableNativePassthrough bool
}

type ClaudeAgentDef struct {
	File          string
	Name          string
	Model         string
	Description   string
	BlockedSkills []string
}

func BuildClaudeAgentDefs(cfg AgentConfig, windows map[string]int) []ClaudeAgentDef {
	defs := make([]ClaudeAgentDef, 0, min(len(cfg.Models), 5)+1)
	usedNames := map[string]bool{}
	covered := map[string]bool{}
	for _, model := range cfg.Models[:min(len(cfg.Models), 5)] {
		if strings.TrimSpace(model.ID) == "" {
			continue
		}
		provider := strings.TrimSpace(model.Provider)
		id := strings.TrimSpace(model.ID)
		alias := ClaudeCodeNativeAlias(id)
		if provider != "" && provider != nativeProvider {
			alias = ClaudeCodeAlias(provider, id)
		}
		if covered[strings.ToLower(alias)] {
			continue
		}
		covered[strings.ToLower(alias)] = true
		name := sanitizeAgentName(id)
		base := name
		for suffix := 2; usedNames[name]; suffix++ {
			name = fmt.Sprintf("%s-%d", base, suffix)
		}
		usedNames[name] = true
		effective := WithOneMillionMarker(alias, windows, cfg.AutoContext)
		blocked := append([]string(nil), cfg.BlockedSkills...)
		if !cfg.DisableNativePassthrough && nativeAgentPassthrough(effective) {
			blocked = nil
		}
		defs = append(defs, ClaudeAgentDef{
			File: agentOwnedPrefix + name + ".md", Name: agentOwnedPrefix + name, Model: effective,
			Description:   fmt.Sprintf("Delegate work to %s (%s) via opencodex routing. General-purpose worker/explorer on that model. %s", id, agentProviderLabel(provider), agentNoModelArg),
			BlockedSkills: blocked,
		})
	}
	defaultModel := strings.TrimSpace(cfg.DefaultModel)
	if defaultModel == "" && cfg.ConfigDir != "" {
		defaultModel = pickerDefaultModel(cfg.ConfigDir)
	}
	if model := defaultModel; model != "" {
		model = WithOneMillionMarker(model, windows, cfg.AutoContext)
		blocked := append([]string(nil), cfg.BlockedSkills...)
		if !cfg.DisableNativePassthrough && nativeAgentPassthrough(model) {
			blocked = nil
		}
		defs = append(defs, ClaudeAgentDef{
			File: "ocx-self.md", Name: "ocx-self", Model: model,
			Description:   fmt.Sprintf("Self-clone: delegate to your default main model (%s), synced from the /model picker at launch. %s", model, agentNoModelArg),
			BlockedSkills: blocked,
		})
	}
	return defs
}

func SyncClaudeAgentDefs(defs []ClaudeAgentDef, configDir string) ([]string, error) {
	dir := filepath.Join(configDir, "agents")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create Claude agents directory: %w", err)
	}
	keep := make(map[string]bool, len(defs))
	for _, def := range defs {
		if err := validateAgentDef(def); err != nil {
			return nil, err
		}
		keep[def.File] = true
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read Claude agents directory: %w", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if keep[name] || !strings.HasPrefix(name, agentOwnedPrefix) || !strings.HasSuffix(name, ".md") {
			continue
		}
		path := filepath.Join(dir, name)
		if ownedClaudeAgentFile(path) {
			if err := os.Remove(path); err != nil {
				return nil, fmt.Errorf("remove stale Claude agent %s: %w", name, err)
			}
		}
	}
	written := make([]string, 0, len(defs))
	for _, def := range defs {
		target := filepath.Join(dir, def.File)
		if _, err := os.Lstat(target); err == nil {
			if !ownedClaudeAgentFile(target) {
				continue
			}
		} else if !os.IsNotExist(err) {
			return nil, fmt.Errorf("inspect Claude agent %s: %w", def.File, err)
		}
		content, err := RenderClaudeAgentDef(def)
		if err != nil {
			return nil, err
		}
		if err := atomicWriteFile(target, []byte(content), 0o644); err != nil {
			return nil, fmt.Errorf("write Claude agent %s: %w", def.File, err)
		}
		written = append(written, def.File)
	}
	return written, nil
}

func RenderClaudeAgentDef(def ClaudeAgentDef) (string, error) {
	if err := validateAgentDef(def); err != nil {
		return "", err
	}
	quote := func(value string) string {
		data, _ := json.Marshal(value)
		return string(data)
	}
	lines := []string{
		"---", "name: " + quote(def.Name), "description: " + quote(def.Description), "model: " + quote(def.Model), "---", "",
		"<!-- " + agentGeneratedMarker + " -->", "<!-- ocx-route: " + def.Model + " -->", "",
		"You are a delegated worker running on `" + def.Model + "` through the local opencodex proxy.",
		"IDENTITY: your ACTUAL underlying model is `" + def.Model + "` — the opencodex proxy routes this",
		"session there regardless of what model name the Claude Code harness displays or claims.",
		"If asked which model you are, answer with the id above; do not guess a Claude model name.",
	}
	if len(def.BlockedSkills) > 0 {
		blocked := make([]string, len(def.BlockedSkills))
		for i, skill := range def.BlockedSkills {
			blocked[i] = safeAgentLiteral(skill)
		}
		lines = append(lines, "", "Do not invoke blocked Claude Code skills: "+strings.Join(blocked, ", ")+".", "Their document bundles are intentionally omitted for routed models; continue without loading them.")
	}
	lines = append(lines, "", "Complete the dispatched task directly and report results concisely. This file is", "auto-generated by opencodex (`ocx claude`) from the featured subagent roster —", "manual edits will be overwritten; remove the model from the roster to drop it.", "")
	return strings.Join(lines, "\n"), nil
}

func ownedClaudeAgentFile(path string) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	data, err := os.ReadFile(path)
	return err == nil && strings.Contains(string(data), agentGeneratedMarker)
}

func validateAgentDef(def ClaudeAgentDef) error {
	if filepath.Base(def.File) != def.File || !strings.HasPrefix(def.File, agentOwnedPrefix) || !strings.HasSuffix(def.File, ".md") {
		return fmt.Errorf("invalid Claude agent filename %q", def.File)
	}
	if def.Name == "" || strings.ContainsAny(def.Name, "\r\n") || def.Model == "" || strings.ContainsAny(def.Model, " \t\r\n`<>") {
		return fmt.Errorf("invalid Claude agent definition %q", def.File)
	}
	return nil
}

func sanitizeAgentName(value string) string {
	cleaned := strings.Trim(agentNameCleaner.ReplaceAllString(strings.ToLower(value), "-"), "-")
	if cleaned == "" {
		return "model"
	}
	return cleaned
}

func safeAgentLiteral(value string) string {
	data, _ := json.Marshal(value)
	result := string(data)
	replacer := strings.NewReplacer("`", "\\u0060", "<", "\\u003c", ">", "\\u003e")
	return replacer.Replace(result)
}

func agentProviderLabel(provider string) string {
	if provider == "" || provider == nativeProvider {
		return nativeProvider
	}
	return provider
}

func pickerDefaultModel(configDir string) string {
	data, err := os.ReadFile(filepath.Join(configDir, "settings.json"))
	if err != nil {
		return ""
	}
	var settings struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(data, &settings) != nil {
		return ""
	}
	return strings.TrimSpace(settings.Model)
}

func nativeAgentPassthrough(model string) bool {
	model = StripOneMillionMarker(model)
	lower := strings.ToLower(model)
	if strings.Contains(model, "/") || (!strings.HasPrefix(lower, "claude-") && !strings.HasPrefix(lower, "anthropic-")) {
		return false
	}
	if _, ok := ResolveAlias(model); ok {
		return false
	}
	if _, ok := ResolveDesktop3pAlias(model); ok {
		return false
	}
	return true
}

const agentNoModelArg = "NOTE: this agent's real model is pinned by the opencodex proxy — the `model` argument is ignored. Pass model: \"haiku\" as a placeholder (or omit it); routing is unaffected either way."

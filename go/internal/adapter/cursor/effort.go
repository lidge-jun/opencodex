package cursor

import "strings"

var cursorEffortTiers = map[string][]string{
	"claude-4.5-opus":    {"high"},
	"claude-4.6-opus":    {"high", "max"},
	"claude-4.6-sonnet":  {"medium"},
	"claude-fable-5":     {"low", "medium", "high", "xhigh", "max"},
	"claude-opus-4-7":    {"low", "medium", "high", "xhigh", "max"},
	"claude-opus-4-8":    {"low", "medium", "high", "xhigh", "max"},
	"claude-opus-5":      {"low", "medium", "high", "xhigh", "max"},
	"claude-sonnet-5":    {"low", "medium", "high", "xhigh", "max"},
	"glm-5.2":            {"high", "max"},
	"grok-4.5":           {"medium", "high", "xhigh"},
	"grok-4.5-fast":      {"medium", "high", "xhigh"},
	"gpt-5.1":            {"low", "high"},
	"gpt-5.1-codex-max":  {"low", "medium", "high", "xhigh"},
	"gpt-5.1-codex-mini": {"low", "high"},
	"gpt-5.2":            {"low", "high", "xhigh"},
	"gpt-5.2-codex":      {"low", "high", "xhigh"},
	"gpt-5.3-codex":      {"low", "high", "xhigh"},
	"gpt-5.4":            {"low", "medium", "high", "xhigh"},
	"gpt-5.4-mini":       {"low", "medium", "high", "xhigh"},
	"gpt-5.4-nano":       {"low", "medium", "high", "xhigh"},
	"gpt-5.5":            {"low", "medium", "high"},
	"gpt-5.5-extra":      {"high"},
	"gpt-5.6-sol":        {"low", "medium", "high", "xhigh", "max"},
	"gpt-5.6-terra":      {"low", "medium", "high", "xhigh", "max"},
	"gpt-5.6-luna":       {"low", "medium", "high", "xhigh", "max"},
}

func CursorEffortSuffix(modelID, effort string) string {
	tiers := cursorEffortTiers[modelID]
	if len(tiers) == 0 {
		return ""
	}
	effort = strings.ToLower(strings.TrimSpace(effort))
	if effort == "ultra" {
		effort = "max"
	}
	for _, tier := range tiers {
		if tier == effort {
			return tier
		}
	}
	switch effort {
	case "none", "minimal", "low":
		return tiers[0]
	case "medium":
		return tiers[(len(tiers)-1)/2]
	default:
		return tiers[len(tiers)-1]
	}
}

func CursorWireModel(modelID, effort string) (string, map[string]string) {
	id := strings.TrimPrefix(modelID, "cursor/")
	parameters := map[string]string(nil)
	if id == "auto" {
		id = "default"
	}
	for _, level := range []string{"cost", "balance", "intelligence"} {
		if id == "auto-"+level {
			id = "default"
			parameters = map[string]string{"optimization": level}
			break
		}
	}
	if suffix := CursorEffortSuffix(id, effort); suffix != "" {
		id += "-" + suffix
	}
	return id, parameters
}

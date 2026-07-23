package openai

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const maxToolNudgeNames = 128

var neighboringToolNames = []string{"Read", "Grep", "Glob", "Bash", "LS", "apply_patch"}

func ShouldInjectToolCatalogNudge(baseURL string) bool {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Hostname() == "" {
		return true
	}
	host := strings.ToLower(parsed.Hostname())
	return host != "openai.com" && !strings.HasSuffix(host, ".openai.com") &&
		host != "chatgpt.com" && !strings.HasSuffix(host, ".chatgpt.com")
}

func NamespacedToolName(tool types.Tool) string {
	if strings.TrimSpace(tool.Namespace) == "" {
		return tool.Name
	}
	return tool.Namespace + "." + tool.Name
}

// BuildToolCatalogNudge returns bounded, deterministic provider-neutral guidance.
func BuildToolCatalogNudge(names []string) string {
	seen := make(map[string]struct{}, len(names))
	unique := make([]string, 0, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		unique = append(unique, name)
		if len(unique) == maxToolNudgeNames {
			break
		}
	}
	if len(unique) == 0 {
		return ""
	}
	quoted := quoteToolNames(unique)
	unavailable := make([]string, 0, len(neighboringToolNames))
	for _, name := range neighboringToolNames {
		if _, exists := seen[name]; !exists {
			unavailable = append(unavailable, name)
		}
	}
	parts := []string{
		"Tool contract: use the current tool catalog as ground truth.",
		fmt.Sprintf("Valid tool names for this turn are exactly %s.", quoted),
		"Call only listed names with their listed argument keys; do not invent, translate, or rename tools.",
	}
	if len(unavailable) > 0 {
		parts = append(parts, fmt.Sprintf("Do not use neighboring-agent tool names %s unless this turn's catalog lists those exact names.", quoteToolNames(unavailable)))
	}
	parts = append(parts,
		"If you need shell, file search, file read, edit, or discovery behavior, choose the listed tool that provides that capability.",
		"Count a tool call only after its tool result returns; batch independent read-only calls when the runtime supports it.",
	)
	return strings.Join(parts, " ")
}

func quoteToolNames(names []string) string {
	quoted := make([]string, len(names))
	for i, name := range names {
		quoted[i] = "`" + name + "`"
	}
	return strings.Join(quoted, ", ")
}

func BuildToolCatalogNudgeForTools(tools []types.Tool) string {
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, NamespacedToolName(tool))
	}
	return BuildToolCatalogNudge(names)
}

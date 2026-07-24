package search

import (
	"encoding/json"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const ToolName = "web_search"

// SyntheticTool is the function-tool equivalent exposed to routed models that
// cannot execute OpenAI's hosted web_search tool themselves.
func SyntheticTool() types.Tool {
	return types.Tool{
		Name: ToolName,
		Description: "Search the web for current, real-world, or post-training-cutoff information. " +
			"Returns a concise answer synthesized from live results, with sources.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{"type": "string", "description": "A focused natural-language search query."},
				"queries": map[string]any{
					"type": "array", "items": map[string]any{"type": "string"},
					"description": "Several independent search queries to run together.",
				},
			},
		},
	}
}

// BuildWebSearchTool is the descriptive public alias used by integration code.
func BuildWebSearchTool() types.Tool { return SyntheticTool() }

// ExtractHostedTool returns the first Responses hosted web_search tool without
// altering its provider-specific filters, location, or context-size fields.
func ExtractHostedTool(raw json.RawMessage) (map[string]any, bool) {
	var body struct {
		Tools []map[string]any `json:"tools"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &body) != nil {
		return nil, false
	}
	for _, tool := range body.Tools {
		if tool["type"] == ToolName {
			return cloneMap(tool), true
		}
	}
	return nil, false
}

func hasSyntheticTool(tools []types.Tool) bool {
	for _, tool := range tools {
		if tool.Name == ToolName {
			return true
		}
	}
	return false
}

func cloneMap(input map[string]any) map[string]any {
	output := make(map[string]any, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

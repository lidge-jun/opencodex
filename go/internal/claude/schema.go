package claude

import (
	"encoding/json"
	"fmt"
)

type ResponsesRequest struct {
	Model              string           `json:"model"`
	Input              any              `json:"input,omitempty"`
	Instructions       *string          `json:"instructions,omitempty"`
	Tools              []map[string]any `json:"tools,omitempty"`
	ToolChoice         any              `json:"tool_choice,omitempty"`
	MaxOutputTokens    *int             `json:"max_output_tokens,omitempty"`
	Temperature        *float64         `json:"temperature,omitempty"`
	TopP               *float64         `json:"top_p,omitempty"`
	Stop               any              `json:"stop,omitempty"`
	Stream             bool             `json:"stream,omitempty"`
	Reasoning          map[string]any   `json:"reasoning,omitempty"`
	Store              *bool            `json:"store,omitempty"`
	PreviousResponseID string           `json:"previous_response_id,omitempty"`
	ParallelToolCalls  *bool            `json:"parallel_tool_calls,omitempty"`
	PromptCacheKey     string           `json:"prompt_cache_key,omitempty"`
	ServiceTier        string           `json:"service_tier,omitempty"`
}

func ValidateResponsesRequest(raw []byte) (ResponsesRequest, error) {
	var request ResponsesRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return request, fmt.Errorf("responses parse error: %w", err)
	}
	if request.Model == "" {
		return request, fmt.Errorf("responses parse error: model is required")
	}
	switch input := request.Input.(type) {
	case nil, string:
	case []any:
		for i, rawItem := range input {
			item, ok := rawItem.(map[string]any)
			if !ok {
				return request, fmt.Errorf("responses parse error: input[%d] must be an object", i)
			}
			if err := validateInputItem(item); err != nil {
				return request, fmt.Errorf("responses parse error: input[%d]: %w", i, err)
			}
		}
	default:
		return request, fmt.Errorf("responses parse error: input must be a string or array")
	}
	for i, tool := range request.Tools {
		if toolType, _ := tool["type"].(string); toolType == "function" {
			if name, _ := tool["name"].(string); name == "" {
				return request, fmt.Errorf("responses parse error: tools[%d].name is required", i)
			}
		}
	}
	if request.MaxOutputTokens != nil && *request.MaxOutputTokens < 0 {
		return request, fmt.Errorf("responses parse error: max_output_tokens must be non-negative")
	}
	if err := validateToolChoice(request.ToolChoice); err != nil {
		return request, fmt.Errorf("responses parse error: %w", err)
	}
	return request, nil
}

func validateInputItem(item map[string]any) error {
	t, _ := item["type"].(string)
	role, _ := item["role"].(string)
	if t == "" && role != "" {
		t = "message"
	}
	switch t {
	case "message":
		if role != "user" && role != "developer" && role != "system" && role != "assistant" {
			return fmt.Errorf("unsupported message role %q", role)
		}
	case "function_call", "custom_tool_call":
		if stringField(item, "call_id") == "" || stringField(item, "name") == "" {
			return fmt.Errorf("%s requires call_id and name", t)
		}
	case "function_call_output", "custom_tool_call_output":
		if stringField(item, "call_id") == "" {
			return fmt.Errorf("%s requires call_id", t)
		}
	case "reasoning", "compaction", "compaction_summary", "context_compaction", "compaction_trigger", "additional_tools", "agent_message", "local_shell_call", "web_search_call", "tool_search_call", "tool_search_output":
	case "":
		return fmt.Errorf("item type is required")
	}
	return nil
}

func validateToolChoice(choice any) error {
	if choice == nil {
		return nil
	}
	if s, ok := choice.(string); ok {
		if s == "auto" || s == "none" || s == "required" {
			return nil
		}
		return fmt.Errorf("unsupported tool_choice %q", s)
	}
	obj, ok := choice.(map[string]any)
	if !ok {
		return fmt.Errorf("tool_choice must be a string or object")
	}
	t := stringField(obj, "type")
	if (t == "function" || t == "custom") && stringField(obj, "name") == "" {
		return fmt.Errorf("tool_choice %s requires name", t)
	}
	return nil
}

func stringField(m map[string]any, key string) string { v, _ := m[key].(string); return v }

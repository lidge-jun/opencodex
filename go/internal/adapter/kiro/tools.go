package kiro

import (
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const defaultToolDescriptionLimit = 1024
const solToolDescriptionLimit = 9_216

var rejectedSchemaKeys = map[string]struct{}{
	"additionalProperties": {}, "pattern": {}, "format": {}, "minLength": {}, "maxLength": {},
	"minimum": {}, "maximum": {}, "exclusiveMinimum": {}, "exclusiveMaximum": {}, "multipleOf": {},
	"minItems": {}, "maxItems": {}, "uniqueItems": {}, "minProperties": {}, "maxProperties": {},
	"contentEncoding": {}, "contentMediaType": {}, "$schema": {}, "patternProperties": {},
	"propertyNames": {}, "dependentSchemas": {}, "dependentRequired": {}, "if": {}, "then": {},
	"else": {}, "contains": {}, "unevaluatedProperties": {}, "unevaluatedItems": {}, "encrypted": {},
}

func wireToolName(tool types.Tool) string {
	if tool.Namespace == "" {
		return tool.Name
	}
	return tool.Namespace + "__" + tool.Name
}

func ConvertTools(req *types.NormalizedRequest, registry *ToolNameRegistry) ([]map[string]any, error) {
	if registry == nil {
		registry = NewToolNameRegistry()
	}
	for _, tool := range req.Context.Tools {
		if _, err := registry.Alias(wireToolName(tool)); err != nil {
			return nil, err
		}
	}
	if toolChoiceNone(req.Options.ToolChoice) {
		return nil, nil
	}
	limit := defaultToolDescriptionLimit
	if MapModelID(req.ModelID) == "gpt-5.6-sol" {
		limit = solToolDescriptionLimit
	}
	out := make([]map[string]any, 0, len(req.Context.Tools))
	for _, tool := range req.Context.Tools {
		name, _ := registry.Alias(wireToolName(tool))
		description := tool.Description
		if description == "" {
			description = "Tool: " + tool.Name
		}
		if len(description) > limit {
			description = description[:limit-1] + "…"
		}
		schema := ensureRootObject(sanitizeSchema(tool.Parameters))
		out = append(out, map[string]any{"toolSpecification": map[string]any{
			"name": name, "description": description, "inputSchema": map[string]any{"json": schema},
		}})
	}
	return out, nil
}

func toolChoiceNone(raw []byte) bool {
	trimmed := strings.TrimSpace(string(raw))
	return trimmed == `"none"` || trimmed == "none"
}

func sanitizeSchema(value any) any {
	switch current := value.(type) {
	case []any:
		out := make([]any, len(current))
		for i, child := range current {
			out[i] = sanitizeSchema(child)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(current))
		for key, child := range current {
			if _, rejected := rejectedSchemaKeys[key]; rejected {
				continue
			}
			if key == "required" {
				if values, ok := child.([]any); ok && len(values) == 0 {
					continue
				}
			}
			if key == "properties" || key == "$defs" || key == "definitions" {
				propertyMap, _ := child.(map[string]any)
				clean := make(map[string]any, len(propertyMap))
				for name, schema := range propertyMap {
					clean[name] = sanitizeSchema(schema)
				}
				out[key] = clean
			} else {
				out[key] = sanitizeSchema(child)
			}
		}
		return out
	default:
		return value
	}
}

func ensureRootObject(value any) map[string]any {
	obj, ok := value.(map[string]any)
	if !ok {
		obj = map[string]any{}
	}
	composition := false
	for _, key := range []string{"oneOf", "anyOf", "allOf"} {
		if _, ok := obj[key].([]any); ok {
			composition = true
		}
	}
	if !composition {
		clone := cloneMap(obj)
		clone["type"] = "object"
		return clone
	}
	properties := map[string]any{}
	required := map[string]struct{}{}
	mergeProperties(obj["properties"], properties)
	mergeRequired(obj["required"], required)
	for _, key := range []string{"oneOf", "anyOf", "allOf"} {
		variants, _ := obj[key].([]any)
		for _, raw := range variants {
			variant, _ := raw.(map[string]any)
			mergeProperties(variant["properties"], properties)
			if key == "allOf" {
				mergeRequired(variant["required"], required)
			}
		}
	}
	out := map[string]any{}
	for key, child := range obj {
		if key != "oneOf" && key != "anyOf" && key != "allOf" && key != "type" && key != "properties" && key != "required" {
			out[key] = child
		}
	}
	out["type"] = "object"
	if len(properties) > 0 {
		out["properties"] = properties
	}
	if len(required) > 0 {
		values := make([]string, 0, len(required))
		for key := range required {
			values = append(values, key)
		}
		out["required"] = values
	}
	return out
}

func cloneMap(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for k, v := range input {
		out[k] = v
	}
	return out
}
func mergeProperties(value any, out map[string]any) {
	if values, ok := value.(map[string]any); ok {
		for k, v := range values {
			out[k] = sanitizeSchema(v)
		}
	}
}
func mergeRequired(value any, out map[string]struct{}) {
	for _, raw := range anySlice(value) {
		if key, ok := raw.(string); ok {
			out[key] = struct{}{}
		}
	}
}
func anySlice(value any) []any {
	switch v := value.(type) {
	case []any:
		return v
	case []string:
		out := make([]any, len(v))
		for i, s := range v {
			out[i] = s
		}
		return out
	default:
		return nil
	}
}

func completionTool() map[string]any {
	return map[string]any{"toolSpecification": map[string]any{
		"name":        CompletionToolName,
		"description": "Finish the task and return the complete user-facing final answer. Call only when no more work or tool calls are needed.",
		"inputSchema": map[string]any{"json": map[string]any{"type": "object", "properties": map[string]any{"answer": map[string]any{"type": "string", "description": "The complete final answer to show the user."}}, "required": []string{"answer"}}},
	}}
}

func validateCapabilities(req *types.NormalizedRequest) error {
	choice := strings.TrimSpace(string(req.Options.ToolChoice))
	if choice != "" && choice != `"auto"` && choice != `"none"` && choice != "auto" && choice != "none" {
		return fmt.Errorf("Kiro supports only automatic tool choice or tool_choice:none")
	}
	if req.Options.ParallelToolCalls != nil && *req.Options.ParallelToolCalls {
		return fmt.Errorf("Kiro does not support parallel tool calls")
	}
	if req.Options.ServiceTier != "" {
		return fmt.Errorf("Kiro does not support service tiers")
	}
	return nil
}

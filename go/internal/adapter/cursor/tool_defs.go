package cursor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	coretypes "github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	ResponsesToolProvider = "opencodex-responses"
	ExecCommandTool       = "exec_command"
	ApplyPatchTool        = "apply_patch"
)

type ToolChoice struct {
	Mode, Name   string
	AllowedTools []string
}

var ExecCommandInputSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"cmd":               map[string]any{"type": "string", "description": "Shell command to execute."},
		"workdir":           map[string]any{"type": "string", "description": "Working directory for the command."},
		"shell":             map[string]any{"type": "string", "description": "Shell binary to launch."},
		"tty":               map[string]any{"type": "boolean", "description": "Whether to allocate a PTY."},
		"yield_time_ms":     map[string]any{"type": "number"},
		"max_output_tokens": map[string]any{"type": "number"},
	},
	"required": []any{"cmd"}, "additionalProperties": false,
}

func ParseToolChoice(raw json.RawMessage) ToolChoice {
	if len(raw) == 0 {
		return ToolChoice{Mode: "auto"}
	}
	var mode string
	if json.Unmarshal(raw, &mode) == nil {
		return ToolChoice{Mode: mode}
	}
	var object struct {
		Type, Name   string
		AllowedTools []string `json:"allowed_tools"`
		Function     struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	if json.Unmarshal(raw, &object) != nil {
		return ToolChoice{Mode: "auto"}
	}
	if object.Name == "" {
		object.Name = object.Function.Name
	}
	if len(object.AllowedTools) > 0 {
		return ToolChoice{Mode: "allowed", AllowedTools: object.AllowedTools}
	}
	return ToolChoice{Mode: object.Type, Name: object.Name}
}

func BuildCursorToolDefinitions(tools []coretypes.Tool, choice ToolChoice) ([]MCPToolDefinition, error) {
	out := make([]MCPToolDefinition, 0, len(tools))
	for _, tool := range tools {
		if !toolAllowed(tool, choice) {
			continue
		}
		name := wireToolName(tool)
		schema := tool.Parameters
		if schema == nil {
			schema = map[string]any{}
		}
		if tool.Namespace == "" && tool.Name == ExecCommandTool {
			schema = ExecCommandInputSchema
		}
		encoded, err := encodeProtoValue(schema)
		if err != nil {
			return nil, fmt.Errorf("tool %s schema: %w", name, err)
		}
		out = append(out, MCPToolDefinition{Name: name, ToolName: name, Provider: ResponsesToolProvider, Description: tool.Description, InputSchema: encoded})
	}
	return out, nil
}

func wireToolName(tool coretypes.Tool) string {
	if tool.Namespace == "" {
		return tool.Name
	}
	return tool.Namespace + "__" + tool.Name
}
func toolAllowed(tool coretypes.Tool, choice ToolChoice) bool {
	name := wireToolName(tool)
	switch choice.Mode {
	case "none":
		return false
	case "allowed":
		for _, allowed := range choice.AllowedTools {
			if allowed == name || allowed == tool.Name {
				return true
			}
		}
		return false
	case "function", "tool":
		return choice.Name == name || choice.Name == tool.Name
	default:
		if choice.Name != "" {
			return choice.Name == name || choice.Name == tool.Name
		}
		return true
	}
}
func NormalizeCursorToolName(name string) string {
	prefix := "mcp_" + ResponsesToolProvider + "_"
	return strings.TrimPrefix(name, prefix)
}

func CursorMCPToolsEncodedSize(defs []MCPToolDefinition) int {
	total := 0
	for _, def := range defs {
		size := cursorToolDefinitionSize(def)
		total += 1 + uvarintSize(uint64(size)) + size
	}
	return total
}
func CursorMCPToolEncodedSize(def MCPToolDefinition) int {
	size := cursorToolDefinitionSize(def)
	return 1 + uvarintSize(uint64(size)) + size
}
func cursorToolDefinitionSize(def MCPToolDefinition) int { return len(marshalTool(def)) }
func uvarintSize(value uint64) int {
	size := 1
	for value >= 128 {
		value >>= 7
		size++
	}
	return size
}

// encodeProtoValue normalizes JSON-compatible schemas before using WP19's wire owner.
func encodeProtoValue(value any) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var normalized any
	if err := decoder.Decode(&normalized); err != nil {
		return nil, err
	}
	return MarshalValue(normalized)
}

func BuildToolGuidance(tools []coretypes.Tool, choice ToolChoice) string {
	names := make([]string, 0, len(tools))
	hasExec := false
	hasPatch := false
	for _, tool := range tools {
		if !toolAllowed(tool, choice) {
			continue
		}
		name := wireToolName(tool)
		names = append(names, name)
		hasExec = hasExec || name == ExecCommandTool
		hasPatch = hasPatch || name == ApplyPatchTool
	}
	if len(names) == 0 {
		return ""
	}
	parts := []string{"Cursor tool calls: available tool names are exactly `" + strings.Join(names, "`, `") + "`.", "Call only those exact names with their listed argument keys."}
	if hasExec {
		parts = append(parts, "`exec_command` is the Codex Responses bridge exec tool, not an external MCP server tool.")
	}
	if hasPatch {
		parts = append(parts, "Use `apply_patch` for file edits instead of built-in file mutation tools.")
	}
	return strings.Join(parts, " ")
}

package cursor

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	coretypes "github.com/lidge-jun/opencodex-go/internal/types"
)

func TestBuildCursorToolDefinitionsMapsNamesChoiceAndSchema(t *testing.T) {
	tools := []coretypes.Tool{
		{Name: "exec_command", Description: "run"},
		{Namespace: "github", Name: "get_issue", Description: "get", Parameters: map[string]any{"type": "object", "properties": map[string]any{"id": map[string]any{"type": "string"}}}},
	}
	defs, err := BuildCursorToolDefinitions(tools, ToolChoice{Mode: "allowed", AllowedTools: []string{"github__get_issue"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(defs) != 1 || defs[0].Name != "github__get_issue" || defs[0].ToolName != "github__get_issue" || defs[0].Provider != ResponsesToolProvider {
		t.Fatalf("definition = %#v", defs)
	}
	if len(defs[0].InputSchema) == 0 {
		t.Fatal("protobuf Value schema is empty")
	}
	if got := CursorMCPToolsEncodedSize(defs); got != CursorMCPToolEncodedSize(defs[0]) {
		t.Fatalf("catalog size mismatch: %d", got)
	}
}

func TestCursorMCPToolEncodedSizeMatchesWireFields(t *testing.T) {
	def := MCPToolDefinition{Name: "a", Provider: "p", ToolName: "t", Description: "d", InputSchema: []byte{0x2a, 0x00}}
	// Five length-delimited fields total 16 bytes, wrapped as repeated McpTools field 1.
	if got := CursorMCPToolEncodedSize(def); got != 18 {
		t.Fatalf("encoded size = %d, want 18", got)
	}
}

func TestParseToolChoiceAndNormalizeDisplayName(t *testing.T) {
	choice := ParseToolChoice(json.RawMessage(`{"type":"function","function":{"name":"github__get_issue"}}`))
	if choice.Name != "github__get_issue" {
		t.Fatalf("choice = %#v", choice)
	}
	if got := NormalizeCursorToolName("mcp_opencodex-responses_exec_command"); got != "exec_command" {
		t.Fatalf("normalized = %q", got)
	}
}

type fakeMCPClient struct {
	tools                     []MCPTool
	resources                 []MCPResource
	initErr, errorOnResources error
}

func (f *fakeMCPClient) Initialize(context.Context) error             { return f.initErr }
func (f *fakeMCPClient) ListTools(context.Context) ([]MCPTool, error) { return f.tools, nil }
func (f *fakeMCPClient) CallTool(context.Context, string, map[string]any) (MCPCallResult, error) {
	return MCPCallResult{Content: []MCPContent{{Type: "text", Text: "ok"}}}, nil
}
func (f *fakeMCPClient) ListResources(context.Context) ([]MCPResource, error) {
	return f.resources, f.errorOnResources
}
func (f *fakeMCPClient) ReadResource(context.Context, string) (MCPResourceContent, error) {
	return MCPResourceContent{}, nil
}
func (f *fakeMCPClient) Close() error { return nil }

func TestMCPManagerIsolatesServerFailures(t *testing.T) {
	enabled := true
	servers := []ResolvedMCPServer{{ServerName: "bad", MCPServerConfig: MCPServerConfig{Command: "bad", Enabled: &enabled}}, {ServerName: "good", MCPServerConfig: MCPServerConfig{Command: "good", Enabled: &enabled, ToolPrefix: "x_"}}}
	manager := NewMCPManager(servers, MCPManagerOptions{ClientFactory: func(server ResolvedMCPServer) (MCPClient, error) {
		if server.ServerName == "bad" {
			return &fakeMCPClient{initErr: errors.New("offline")}, nil
		}
		return &fakeMCPClient{tools: []MCPTool{{Name: "tool"}}}, nil
	}})
	t.Cleanup(func() { _ = manager.Close() })
	handles := manager.ToolHandles(context.Background())
	if len(handles) != 1 || handles[0].AdvertisedName != "x_tool" {
		t.Fatalf("handles = %#v", handles)
	}
}

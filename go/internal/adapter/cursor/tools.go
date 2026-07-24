package cursor

import (
	"context"
	"errors"
	"fmt"
)

type ToolOperation string

const (
	ToolCallMCP       ToolOperation = "mcp"
	ToolListResources ToolOperation = "list_resources"
	ToolReadResource  ToolOperation = "read_resource"
)

type ToolRequest struct {
	Operation                             ToolOperation
	ProviderIdentifier, Name, Server, URI string
	Arguments                             map[string]any
}
type ToolResult struct {
	IsError        bool
	Content        []MCPContent
	AvailableTools []string
	Resources      []MCPResource
	Resource       *MCPResourceContent
}

type ToolDispatcher struct {
	MCP     *MCPManager
	Desktop *DesktopExecutor
}

func (d *ToolDispatcher) Definitions(ctx context.Context) []MCPToolDefinition {
	if d == nil || d.MCP == nil {
		return nil
	}
	handles := d.MCP.ToolHandles(ctx)
	out := make([]MCPToolDefinition, 0, len(handles))
	for _, handle := range handles {
		schema, err := encodeProtoValue(handle.InputSchema)
		if err != nil {
			continue
		}
		out = append(out, MCPToolDefinition{Name: handle.AdvertisedName, ToolName: handle.AdvertisedName, Provider: "opencodex", Description: handle.Description, InputSchema: schema})
	}
	return out
}

func (d *ToolDispatcher) Dispatch(ctx context.Context, req ToolRequest) (ToolResult, error) {
	if d == nil || d.MCP == nil {
		return ToolResult{}, errors.New("no local MCP executor is configured")
	}
	switch req.Operation {
	case ToolCallMCP:
		if req.ProviderIdentifier == ResponsesToolProvider {
			return ToolResult{}, errors.New("Responses client tools must not execute through the local MCP channel")
		}
		name := NormalizeCursorToolName(req.Name)
		result, err := d.MCP.CallTool(ctx, name, req.Arguments)
		if err != nil {
			names := d.MCP.ToolNames(ctx)
			if len(names) > 0 {
				return ToolResult{IsError: true, AvailableTools: names}, err
			}
			return ToolResult{}, err
		}
		return ToolResult{IsError: result.IsError, Content: result.Content}, nil
	case ToolListResources:
		resources, err := d.MCP.ListResources(ctx, req.Server)
		return ToolResult{Resources: resources}, err
	case ToolReadResource:
		resource, err := d.MCP.ReadResource(ctx, req.Server, req.URI)
		if err != nil {
			return ToolResult{}, err
		}
		return ToolResult{Resource: &resource}, nil
	default:
		return ToolResult{}, fmt.Errorf("unknown tool operation %q", req.Operation)
	}
}

func (d *ToolDispatcher) ComputerUse(ctx context.Context, req ComputerUseRequest) (ComputerUseResult, error) {
	if d == nil || d.Desktop == nil {
		return ComputerUseResult{}, errors.New("computer-use is not supported in this headless proxy")
	}
	return d.Desktop.ComputerUse(ctx, req)
}
func (d *ToolDispatcher) RecordScreen(ctx context.Context, req RecordScreenRequest) (RecordScreenResult, error) {
	if d == nil || d.Desktop == nil {
		return RecordScreenResult{}, errors.New("record-screen is not supported in this headless proxy")
	}
	return d.Desktop.RecordScreen(ctx, req)
}

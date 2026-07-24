package cursor

import (
	"context"
	"errors"
	"fmt"
)

type ExecKind string

const (
	ExecRequestContext  ExecKind = "request_context"
	ExecRead            ExecKind = "read"
	ExecWrite           ExecKind = "write"
	ExecDelete          ExecKind = "delete"
	ExecList            ExecKind = "list"
	ExecGrep            ExecKind = "grep"
	ExecShell           ExecKind = "shell"
	ExecShellStream     ExecKind = "shell_stream"
	ExecBackgroundShell ExecKind = "background_shell"
	ExecWriteShellStdin ExecKind = "write_shell_stdin"
	ExecFetch           ExecKind = "fetch"
	ExecMCP             ExecKind = "mcp"
	ExecListResources   ExecKind = "list_mcp_resources"
	ExecReadResource    ExecKind = "read_mcp_resource"
	ExecComputerUse     ExecKind = "computer_use"
	ExecRecordScreen    ExecKind = "record_screen"
)

// ExecRequest is the transport-neutral native-exec oneof. WP19 owns protobuf decoding.
type ExecRequest struct {
	ID, ExecID   string
	Kind         ExecKind
	Read         *ReadRequest
	Write        *WriteRequest
	Delete       *DeleteRequest
	List         *ListRequest
	Grep         *GrepRequest
	Shell        *ShellRequest
	ShellID      int64
	Stdin        string
	Fetch        *FetchRequest
	Tool         *ToolRequest
	ComputerUse  *ComputerUseRequest
	RecordScreen *RecordScreenRequest
}

type ExecResponse struct {
	ID, ExecID string
	Kind       ExecKind
	Value      any
	Error      string
}

type NativeExecutor struct {
	Filesystem            *FilesystemExecutor
	Shell                 *ShellExecutor
	Network               *NetworkExecutor
	Tools                 *ToolDispatcher
	Blobs                 *KVStore
	ClientToolDefinitions []MCPToolDefinition
}

func NewNativeExecutor(policy ExecPolicy, tools *ToolDispatcher) *NativeExecutor {
	blobs := NewKVStore(nil)
	return &NativeExecutor{Filesystem: &FilesystemExecutor{Policy: policy, Blobs: blobs}, Shell: NewShellExecutor(policy), Network: &NetworkExecutor{Policy: policy}, Tools: tools, Blobs: blobs}
}

func (e *NativeExecutor) Execute(ctx context.Context, req ExecRequest) []ExecResponse {
	response := func(value any, err error) []ExecResponse {
		out := ExecResponse{ID: req.ID, ExecID: req.ExecID, Kind: req.Kind, Value: value}
		if err != nil {
			out.Error = err.Error()
		}
		return []ExecResponse{out}
	}
	switch req.Kind {
	case ExecRequestContext:
		defs := append([]MCPToolDefinition(nil), e.ClientToolDefinitions...)
		if e.Tools != nil {
			defs = append(defs, e.Tools.Definitions(ctx)...)
		}
		return response(defs, nil)
	case ExecRead:
		if req.Read == nil {
			return response(nil, missingPayload(req.Kind))
		}
		value, err := e.Filesystem.Read(*req.Read)
		return response(value, err)
	case ExecWrite:
		if req.Write == nil {
			return response(nil, missingPayload(req.Kind))
		}
		value, err := e.Filesystem.Write(*req.Write)
		return response(value, err)
	case ExecDelete:
		if req.Delete == nil {
			return response(nil, missingPayload(req.Kind))
		}
		value, err := e.Filesystem.Delete(*req.Delete)
		return response(value, err)
	case ExecList:
		if req.List == nil {
			return response(nil, missingPayload(req.Kind))
		}
		value, err := e.Filesystem.List(*req.List)
		return response(value, err)
	case ExecGrep:
		if req.Grep == nil {
			return response(nil, missingPayload(req.Kind))
		}
		value, err := e.Filesystem.Grep(*req.Grep)
		return response(value, err)
	case ExecShell:
		if req.Shell == nil {
			return response(nil, missingPayload(req.Kind))
		}
		value, err := e.Shell.Run(ctx, *req.Shell)
		return response(value, err)
	case ExecShellStream:
		if req.Shell == nil {
			return response(nil, missingPayload(req.Kind))
		}
		events, err := e.Shell.Stream(ctx, *req.Shell)
		if err != nil {
			return response(nil, err)
		}
		out := make([]ExecResponse, 0)
		for event := range events {
			out = append(out, ExecResponse{ID: req.ID, ExecID: req.ExecID, Kind: req.Kind, Value: event})
		}
		return out
	case ExecBackgroundShell:
		if req.Shell == nil {
			return response(nil, missingPayload(req.Kind))
		}
		value, err := e.Shell.StartBackground(ctx, *req.Shell)
		return response(value, err)
	case ExecWriteShellStdin:
		value, err := e.Shell.WriteStdin(req.ShellID, req.Stdin)
		return response(value, err)
	case ExecFetch:
		if req.Fetch == nil {
			return response(nil, missingPayload(req.Kind))
		}
		value, err := e.Network.Fetch(ctx, *req.Fetch)
		return response(value, err)
	case ExecMCP, ExecListResources, ExecReadResource:
		if e.Tools == nil {
			return response(nil, errors.New("no local MCP executor is configured"))
		}
		tool := ToolRequest{}
		if req.Tool != nil {
			tool = *req.Tool
		}
		switch req.Kind {
		case ExecMCP:
			if req.Tool == nil {
				return response(nil, missingPayload(req.Kind))
			}
			tool.Operation = ToolCallMCP
		case ExecListResources:
			tool.Operation = ToolListResources
		case ExecReadResource:
			if req.Tool == nil {
				return response(nil, missingPayload(req.Kind))
			}
			tool.Operation = ToolReadResource
		}
		value, err := e.Tools.Dispatch(ctx, tool)
		return response(value, err)
	case ExecComputerUse:
		if e.Tools == nil || req.ComputerUse == nil {
			return response(nil, errors.New("computer-use executor is not configured"))
		}
		value, err := e.Tools.ComputerUse(ctx, *req.ComputerUse)
		return response(value, err)
	case ExecRecordScreen:
		if e.Tools == nil || req.RecordScreen == nil {
			return response(nil, errors.New("record-screen executor is not configured"))
		}
		value, err := e.Tools.RecordScreen(ctx, *req.RecordScreen)
		return response(value, err)
	default:
		// Unknown cases are intentionally ignored so a new Cursor oneof cannot kill the stream.
		return nil
	}
}

// ExecuteStreaming preserves real-time shell delivery. Other requests emit their normal replies.
func (e *NativeExecutor) ExecuteStreaming(ctx context.Context, req ExecRequest, emit func(ExecResponse) error) error {
	if req.Kind != ExecShellStream {
		for _, response := range e.Execute(ctx, req) {
			if err := emit(response); err != nil {
				return err
			}
		}
		return nil
	}
	if req.Shell == nil {
		return missingPayload(req.Kind)
	}
	events, err := e.Shell.Stream(ctx, *req.Shell)
	if err != nil {
		return err
	}
	for event := range events {
		if err := emit(ExecResponse{ID: req.ID, ExecID: req.ExecID, Kind: req.Kind, Value: event}); err != nil {
			return err
		}
	}
	return nil
}

type KVRequest struct {
	ID                             string
	GetBlobID, SetBlobID, BlobData []byte
}
type KVResponse struct {
	ID       string
	BlobData []byte
	Found    bool
}

func (e *NativeExecutor) HandleKV(req KVRequest) KVResponse {
	if len(req.GetBlobID) > 0 {
		data, ok := e.Blobs.GetBlob(req.GetBlobID)
		return KVResponse{ID: req.ID, BlobData: data, Found: ok}
	}
	if len(req.SetBlobID) > 0 {
		e.Blobs.Set(fmt.Sprintf("%x", req.SetBlobID), req.BlobData)
		return KVResponse{ID: req.ID, Found: true}
	}
	return KVResponse{ID: req.ID}
}

func missingPayload(kind ExecKind) error { return fmt.Errorf("%s request payload is missing", kind) }

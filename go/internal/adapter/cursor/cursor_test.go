package cursor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestConnectFrameRoundTrip(t *testing.T) {
	want := ConnectFrame{Flags: ConnectFlagEndStream, Payload: []byte(`{"ok":true}`)}
	encoded, err := EncodeFrame(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ReadFrame(bytes.NewReader(encoded), 1024)
	if err != nil {
		t.Fatal(err)
	}
	if got.Flags != want.Flags || !bytes.Equal(got.Payload, want.Payload) {
		t.Fatalf("frame = %#v, want %#v", got, want)
	}
	if !got.EndStream() || got.Compressed() {
		t.Fatalf("flags not decoded: %#v", got)
	}
	if _, err := ReadFrame(bytes.NewReader(encoded[:4]), 1024); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("short header error = %v", err)
	}
}

func TestConnectEndStreamTrailer(t *testing.T) {
	if err := ParseEndStreamTrailer([]byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	err := ParseEndStreamTrailer([]byte(`{"error":{"code":"resource_exhausted","message":"quota"}}`))
	var connectErr *ConnectEndStreamError
	if !errors.As(err, &connectErr) || connectErr.Code != "resource_exhausted" {
		t.Fatalf("error = %#v", err)
	}
}

func TestEventParsingTextUsageAndTerminal(t *testing.T) {
	parser := NewEventParser()
	textUpdate := appendMessage(nil, 1, appendString(nil, 1, "hello"))
	events, err := parser.Parse(appendMessage(nil, 1, textUpdate))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != types.EventTextDelta || events[0].Text != "hello" {
		t.Fatalf("text events = %#v", events)
	}
	checkpoint := appendMessage(nil, 5, appendVarintField(nil, 1, 120))
	events, err = parser.Parse(appendMessage(nil, 3, checkpoint))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Usage == nil || events[0].Usage.TotalTokens != 120 {
		t.Fatalf("usage events = %#v", events)
	}
	tokenAndEnd := appendMessage(nil, 8, appendVarintField(nil, 1, 20))
	tokenAndEnd = appendMessage(tokenAndEnd, 14, nil)
	events, err = parser.Parse(appendMessage(nil, 1, tokenAndEnd))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != types.EventDone || events[0].Usage.InputTokens != 100 || events[0].Usage.OutputTokens != 20 {
		t.Fatalf("done events = %#v", events)
	}
}

func TestEventParsingAtomicToolCall(t *testing.T) {
	parser := NewEventParser()
	value, _ := MarshalValue("README.md")
	entry := appendString(nil, 1, "path")
	entry = appendBytes(entry, 2, value)
	args := appendString(nil, 4, cursorToolProvider)
	args = appendString(args, 5, "read_file")
	args = appendMessage(args, 2, entry)
	mcp := appendMessage(nil, 1, args)
	tool := appendMessage(nil, 15, mcp)
	started := appendString(nil, 1, "call-1")
	started = appendMessage(started, 2, tool)
	if events, err := parser.Parse(appendMessage(nil, 1, appendMessage(nil, 2, started))); err != nil || len(events) != 0 {
		t.Fatalf("start = %#v, %v", events, err)
	}
	completed := appendString(nil, 1, "call-1")
	completed = appendMessage(completed, 2, tool)
	events, err := parser.Parse(appendMessage(nil, 1, appendMessage(nil, 3, completed)))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].ToolCall == nil || events[0].ToolCall.Name != "read_file" {
		t.Fatalf("tool events = %#v", events)
	}
	var arguments map[string]any
	if err := json.Unmarshal(events[0].ToolCall.Arguments, &arguments); err != nil {
		t.Fatal(err)
	}
	if arguments["path"] != "README.md" {
		t.Fatalf("arguments = %#v", arguments)
	}
}

func TestKVBlobReply(t *testing.T) {
	blobID := []byte{1, 2, 3}
	query := appendVarintField(nil, 1, 7)
	query = appendMessage(query, 2, appendBytes(nil, 1, blobID))
	reply, err := marshalKVReply(query, map[string][]byte{"010203": []byte("blob")})
	if err != nil {
		t.Fatal(err)
	}
	client, err := parseFields(reply)
	if err != nil {
		t.Fatal(err)
	}
	if len(client) != 1 || client[0].Number != 3 {
		t.Fatalf("client reply = %#v", client)
	}
	kv, err := parseFields(client[0].Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(kv) != 2 || kv[0].Varint != 7 || kv[1].Number != 2 {
		t.Fatalf("kv reply = %#v", kv)
	}
}

func TestClassifyCursorErrors(t *testing.T) {
	tests := []struct {
		message string
		kind    ErrorKind
		status  int
	}{
		{"resource_exhausted: quota exceeded", ErrorQuota, 429},
		{"resource_exhausted: tool catalog too large", ErrorSize, 400},
		{"permission_denied", ErrorAuth, 401},
		{"connection reset by peer", ErrorTransport, 502},
		{"illegal tag: field no 0", ErrorProtocol, 502},
	}
	for _, test := range tests {
		got := ClassifyError(errors.New(test.message))
		if got.Kind != test.kind || got.StatusCode != test.status {
			t.Errorf("ClassifyError(%q) = %#v", test.message, got)
		}
	}
}

func TestCursorEffortMapping(t *testing.T) {
	if got := CursorEffortSuffix("claude-4.6-opus", "low"); got != "high" {
		t.Fatalf("low clamp = %q", got)
	}
	if got := CursorEffortSuffix("gpt-5.6-sol", "ultra"); got != "max" {
		t.Fatalf("ultra = %q", got)
	}
	if got := CursorEffortSuffix("composer-2.5", "high"); got != "" {
		t.Fatalf("composer suffix = %q", got)
	}
	model, parameters := CursorWireModel("cursor/auto-balance", "high")
	if model != "default" || parameters["optimization"] != "balance" {
		t.Fatalf("router = %q %#v", model, parameters)
	}
}

func TestBuildAgentRunRequest(t *testing.T) {
	req := &types.NormalizedRequest{ModelID: "cursor/gpt-5.6-sol", Metadata: map[string]string{"cursorConversationId": "conv-1"}, Options: types.RequestOptions{Reasoning: "medium"}, Context: types.RequestContext{
		SystemPrompt: []string{"system"}, Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}},
		Tools: []types.Tool{{Name: "read_file", Description: "read", Parameters: map[string]any{"type": "object"}}},
	}}
	built, err := BuildAgentRunRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	if built.Run.Model.ID != "gpt-5.6-sol-medium" || built.Run.ConversationID != "conv-1" {
		t.Fatalf("run = %#v", built.Run)
	}
	if built.Run.Action.UserMessage == nil || built.Run.Action.UserMessage.Text != "hello" || len(built.Run.Tools) != 1 {
		t.Fatalf("action/tools = %#v %#v", built.Run.Action, built.Run.Tools)
	}
	if len(built.Run.ConversationState.RootPromptBlobIDs) != 1 {
		t.Fatalf("blob ids = %d", len(built.Run.ConversationState.RootPromptBlobIDs))
	}
	for _, id := range built.Run.ConversationState.RootPromptBlobIDs {
		if _, ok := built.Blobs[fmt.Sprintf("%x", id)]; !ok {
			t.Fatalf("blob %x missing", id)
		}
	}
	wire, err := MarshalAgentClientRun(built.Run)
	if err != nil {
		t.Fatal(err)
	}
	fields, err := parseFields(wire)
	if err != nil {
		t.Fatal(err)
	}
	if len(fields) != 1 || fields[0].Number != 1 {
		t.Fatalf("client wire fields = %#v", fields)
	}
}

func TestPreCommitRetry(t *testing.T) {
	attempts := 0
	state := &testCommitState{}
	value, err := DoPreCommitRetry(context.Background(), func(context.Context, int) (string, CommitState, error) {
		attempts++
		if attempts == 1 {
			return "", state, errors.New("connection reset")
		}
		return "ok", state, nil
	})
	if err != nil || value != "ok" || attempts != 2 {
		t.Fatalf("retry = %q %d %v", value, attempts, err)
	}
}

type testCommitState struct{ committed bool }

func (s *testCommitState) RequestCommitted() bool { return s.committed }

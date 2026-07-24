package cursor

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	CursorToolCountLimit = 330
	CursorToolBytesLimit = 120_000
	cursorToolProvider   = "opencodex-responses"
)

type BuiltRequest struct {
	Run          AgentRunRequest
	Blobs        map[string][]byte
	OmittedTools []string
}

func BuildAgentRunRequest(req *types.NormalizedRequest) (*BuiltRequest, error) {
	if req == nil {
		return nil, fmt.Errorf("build Cursor request: nil normalized request")
	}
	modelID, parameters := CursorWireModel(req.ModelID, req.Options.Reasoning)
	conversationID := strings.TrimSpace(req.Metadata["cursorConversationId"])
	if conversationID == "" {
		conversationID = newID()
	}
	blobs := map[string][]byte{}
	system := append([]string(nil), req.Context.SystemPrompt...)
	if len(system) == 0 {
		system = []string{"You are a helpful assistant."}
	}
	rootIDs := make([][]byte, 0, len(system)+len(req.Context.Messages))
	for _, prompt := range system {
		id, err := storeJSONBlob(blobs, map[string]any{"role": "system", "content": prompt})
		if err != nil {
			return nil, err
		}
		rootIDs = append(rootIDs, id)
	}
	rootEnd := len(req.Context.Messages)
	if rootEnd > 0 {
		last := req.Context.Messages[rootEnd-1]
		if last.Role == "user" || last.Role == "developer" {
			rootEnd--
		}
	}
	for _, message := range req.Context.Messages[:rootEnd] {
		text := messageText(message.Content)
		if text == "" && message.ToolCallID == "" {
			continue
		}
		entry := map[string]any{"role": message.Role, "content": text}
		if message.ToolCallID != "" {
			entry["tool_call_id"] = message.ToolCallID
		}
		if message.ToolName != "" {
			entry["tool_name"] = message.ToolName
		}
		if message.IsError {
			entry["is_error"] = true
		}
		id, err := storeJSONBlob(blobs, entry)
		if err != nil {
			return nil, err
		}
		rootIDs = append(rootIDs, id)
	}
	tools, omitted, err := budgetTools(req.Context.Tools)
	if err != nil {
		return nil, err
	}
	lastRole, activeText := lastAction(req.Context.Messages)
	action := ConversationAction{TimeZone: time.Local.String()}
	if lastRole == "tool" || strings.TrimSpace(activeText) == "" {
		action.Resume = true
	} else {
		action.UserMessage = &UserMessage{Text: activeText, MessageID: newID()}
	}
	run := AgentRunRequest{
		ConversationState: ConversationState{RootPromptBlobIDs: rootIDs}, Action: action,
		Model: ModelDetails{ID: modelID, DisplayName: modelID}, Tools: tools,
		ConversationID: conversationID,
		Blobs:          blobs,
	}
	if len(parameters) > 0 {
		run.RequestedModel = &RequestedModel{ID: modelID, Parameters: parameters}
	}
	return &BuiltRequest{Run: run, Blobs: blobs, OmittedTools: omitted}, nil
}

func budgetTools(input []types.Tool) ([]MCPToolDefinition, []string, error) {
	kept := make([]MCPToolDefinition, 0, min(len(input), CursorToolCountLimit))
	var omitted []string
	bytesUsed := 0
	for _, tool := range input {
		name := tool.Name
		if tool.Namespace != "" {
			name = tool.Namespace + "__" + name
		}
		schema, err := json.Marshal(tool.Parameters)
		if err != nil {
			return nil, nil, fmt.Errorf("marshal Cursor tool %s schema: %w", name, err)
		}
		definition := MCPToolDefinition{Name: name, Provider: cursorToolProvider, ToolName: name, Description: tool.Description, InputSchema: schema}
		encodedSize := len(marshalTool(definition)) + 6
		if len(kept) >= CursorToolCountLimit || bytesUsed+encodedSize > CursorToolBytesLimit {
			omitted = append(omitted, name)
			continue
		}
		kept = append(kept, definition)
		bytesUsed += encodedSize
	}
	return kept, omitted, nil
}

func storeJSONBlob(store map[string][]byte, value any) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(data)
	store[hex.EncodeToString(digest[:])] = append([]byte(nil), data...)
	return append([]byte(nil), digest[:]...), nil
}

func lastAction(messages []types.Message) (string, string) {
	if len(messages) == 0 {
		return "", ""
	}
	last := messages[len(messages)-1]
	if last.Role == "toolResult" || last.Role == "tool" {
		return "tool", ""
	}
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" || messages[i].Role == "developer" {
			return messages[i].Role, messageText(messages[i].Content)
		}
	}
	return last.Role, messageText(last.Content)
}

func messageText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var parts []map[string]any
	if json.Unmarshal(raw, &parts) == nil {
		var values []string
		for _, part := range parts {
			for _, key := range []string{"text", "thinking", "content"} {
				if value, ok := part[key].(string); ok && value != "" {
					values = append(values, value)
					break
				}
			}
		}
		return strings.Join(values, "\n")
	}
	return string(raw)
}

func newID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return hex.EncodeToString([]byte(fmt.Sprint(time.Now().UnixNano())))
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[:4], raw[4:6], raw[6:8], raw[8:10], raw[10:])
}

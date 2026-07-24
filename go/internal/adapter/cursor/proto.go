package cursor

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"sort"
)

// These are the small, stable subset of agent.v1 used by the Cursor adapter.
// Keeping the wire encoder here avoids carrying the 15k-line generated schema.
type AgentRunRequest struct {
	ConversationState ConversationState
	Action            ConversationAction
	Model             ModelDetails
	RequestedModel    *RequestedModel
	Tools             []MCPToolDefinition
	ConversationID    string
	Blobs             map[string][]byte // local KV payloads; not encoded in AgentRunRequest
}

type ConversationState struct {
	RootPromptBlobIDs [][]byte
	Turns             [][]byte
}

type ConversationAction struct {
	UserMessage *UserMessage
	Resume      bool
	TimeZone    string
}

type UserMessage struct{ Text, MessageID string }
type ModelDetails struct{ ID, DisplayName string }
type RequestedModel struct {
	ID         string
	Parameters map[string]string
}
type MCPToolDefinition struct {
	Name, Provider, ToolName, Description string
	InputSchema                           []byte
}

type AgentServerMessage struct {
	Kind    ServerMessageKind
	Payload []byte
}

type ServerMessageKind uint8

const (
	ServerUnknown ServerMessageKind = iota
	ServerInteractionUpdate
	ServerKV
	ServerCheckpoint
	ServerInteractionQuery
)

type GetUsableModelsResponse struct{ Models []ModelDetails }

func MarshalAgentClientRun(req AgentRunRequest) ([]byte, error) {
	run, err := marshalRunRequest(req)
	if err != nil {
		return nil, err
	}
	return appendMessage(nil, 1, run), nil // AgentClientMessage.run_request
}

func marshalRunRequest(req AgentRunRequest) ([]byte, error) {
	var out []byte
	var state []byte
	for _, id := range req.ConversationState.RootPromptBlobIDs {
		state = appendBytes(state, 1, id)
	}
	for _, turn := range req.ConversationState.Turns {
		state = appendBytes(state, 8, turn)
	}
	out = appendMessage(out, 1, state)
	action, err := marshalAction(req.Action)
	if err != nil {
		return nil, err
	}
	out = appendMessage(out, 2, action)
	modelID := req.Model.ID
	model := appendString(nil, 1, modelID)
	model = appendString(model, 3, modelID)
	model = appendString(model, 4, firstNonEmpty(req.Model.DisplayName, modelID))
	model = appendString(model, 5, firstNonEmpty(req.Model.DisplayName, modelID))
	out = appendMessage(out, 3, model)
	if len(req.Tools) > 0 {
		var tools []byte
		for _, tool := range req.Tools {
			tools = appendMessage(tools, 1, marshalTool(tool))
		}
		out = appendMessage(out, 4, tools)
	}
	out = appendString(out, 5, req.ConversationID)
	if req.RequestedModel != nil {
		var requested []byte
		requested = appendString(requested, 1, req.RequestedModel.ID)
		parameterKeys := make([]string, 0, len(req.RequestedModel.Parameters))
		for key := range req.RequestedModel.Parameters {
			parameterKeys = append(parameterKeys, key)
		}
		sort.Strings(parameterKeys)
		for _, key := range parameterKeys {
			value := req.RequestedModel.Parameters[key]
			parameter := appendString(nil, 1, key)
			parameter = appendString(parameter, 2, value)
			requested = appendMessage(requested, 3, parameter)
		}
		out = appendMessage(out, 9, requested)
	}
	return out, nil
}

func marshalAction(action ConversationAction) ([]byte, error) {
	context := appendMessage(nil, 4, appendString(nil, 10, firstNonEmpty(action.TimeZone, "UTC")))
	if action.UserMessage != nil {
		user := appendString(nil, 1, action.UserMessage.Text)
		user = appendString(user, 2, action.UserMessage.MessageID)
		userAction := appendMessage(nil, 1, user)
		userAction = appendMessage(userAction, 2, context)
		return appendMessage(nil, 1, userAction), nil
	}
	if action.Resume {
		return appendMessage(nil, 2, appendMessage(nil, 2, context)), nil
	}
	return nil, fmt.Errorf("cursor action requires user message or resume")
}

func marshalTool(tool MCPToolDefinition) []byte {
	out := appendString(nil, 1, tool.Name)
	out = appendString(out, 2, tool.Description)
	out = appendBytes(out, 3, tool.InputSchema)
	out = appendString(out, 4, tool.Provider)
	out = appendString(out, 5, tool.ToolName)
	return out
}

func UnmarshalAgentServerMessage(data []byte) (AgentServerMessage, error) {
	fields, err := parseFields(data)
	if err != nil {
		return AgentServerMessage{}, fmt.Errorf("decode AgentServerMessage: %w", err)
	}
	for _, field := range fields {
		switch field.Number {
		case 1:
			return AgentServerMessage{Kind: ServerInteractionUpdate, Payload: field.Bytes}, nil
		case 3:
			return AgentServerMessage{Kind: ServerCheckpoint, Payload: field.Bytes}, nil
		case 4:
			return AgentServerMessage{Kind: ServerKV, Payload: field.Bytes}, nil
		case 7:
			return AgentServerMessage{Kind: ServerInteractionQuery, Payload: field.Bytes}, nil
		}
	}
	return AgentServerMessage{Kind: ServerUnknown}, nil
}

func marshalKVReply(data []byte, blobs map[string][]byte) ([]byte, error) {
	fields, err := parseFields(data)
	if err != nil {
		return nil, fmt.Errorf("decode Cursor KV request: %w", err)
	}
	var id uint64
	var get, set []byte
	for _, field := range fields {
		switch field.Number {
		case 1:
			id = field.Varint
		case 2:
			get = field.Bytes
		case 3:
			set = field.Bytes
		}
	}
	client := appendVarintField(nil, 1, id)
	if len(get) > 0 {
		request, err := parseFields(get)
		if err != nil {
			return nil, err
		}
		var blobID []byte
		for _, field := range request {
			if field.Number == 1 {
				blobID = field.Bytes
			}
		}
		result := []byte(nil)
		if value, ok := blobs[fmt.Sprintf("%x", blobID)]; ok {
			result = appendBytes(result, 1, value)
		}
		client = appendMessage(client, 2, result)
	} else if len(set) > 0 {
		request, err := parseFields(set)
		if err != nil {
			return nil, err
		}
		var blobID, value []byte
		for _, field := range request {
			if field.Number == 1 {
				blobID = field.Bytes
			}
			if field.Number == 2 {
				value = field.Bytes
			}
		}
		if len(blobID) > 0 {
			blobs[fmt.Sprintf("%x", blobID)] = append([]byte(nil), value...)
		}
		client = appendMessage(client, 3, nil)
	} else {
		return nil, fmt.Errorf("Cursor KV request has no operation")
	}
	return appendMessage(nil, 3, client), nil // AgentClientMessage.kv_client_message
}

func marshalEmptyInteractionReply(data []byte) ([]byte, error) {
	fields, err := parseFields(data)
	if err != nil {
		return nil, fmt.Errorf("decode Cursor interaction query: %w", err)
	}
	var id uint64
	for _, field := range fields {
		if field.Number == 1 {
			id = field.Varint
		}
	}
	response := appendVarintField(nil, 1, id)
	return appendMessage(nil, 6, response), nil // AgentClientMessage.interaction_response
}

func MarshalGetUsableModelsRequest(customIDs []string) []byte {
	var out []byte
	for _, id := range customIDs {
		out = appendString(out, 1, id)
	}
	return out
}

func UnmarshalGetUsableModelsResponse(data []byte) (GetUsableModelsResponse, error) {
	fields, err := parseFields(data)
	if err != nil {
		return GetUsableModelsResponse{}, err
	}
	response := GetUsableModelsResponse{}
	for _, field := range fields {
		if field.Number != 1 || field.Wire != 2 {
			continue
		}
		modelFields, err := parseFields(field.Bytes)
		if err != nil {
			return GetUsableModelsResponse{}, err
		}
		model := ModelDetails{}
		for _, mf := range modelFields {
			switch mf.Number {
			case 1:
				model.ID = string(mf.Bytes)
			case 4:
				model.DisplayName = string(mf.Bytes)
			}
		}
		if model.ID != "" {
			response.Models = append(response.Models, model)
		}
	}
	return response, nil
}

// MarshalValue encodes google.protobuf.Value. It is used for MCP argument maps.
func MarshalValue(value any) ([]byte, error) {
	switch v := value.(type) {
	case nil:
		return appendVarintField(nil, 1, 0), nil
	case bool:
		if v {
			return appendVarintField(nil, 4, 1), nil
		}
		return appendVarintField(nil, 4, 0), nil
	case string:
		return appendString(nil, 3, v), nil
	case float64:
		return appendFixed64(nil, 2, math.Float64bits(v)), nil
	case float32:
		return appendFixed64(nil, 2, math.Float64bits(float64(v))), nil
	case int:
		return appendFixed64(nil, 2, math.Float64bits(float64(v))), nil
	case int64:
		return appendFixed64(nil, 2, math.Float64bits(float64(v))), nil
	case json.Number:
		n, err := v.Float64()
		if err != nil {
			return nil, err
		}
		return appendFixed64(nil, 2, math.Float64bits(n)), nil
	case []any:
		var list []byte
		for _, item := range v {
			encoded, err := MarshalValue(item)
			if err != nil {
				return nil, err
			}
			list = appendMessage(list, 1, encoded)
		}
		return appendMessage(nil, 6, list), nil
	case map[string]any:
		var object []byte
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			item := v[key]
			encoded, err := MarshalValue(item)
			if err != nil {
				return nil, err
			}
			entry := appendString(nil, 1, key)
			entry = appendMessage(entry, 2, encoded)
			object = appendMessage(object, 1, entry)
		}
		return appendMessage(nil, 5, object), nil
	default:
		return nil, fmt.Errorf("unsupported protobuf Value type %T", value)
	}
}

func UnmarshalValue(data []byte) (any, error) {
	fields, err := parseFields(data)
	if err != nil {
		return nil, err
	}
	if len(fields) == 0 {
		return nil, nil
	}
	f := fields[len(fields)-1]
	switch f.Number {
	case 1:
		return nil, nil
	case 2:
		if f.Wire != 1 {
			return nil, fmt.Errorf("Value.number has wire %d", f.Wire)
		}
		return math.Float64frombits(f.Fixed), nil
	case 3:
		return string(f.Bytes), nil
	case 4:
		return f.Varint != 0, nil
	case 5:
		result := map[string]any{}
		object, err := parseFields(f.Bytes)
		if err != nil {
			return nil, err
		}
		for _, entryField := range object {
			if entryField.Number != 1 {
				continue
			}
			entry, err := parseFields(entryField.Bytes)
			if err != nil {
				return nil, err
			}
			var key string
			var raw []byte
			for _, ef := range entry {
				if ef.Number == 1 {
					key = string(ef.Bytes)
				}
				if ef.Number == 2 {
					raw = ef.Bytes
				}
			}
			value, err := UnmarshalValue(raw)
			if err != nil {
				return nil, err
			}
			result[key] = value
		}
		return result, nil
	case 6:
		var result []any
		list, err := parseFields(f.Bytes)
		if err != nil {
			return nil, err
		}
		for _, item := range list {
			if item.Number == 1 {
				value, err := UnmarshalValue(item.Bytes)
				if err != nil {
					return nil, err
				}
				result = append(result, value)
			}
		}
		return result, nil
	default:
		return nil, fmt.Errorf("unknown protobuf Value kind %d", f.Number)
	}
}

type wireField struct {
	Number, Wire  int
	Varint, Fixed uint64
	Bytes         []byte
}

func parseFields(data []byte) ([]wireField, error) {
	var fields []wireField
	for offset := 0; offset < len(data); {
		key, n := binary.Uvarint(data[offset:])
		if n <= 0 {
			return nil, fmt.Errorf("invalid field key at %d", offset)
		}
		offset += n
		field := wireField{Number: int(key >> 3), Wire: int(key & 7)}
		if field.Number == 0 {
			return nil, fmt.Errorf("illegal field zero")
		}
		switch field.Wire {
		case 0:
			value, n := binary.Uvarint(data[offset:])
			if n <= 0 {
				return nil, fmt.Errorf("invalid varint field %d", field.Number)
			}
			offset += n
			field.Varint = value
		case 1:
			if len(data)-offset < 8 {
				return nil, fmt.Errorf("truncated fixed64 field %d", field.Number)
			}
			field.Fixed = binary.LittleEndian.Uint64(data[offset:])
			offset += 8
		case 2:
			length, n := binary.Uvarint(data[offset:])
			if n <= 0 {
				return nil, fmt.Errorf("invalid length field %d", field.Number)
			}
			offset += n
			if length > uint64(len(data)-offset) {
				return nil, fmt.Errorf("truncated field %d", field.Number)
			}
			field.Bytes = append([]byte(nil), data[offset:offset+int(length)]...)
			offset += int(length)
		case 5:
			if len(data)-offset < 4 {
				return nil, fmt.Errorf("truncated fixed32 field %d", field.Number)
			}
			field.Fixed = uint64(binary.LittleEndian.Uint32(data[offset:]))
			offset += 4
		default:
			return nil, fmt.Errorf("unsupported wire type %d", field.Wire)
		}
		fields = append(fields, field)
	}
	return fields, nil
}

func appendMessage(dst []byte, field int, value []byte) []byte { return appendBytes(dst, field, value) }
func appendString(dst []byte, field int, value string) []byte {
	if value == "" {
		return dst
	}
	return appendBytes(dst, field, []byte(value))
}
func appendBytes(dst []byte, field int, value []byte) []byte {
	dst = appendUvarint(dst, uint64(field<<3|2))
	dst = appendUvarint(dst, uint64(len(value)))
	return append(dst, value...)
}
func appendVarintField(dst []byte, field int, value uint64) []byte {
	dst = appendUvarint(dst, uint64(field<<3))
	return appendUvarint(dst, value)
}
func appendFixed64(dst []byte, field int, value uint64) []byte {
	dst = appendUvarint(dst, uint64(field<<3|1))
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], value)
	return append(dst, b[:]...)
}
func appendUvarint(dst []byte, value uint64) []byte {
	var b [10]byte
	n := binary.PutUvarint(b[:], value)
	return append(dst, b[:n]...)
}
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

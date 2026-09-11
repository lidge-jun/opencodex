// Package openai implements the strict, standard-library-only subset of the
// OpenAI Responses and Chat Completions wire formats used by the native line.
package openai

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	UnsupportedStatus = 501
	UnsupportedCode   = "standalone_go_unsupported"
)

// UnsupportedError is the stable fail-closed error for fields outside this
// package's deliberately small conversion subset.
type UnsupportedError struct{ Field string }

func (e *UnsupportedError) Error() string {
	if e.Field == "" {
		return UnsupportedCode
	}
	return fmt.Sprintf("%s: field %s is not supported", UnsupportedCode, e.Field)
}
func (e *UnsupportedError) StatusCode() int { return UnsupportedStatus }
func (e *UnsupportedError) Code() string    { return UnsupportedCode }
func IsUnsupported(err error) bool          { var target *UnsupportedError; return errors.As(err, &target) }

var (
	ErrIncompleteSSE = errors.New("incomplete SSE: missing [DONE] or non-empty finish_reason")
	ErrInvalidJSON   = errors.New("invalid JSON wire payload")
)

func unsupported(field string) error { return &UnsupportedError{Field: field} }

func object(raw []byte) (map[string]json.RawMessage, error) {
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return nil, fmt.Errorf("%w: expected object", ErrInvalidJSON)
	}
	return value, nil
}

func strict(fields map[string]json.RawMessage, allowed map[string]bool, prefix string) error {
	for key := range fields {
		if !allowed[key] {
			if prefix != "" {
				return unsupported(prefix + "." + key)
			}
			return unsupported(key)
		}
	}
	return nil
}

func requiredString(fields map[string]json.RawMessage, key, path string) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", fmt.Errorf("%s is required", path)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || value == "" {
		return "", fmt.Errorf("%s must be a non-empty string", path)
	}
	return value, nil
}

func stringField(fields map[string]json.RawMessage, key string) (string, bool, error) {
	raw, ok := fields[key]
	if !ok {
		return "", false, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", true, fmt.Errorf("%s must be a string", key)
	}
	return value, true, nil
}

func boolField(fields map[string]json.RawMessage, key string) (bool, bool, error) {
	raw, ok := fields[key]
	if !ok {
		return false, false, nil
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, true, fmt.Errorf("%s must be boolean", key)
	}
	return value, true, nil
}

func streamOptions(fields map[string]json.RawMessage, path string) (map[string]any, error) {
	raw, ok := fields["stream_options"]
	if !ok {
		return nil, nil
	}
	options, err := rawObject(raw, path)
	if err != nil {
		return nil, err
	}
	if err := strict(options, map[string]bool{"include_usage": true}, path); err != nil {
		return nil, err
	}
	include, ok, err := boolField(options, "include_usage")
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%s.include_usage is required", path)
	}
	return map[string]any{"include_usage": include}, nil
}

func intField(fields map[string]json.RawMessage, key string) (int, bool, error) {
	raw, ok := fields[key]
	if !ok {
		return 0, false, nil
	}
	var value int
	if err := json.Unmarshal(raw, &value); err != nil || value < 0 {
		return 0, true, fmt.Errorf("%s must be a non-negative integer", key)
	}
	return value, true, nil
}

func array(raw json.RawMessage, path string) ([]json.RawMessage, error) {
	var value []json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("%s must be an array", path)
	}
	return value, nil
}

func rawObject(raw json.RawMessage, path string) (map[string]json.RawMessage, error) {
	value, err := object(raw)
	if err != nil {
		return nil, fmt.Errorf("%s must be an object", path)
	}
	return value, nil
}

func encode(value any) ([]byte, error) { return json.Marshal(value) }

func text(raw json.RawMessage, path string, accepted map[string]bool) (string, error) {
	if raw == nil || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", nil
	}
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return value, nil
	}
	parts, err := array(raw, path)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	for index, part := range parts {
		fields, err := rawObject(part, fmt.Sprintf("%s[%d]", path, index))
		if err != nil {
			return "", err
		}
		if err := strict(fields, map[string]bool{"type": true, "text": true}, fmt.Sprintf("%s[%d]", path, index)); err != nil {
			return "", err
		}
		typeName, err := requiredString(fields, "type", fmt.Sprintf("%s[%d].type", path, index))
		if err != nil {
			return "", err
		}
		if !accepted[typeName] {
			return "", unsupported(fmt.Sprintf("%s[%d].type=%q", path, index, typeName))
		}
		value, err := requiredString(fields, "text", fmt.Sprintf("%s[%d].text", path, index))
		if err != nil {
			return "", err
		}
		if index > 0 {
			out.WriteByte('\n')
		}
		out.WriteString(value)
	}
	return out.String(), nil
}

var inputText = map[string]bool{"input_text": true, "text": true}
var outputText = map[string]bool{"output_text": true, "text": true}

// ConvertResponsesRequestToChat converts the supported Responses request
// fields to Chat Completions: model, instructions, text input, stream,
// max_output_tokens, standard function tools, and tool_choice.
func ConvertResponsesRequestToChat(data []byte) ([]byte, error) {
	fields, err := object(data)
	if err != nil {
		return nil, err
	}
	if err := strict(fields, map[string]bool{"model": true, "instructions": true, "input": true, "stream": true, "stream_options": true, "max_output_tokens": true, "tools": true, "tool_choice": true}, ""); err != nil {
		return nil, err
	}
	model, err := requiredString(fields, "model", "model")
	if err != nil {
		return nil, err
	}
	messages := make([]any, 0)
	if raw, ok := fields["instructions"]; ok {
		instructions, err := requiredString(map[string]json.RawMessage{"value": raw}, "value", "instructions")
		if err != nil {
			return nil, err
		}
		messages = append(messages, map[string]any{"role": "system", "content": instructions})
	}
	if raw, ok := fields["input"]; ok {
		var value string
		if json.Unmarshal(raw, &value) == nil {
			messages = append(messages, map[string]any{"role": "user", "content": value})
		} else {
			items, err := array(raw, "input")
			if err != nil {
				return nil, err
			}
			for index, item := range items {
				converted, err := responsesItemToChat(item, index)
				if err != nil {
					return nil, err
				}
				for _, message := range converted {
					messages = append(messages, message)
				}
			}
		}
	}
	if len(messages) == 0 {
		return nil, errors.New("input or instructions is required")
	}
	out := map[string]any{"model": model, "messages": messages}
	if value, ok, err := boolField(fields, "stream"); err != nil {
		return nil, err
	} else if ok {
		out["stream"] = value
	}
	if rawStream, ok := fields["stream"]; ok {
		var stream bool
		if err := json.Unmarshal(rawStream, &stream); err != nil {
			return nil, fmt.Errorf("stream must be boolean")
		}
		if stream {
			options, err := streamOptions(fields, "stream_options")
			if err != nil {
				return nil, err
			}
			if options == nil {
				options = map[string]any{"include_usage": true}
			}
			out["stream_options"] = options
		} else if _, ok := fields["stream_options"]; ok {
			return nil, unsupported("stream_options requires stream=true")
		}
	}
	if value, ok, err := intField(fields, "max_output_tokens"); err != nil {
		return nil, err
	} else if ok {
		out["max_tokens"] = value
	}
	if raw, ok := fields["tools"]; ok {
		value, err := responsesToolsToChat(raw)
		if err != nil {
			return nil, err
		}
		out["tools"] = value
	}
	if raw, ok := fields["tool_choice"]; ok {
		value, err := responsesChoiceToChat(raw)
		if err != nil {
			return nil, err
		}
		out["tool_choice"] = value
	}
	return encode(out)
}

func responsesItemToChat(raw json.RawMessage, index int) ([]map[string]any, error) {
	path := fmt.Sprintf("input[%d]", index)
	fields, err := rawObject(raw, path)
	if err != nil {
		return nil, err
	}
	typeName := "message"
	if value, ok, err := stringField(fields, "type"); err != nil {
		return nil, fmt.Errorf("%s.type: %w", path, err)
	} else if ok {
		typeName = value
	}
	switch typeName {
	case "message":
		if err := strict(fields, map[string]bool{"type": true, "role": true, "content": true}, path); err != nil {
			return nil, err
		}
		role, err := requiredString(fields, "role", path+".role")
		if err != nil {
			return nil, err
		}
		if role != "user" && role != "assistant" && role != "developer" {
			return nil, unsupported(path + ".role=" + role)
		}
		content, err := text(fields["content"], path+".content", map[string]bool{"input_text": true, "output_text": true, "text": true})
		if err != nil {
			return nil, err
		}
		return []map[string]any{{"role": role, "content": content}}, nil
	case "function_call":
		if err := strict(fields, map[string]bool{"type": true, "id": true, "call_id": true, "name": true, "arguments": true}, path); err != nil {
			return nil, err
		}
		callID, err := requiredString(fields, "call_id", path+".call_id")
		if err != nil {
			return nil, err
		}
		name, err := requiredString(fields, "name", path+".name")
		if err != nil {
			return nil, err
		}
		args := "{}"
		if value, ok, err := stringField(fields, "arguments"); err != nil {
			return nil, err
		} else if ok {
			args = value
		}
		return []map[string]any{{"role": "assistant", "content": nil, "tool_calls": []any{map[string]any{"id": callID, "type": "function", "function": map[string]any{"name": name, "arguments": args}}}}}, nil
	case "function_call_output":
		if err := strict(fields, map[string]bool{"type": true, "call_id": true, "output": true}, path); err != nil {
			return nil, err
		}
		callID, err := requiredString(fields, "call_id", path+".call_id")
		if err != nil {
			return nil, err
		}
		value, err := text(fields["output"], path+".output", inputText)
		if err != nil {
			return nil, err
		}
		return []map[string]any{{"role": "tool", "tool_call_id": callID, "content": value}}, nil
	default:
		return nil, unsupported(path + ".type=" + typeName)
	}
}

func responsesToolsToChat(raw json.RawMessage) ([]any, error) {
	tools, err := array(raw, "tools")
	if err != nil {
		return nil, err
	}
	out := make([]any, 0, len(tools))
	for index, rawTool := range tools {
		path := fmt.Sprintf("tools[%d]", index)
		fields, err := rawObject(rawTool, path)
		if err != nil {
			return nil, err
		}
		if err := strict(fields, map[string]bool{"type": true, "name": true, "description": true, "parameters": true, "strict": true}, path); err != nil {
			return nil, err
		}
		typeName, err := requiredString(fields, "type", path+".type")
		if err != nil {
			return nil, err
		}
		if typeName != "function" {
			return nil, unsupported(path + ".type=" + typeName)
		}
		name, err := requiredString(fields, "name", path+".name")
		if err != nil {
			return nil, err
		}
		fn := map[string]any{"name": name}
		if value, ok, err := stringField(fields, "description"); err != nil {
			return nil, err
		} else if ok {
			fn["description"] = value
		}
		if value, ok := fields["parameters"]; ok {
			var parameter any
			if err := json.Unmarshal(value, &parameter); err != nil {
				return nil, fmt.Errorf("%s.parameters must be JSON", path)
			}
			fn["parameters"] = parameter
		}
		if value, ok, err := boolField(fields, "strict"); err != nil {
			return nil, err
		} else if ok {
			fn["strict"] = value
		}
		out = append(out, map[string]any{"type": "function", "function": fn})
	}
	return out, nil
}

func responsesChoiceToChat(raw json.RawMessage) (any, error) {
	var value string
	if json.Unmarshal(raw, &value) == nil {
		if value != "auto" && value != "none" && value != "required" {
			return nil, unsupported("tool_choice=" + value)
		}
		return value, nil
	}
	fields, err := rawObject(raw, "tool_choice")
	if err != nil {
		return nil, err
	}
	if err := strict(fields, map[string]bool{"type": true, "name": true}, "tool_choice"); err != nil {
		return nil, err
	}
	typeName, err := requiredString(fields, "type", "tool_choice.type")
	if err != nil {
		return nil, err
	}
	if typeName != "function" {
		return nil, unsupported("tool_choice.type=" + typeName)
	}
	name, err := requiredString(fields, "name", "tool_choice.name")
	if err != nil {
		return nil, err
	}
	return map[string]any{"type": "function", "function": map[string]any{"name": name}}, nil
}

// ConvertChatRequestToResponses converts system/developer text, text input,
// assistant function calls, tool results, standard tools, and tool choice.
func ConvertChatRequestToResponses(data []byte) ([]byte, error) {
	fields, err := object(data)
	if err != nil {
		return nil, err
	}
	if err := strict(fields, map[string]bool{"model": true, "messages": true, "stream": true, "stream_options": true, "max_tokens": true, "tools": true, "tool_choice": true}, ""); err != nil {
		return nil, err
	}
	model, err := requiredString(fields, "model", "model")
	if err != nil {
		return nil, err
	}
	rawMessages, ok := fields["messages"]
	if !ok {
		return nil, errors.New("messages is required")
	}
	messages, err := array(rawMessages, "messages")
	if err != nil || len(messages) == 0 {
		return nil, errors.New("messages must be a non-empty array")
	}
	input := make([]any, 0)
	instructions := make([]string, 0)
	for index, rawMessage := range messages {
		path := fmt.Sprintf("messages[%d]", index)
		message, err := rawObject(rawMessage, path)
		if err != nil {
			return nil, err
		}
		if err := strict(message, map[string]bool{"role": true, "content": true, "tool_calls": true, "tool_call_id": true}, path); err != nil {
			return nil, err
		}
		role, err := requiredString(message, "role", path+".role")
		if err != nil {
			return nil, err
		}
		switch role {
		case "system", "developer":
			value, err := text(message["content"], path+".content", map[string]bool{"text": true, "input_text": true, "output_text": true})
			if err != nil {
				return nil, err
			}
			instructions = append(instructions, value)
		case "user":
			value, err := text(message["content"], path+".content", map[string]bool{"text": true, "input_text": true})
			if err != nil {
				return nil, err
			}
			input = append(input, map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": value}}})
		case "assistant":
			value, err := text(message["content"], path+".content", map[string]bool{"text": true, "output_text": true})
			if err != nil {
				return nil, err
			}
			if value != "" {
				input = append(input, map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": value}}})
			}
			if rawCalls, ok := message["tool_calls"]; ok {
				calls, err := chatToolCallsToResponses(rawCalls, path+".tool_calls")
				if err != nil {
					return nil, err
				}
				input = append(input, calls...)
			}
		case "tool":
			callID, err := requiredString(message, "tool_call_id", path+".tool_call_id")
			if err != nil {
				return nil, err
			}
			value, err := text(message["content"], path+".content", map[string]bool{"text": true})
			if err != nil {
				return nil, err
			}
			input = append(input, map[string]any{"type": "function_call_output", "call_id": callID, "output": value})
		default:
			return nil, unsupported(path + ".role=" + role)
		}
	}
	if len(input) == 0 && len(instructions) == 0 {
		return nil, errors.New("messages must contain a supported turn")
	}
	out := map[string]any{"model": model, "input": input, "stream": false}
	if len(instructions) > 0 {
		out["instructions"] = strings.Join(instructions, "\n\n")
	}
	if value, ok, err := boolField(fields, "stream"); err != nil {
		return nil, err
	} else if ok {
		out["stream"] = value
	}
	if rawStream, ok := fields["stream"]; ok {
		var stream bool
		if err := json.Unmarshal(rawStream, &stream); err != nil {
			return nil, fmt.Errorf("stream must be boolean")
		}
		if stream {
			options, err := streamOptions(fields, "stream_options")
			if err != nil {
				return nil, err
			}
			if options != nil {
				out["stream_options"] = options
			}
		} else if _, ok := fields["stream_options"]; ok {
			return nil, unsupported("stream_options requires stream=true")
		}
	}
	if value, ok, err := intField(fields, "max_tokens"); err != nil {
		return nil, err
	} else if ok {
		out["max_output_tokens"] = value
	}
	if raw, ok := fields["tools"]; ok {
		value, err := chatToolsToResponses(raw)
		if err != nil {
			return nil, err
		}
		out["tools"] = value
	}
	if raw, ok := fields["tool_choice"]; ok {
		value, err := chatChoiceToResponses(raw)
		if err != nil {
			return nil, err
		}
		out["tool_choice"] = value
	}
	return encode(out)
}

func chatToolCallsToResponses(raw json.RawMessage, path string) ([]any, error) {
	calls, err := array(raw, path)
	if err != nil {
		return nil, err
	}
	out := make([]any, 0, len(calls))
	for index, rawCall := range calls {
		itemPath := fmt.Sprintf("%s[%d]", path, index)
		call, err := rawObject(rawCall, itemPath)
		if err != nil {
			return nil, err
		}
		if err := strict(call, map[string]bool{"id": true, "type": true, "function": true}, itemPath); err != nil {
			return nil, err
		}
		id, err := requiredString(call, "id", itemPath+".id")
		if err != nil {
			return nil, err
		}
		typeName, err := requiredString(call, "type", itemPath+".type")
		if err != nil {
			return nil, err
		}
		if typeName != "function" {
			return nil, unsupported(itemPath + ".type=" + typeName)
		}
		fn, err := rawObject(call["function"], itemPath+".function")
		if err != nil {
			return nil, err
		}
		if err := strict(fn, map[string]bool{"name": true, "arguments": true}, itemPath+".function"); err != nil {
			return nil, err
		}
		name, err := requiredString(fn, "name", itemPath+".function.name")
		if err != nil {
			return nil, err
		}
		args := "{}"
		if value, ok, err := stringField(fn, "arguments"); err != nil {
			return nil, err
		} else if ok {
			args = value
		}
		out = append(out, map[string]any{"type": "function_call", "call_id": id, "name": name, "arguments": args})
	}
	return out, nil
}

func chatToolsToResponses(raw json.RawMessage) ([]any, error) {
	tools, err := array(raw, "tools")
	if err != nil {
		return nil, err
	}
	out := make([]any, 0, len(tools))
	for index, rawTool := range tools {
		path := fmt.Sprintf("tools[%d]", index)
		tool, err := rawObject(rawTool, path)
		if err != nil {
			return nil, err
		}
		if err := strict(tool, map[string]bool{"type": true, "function": true}, path); err != nil {
			return nil, err
		}
		typeName, err := requiredString(tool, "type", path+".type")
		if err != nil {
			return nil, err
		}
		if typeName != "function" {
			return nil, unsupported(path + ".type=" + typeName)
		}
		fn, err := rawObject(tool["function"], path+".function")
		if err != nil {
			return nil, err
		}
		if err := strict(fn, map[string]bool{"name": true, "description": true, "parameters": true, "strict": true}, path+".function"); err != nil {
			return nil, err
		}
		name, err := requiredString(fn, "name", path+".function.name")
		if err != nil {
			return nil, err
		}
		value := map[string]any{"type": "function", "name": name}
		if v, ok, err := stringField(fn, "description"); err != nil {
			return nil, err
		} else if ok {
			value["description"] = v
		}
		if v, ok := fn["parameters"]; ok {
			var parameter any
			if err := json.Unmarshal(v, &parameter); err != nil {
				return nil, err
			}
			value["parameters"] = parameter
		}
		if v, ok, err := boolField(fn, "strict"); err != nil {
			return nil, err
		} else if ok {
			value["strict"] = v
		}
		out = append(out, value)
	}
	return out, nil
}

func chatChoiceToResponses(raw json.RawMessage) (any, error) {
	var value string
	if json.Unmarshal(raw, &value) == nil {
		if value != "auto" && value != "none" && value != "required" {
			return nil, unsupported("tool_choice=" + value)
		}
		return value, nil
	}
	fields, err := rawObject(raw, "tool_choice")
	if err != nil {
		return nil, err
	}
	if err := strict(fields, map[string]bool{"type": true, "function": true}, "tool_choice"); err != nil {
		return nil, err
	}
	typeName, err := requiredString(fields, "type", "tool_choice.type")
	if err != nil {
		return nil, err
	}
	if typeName != "function" {
		return nil, unsupported("tool_choice.type=" + typeName)
	}
	fn, err := rawObject(fields["function"], "tool_choice.function")
	if err != nil {
		return nil, err
	}
	if err := strict(fn, map[string]bool{"name": true}, "tool_choice.function"); err != nil {
		return nil, err
	}
	name, err := requiredString(fn, "name", "tool_choice.function.name")
	if err != nil {
		return nil, err
	}
	return map[string]any{"type": "function", "name": name}, nil
}

// ConvertResponsesResponseToChat converts non-streaming Responses output,
// function calls, status, model, and usage to a Chat completion.
func ConvertResponsesResponseToChat(data []byte) ([]byte, error) {
	fields, err := object(data)
	if err != nil {
		return nil, err
	}
	if err := strict(fields, map[string]bool{"id": true, "object": true, "model": true, "status": true, "output": true, "usage": true, "incomplete_details": true}, "response"); err != nil {
		return nil, err
	}
	model, _, err := stringField(fields, "model")
	if err != nil {
		return nil, err
	}
	rawOutput, ok := fields["output"]
	if !ok {
		return nil, errors.New("response.output is required")
	}
	items, err := array(rawOutput, "response.output")
	if err != nil {
		return nil, err
	}
	var content strings.Builder
	calls := make([]any, 0)
	for index, rawItem := range items {
		path := fmt.Sprintf("response.output[%d]", index)
		item, err := rawObject(rawItem, path)
		if err != nil {
			return nil, err
		}
		typeName, err := requiredString(item, "type", path+".type")
		if err != nil {
			return nil, err
		}
		switch typeName {
		case "message":
			if err := strict(item, map[string]bool{"type": true, "id": true, "role": true, "content": true, "status": true}, path); err != nil {
				return nil, err
			}
			if role, _, err := stringField(item, "role"); err != nil {
				return nil, err
			} else if role != "" && role != "assistant" {
				return nil, unsupported(path + ".role=" + role)
			}
			value, err := text(item["content"], path+".content", outputText)
			if err != nil {
				return nil, err
			}
			content.WriteString(value)
		case "function_call":
			if err := strict(item, map[string]bool{"type": true, "id": true, "call_id": true, "name": true, "arguments": true, "status": true}, path); err != nil {
				return nil, err
			}
			id, err := requiredString(item, "call_id", path+".call_id")
			if err != nil {
				return nil, err
			}
			name, err := requiredString(item, "name", path+".name")
			if err != nil {
				return nil, err
			}
			args := "{}"
			if value, ok, err := stringField(item, "arguments"); err != nil {
				return nil, err
			} else if ok {
				args = value
			}
			calls = append(calls, map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": args}})
		default:
			return nil, unsupported(path + ".type=" + typeName)
		}
	}
	status, _, err := stringField(fields, "status")
	if err != nil {
		return nil, err
	}
	finish := "stop"
	if len(calls) > 0 {
		finish = "tool_calls"
	} else if status == "incomplete" {
		finish = "length"
	}
	message := map[string]any{"role": "assistant", "content": nil}
	if content.Len() > 0 {
		message["content"] = content.String()
	}
	if len(calls) > 0 {
		message["tool_calls"] = calls
	}
	choice := map[string]any{"index": 0, "message": message, "finish_reason": finish}
	out := map[string]any{"object": "chat.completion", "model": model, "choices": []any{choice}}
	if value, ok, err := stringField(fields, "id"); err != nil {
		return nil, err
	} else if ok {
		out["id"] = value
	}
	if raw, ok := fields["usage"]; ok {
		usage, err := usageToChat(raw)
		if err != nil {
			return nil, err
		}
		out["usage"] = usage
	}
	return encode(out)
}

func usageToChat(raw json.RawMessage) (map[string]any, error) {
	fields, err := rawObject(raw, "usage")
	if err != nil {
		return nil, err
	}
	if err := strict(fields, map[string]bool{"input_tokens": true, "output_tokens": true, "total_tokens": true}, "usage"); err != nil {
		return nil, err
	}
	in, _, err := intField(fields, "input_tokens")
	if err != nil {
		return nil, err
	}
	out, _, err := intField(fields, "output_tokens")
	if err != nil {
		return nil, err
	}
	total, _, err := intField(fields, "total_tokens")
	if err != nil {
		return nil, err
	}
	return map[string]any{"prompt_tokens": in, "completion_tokens": out, "total_tokens": total}, nil
}

// ConvertChatResponseToResponses converts one non-streaming Chat response.
func ConvertChatResponseToResponses(data []byte) ([]byte, error) {
	fields, err := object(data)
	if err != nil {
		return nil, err
	}
	if err := strict(fields, map[string]bool{"id": true, "object": true, "created": true, "model": true, "choices": true, "usage": true}, "chat"); err != nil {
		return nil, err
	}
	model, _, err := stringField(fields, "model")
	if err != nil {
		return nil, err
	}
	choices, err := array(fields["choices"], "chat.choices")
	if err != nil || len(choices) != 1 {
		return nil, errors.New("choices must contain exactly one choice")
	}
	choice, err := rawObject(choices[0], "choices[0]")
	if err != nil {
		return nil, err
	}
	if err := strict(choice, map[string]bool{"index": true, "message": true, "finish_reason": true}, "choices[0]"); err != nil {
		return nil, err
	}
	message, err := rawObject(choice["message"], "choices[0].message")
	if err != nil {
		return nil, err
	}
	if err := strict(message, map[string]bool{"role": true, "content": true, "tool_calls": true}, "choices[0].message"); err != nil {
		return nil, err
	}
	role, err := requiredString(message, "role", "choices[0].message.role")
	if err != nil {
		return nil, err
	}
	if role != "assistant" {
		return nil, unsupported("choices[0].message.role=" + role)
	}
	output := make([]any, 0)
	if raw, ok := message["content"]; ok {
		value, err := text(raw, "choices[0].message.content", map[string]bool{"text": true, "output_text": true})
		if err != nil {
			return nil, err
		}
		if value != "" {
			output = append(output, map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": value}}})
		}
	}
	if raw, ok := message["tool_calls"]; ok {
		calls, err := chatToolCallsToResponses(raw, "choices[0].message.tool_calls")
		if err != nil {
			return nil, err
		}
		output = append(output, calls...)
	}
	finish, ok, err := stringField(choice, "finish_reason")
	if err != nil {
		return nil, err
	}
	if !ok || finish == "" {
		return nil, errors.New("choices[0].finish_reason must be non-empty")
	}
	response := map[string]any{"object": "response", "model": model, "status": "completed", "output": output}
	switch finish {
	case "stop", "tool_calls":
	case "length":
		response["status"] = "incomplete"
		response["incomplete_details"] = map[string]any{"reason": "max_output_tokens"}
	default:
		return nil, unsupported("choices[0].finish_reason=" + finish)
	}
	if value, ok, err := stringField(fields, "id"); err != nil {
		return nil, err
	} else if ok {
		response["id"] = value
	}
	if raw, ok := fields["usage"]; ok {
		usage, err := usageToResponses(raw)
		if err != nil {
			return nil, err
		}
		response["usage"] = usage
	}
	return encode(response)
}

func usageToResponses(raw json.RawMessage) (map[string]any, error) {
	fields, err := rawObject(raw, "usage")
	if err != nil {
		return nil, err
	}
	if err := strict(fields, map[string]bool{"prompt_tokens": true, "completion_tokens": true, "total_tokens": true}, "usage"); err != nil {
		return nil, err
	}
	in, _, err := intField(fields, "prompt_tokens")
	if err != nil {
		return nil, err
	}
	out, _, err := intField(fields, "completion_tokens")
	if err != nil {
		return nil, err
	}
	total, _, err := intField(fields, "total_tokens")
	if err != nil {
		return nil, err
	}
	return map[string]any{"input_tokens": in, "output_tokens": out, "total_tokens": total}, nil
}

func chatUsageToResponses(raw json.RawMessage) (map[string]any, error) {
	fields, err := rawObject(raw, "usage")
	if err != nil {
		return nil, err
	}
	if err := strict(fields, map[string]bool{"prompt_tokens": true, "completion_tokens": true, "total_tokens": true}, "usage"); err != nil {
		return nil, err
	}
	in, _, err := intField(fields, "prompt_tokens")
	if err != nil {
		return nil, err
	}
	out, _, err := intField(fields, "completion_tokens")
	if err != nil {
		return nil, err
	}
	total, _, err := intField(fields, "total_tokens")
	if err != nil {
		return nil, err
	}
	return map[string]any{"input_tokens": in, "output_tokens": out, "total_tokens": total}, nil
}

type sse struct{ Data []string }

func parseSSE(reader io.Reader) ([]string, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 1024), 8*1024*1024)
	var lines []string
	var frames []string
	flush := func() {
		if len(lines) > 0 {
			frames = append(frames, strings.Join(lines, "\n"))
			lines = nil
		}
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		if strings.HasPrefix(line, "data:") {
			value := strings.TrimPrefix(line, "data:")
			if strings.HasPrefix(value, " ") {
				value = value[1:]
			}
			lines = append(lines, value)
			continue
		}
		if strings.HasPrefix(line, "event:") || strings.HasPrefix(line, "id:") || strings.HasPrefix(line, "retry:") {
			continue
		}
		return nil, unsupported("SSE." + strings.SplitN(line, ":", 2)[0])
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	flush()
	return frames, nil
}

// ChatSSE is the validated Chat stream summary.
type ChatSSE struct {
	Events       []json.RawMessage
	Done         bool
	FinishReason string
	Usage        json.RawMessage
}

// ParseChatSSE parses CRLF/LF and multi-line data fields. A stream is complete
// when it has either [DONE] or a non-empty finish_reason; requiring both would
// reject otherwise valid providers that close after their terminal chunk.
func ParseChatSSE(data []byte) (ChatSSE, error) {
	frames, err := parseSSE(bytes.NewReader(data))
	if err != nil {
		return ChatSSE{}, err
	}
	result := ChatSSE{}
	for _, frame := range frames {
		if frame == "[DONE]" {
			if result.Done {
				return ChatSSE{}, errors.New("duplicate [DONE]")
			}
			result.Done = true
			continue
		}
		if result.Done {
			return ChatSSE{}, errors.New("SSE event after [DONE]")
		}
		fields, err := object([]byte(frame))
		if err != nil {
			return ChatSSE{}, err
		}
		if err := strict(fields, map[string]bool{"id": true, "object": true, "created": true, "model": true, "choices": true, "usage": true, "system_fingerprint": true}, "chunk"); err != nil {
			return ChatSSE{}, err
		}
		if usage, ok := fields["usage"]; ok {
			parsedUsage, err := chatUsageToResponses(usage)
			if err != nil {
				return ChatSSE{}, err
			}
			result.Usage, err = json.Marshal(parsedUsage)
			if err != nil {
				return ChatSSE{}, err
			}
		}
		choices, err := array(fields["choices"], "choices")
		if err != nil {
			return ChatSSE{}, err
		}
		for index, rawChoice := range choices {
			choice, err := rawObject(rawChoice, fmt.Sprintf("choices[%d]", index))
			if err != nil {
				return ChatSSE{}, err
			}
			if err := strict(choice, map[string]bool{"index": true, "delta": true, "finish_reason": true}, fmt.Sprintf("choices[%d]", index)); err != nil {
				return ChatSSE{}, err
			}
			if rawDelta, ok := choice["delta"]; ok {
				delta, err := rawObject(rawDelta, fmt.Sprintf("choices[%d].delta", index))
				if err != nil {
					return ChatSSE{}, err
				}
				if err := strict(delta, map[string]bool{"role": true, "content": true, "tool_calls": true}, fmt.Sprintf("choices[%d].delta", index)); err != nil {
					return ChatSSE{}, err
				}
			}
			if value, ok, err := stringField(choice, "finish_reason"); err != nil {
				return ChatSSE{}, err
			} else if ok && value != "" {
				result.FinishReason = value
			}
		}
		result.Events = append(result.Events, json.RawMessage(frame))
	}
	if !result.Done && result.FinishReason == "" {
		return ChatSSE{}, ErrIncompleteSSE
	}
	return result, nil
}

// ParseChatSSEReader is the reader-oriented form of ParseChatSSE for callers
// that already own an io.Reader.
func ParseChatSSEReader(reader io.Reader) (ChatSSE, error) {
	if reader == nil {
		return ChatSSE{}, ErrInvalidJSON
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		return ChatSSE{}, err
	}
	return ParseChatSSE(data)
}

func sseWrite(out *bytes.Buffer, event string, value any) error {
	data, err := encode(value)
	if err != nil {
		return err
	}
	if event != "" {
		fmt.Fprintf(out, "event: %s\n", event)
	}
	fmt.Fprintf(out, "data: %s\n\n", data)
	return nil
}

// ConvertChatSSEToResponses converts text and function-call deltas into a
// Responses SSE stream and preserves the terminal reason.
func ConvertChatSSEToResponses(data []byte) ([]byte, error) {
	parsed, err := ParseChatSSE(data)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	id, model := "", ""
	var textValue strings.Builder
	created := false
	for _, raw := range parsed.Events {
		fields, _ := object(raw)
		if id == "" {
			id, _, _ = stringField(fields, "id")
			model, _, _ = stringField(fields, "model")
		}
		if !created {
			if err := sseWrite(&out, "response.created", map[string]any{"type": "response.created", "response": map[string]any{"id": id, "model": model, "status": "in_progress", "output": []any{}}}); err != nil {
				return nil, err
			}
			created = true
		}
		choices, err := array(fields["choices"], "choices")
		if err != nil {
			return nil, err
		}
		for _, rawChoice := range choices {
			choice, _ := rawObject(rawChoice, "choice")
			deltaRaw, ok := choice["delta"]
			if !ok {
				continue
			}
			delta, _ := rawObject(deltaRaw, "delta")
			if rawContent, ok := delta["content"]; ok {
				var value string
				if json.Unmarshal(rawContent, &value) == nil && value != "" {
					textValue.WriteString(value)
					if err := sseWrite(&out, "response.output_text.delta", map[string]any{"type": "response.output_text.delta", "delta": value}); err != nil {
						return nil, err
					}
				}
			}
			if rawCalls, ok := delta["tool_calls"]; ok {
				calls, err := array(rawCalls, "delta.tool_calls")
				if err != nil {
					return nil, err
				}
				for _, rawCall := range calls {
					call, err := rawObject(rawCall, "delta.tool_call")
					if err != nil {
						return nil, err
					}
					fn, err := rawObject(call["function"], "delta.tool_call.function")
					if err != nil {
						return nil, err
					}
					name, _, err := stringField(fn, "name")
					if err != nil {
						return nil, err
					}
					callID, _, err := stringField(call, "id")
					if err != nil {
						return nil, err
					}
					if name != "" {
						if err := sseWrite(&out, "response.output_item.added", map[string]any{"type": "response.output_item.added", "item": map[string]any{"type": "function_call", "call_id": callID, "name": name, "arguments": ""}}); err != nil {
							return nil, err
						}
					}
					args, _, err := stringField(fn, "arguments")
					if err != nil {
						return nil, err
					}
					if args != "" {
						if err := sseWrite(&out, "response.function_call_arguments.delta", map[string]any{"type": "response.function_call_arguments.delta", "delta": args}); err != nil {
							return nil, err
						}
					}
				}
			}
		}
	}
	status := "completed"
	terminalType := "response.completed"
	if parsed.FinishReason == "length" {
		status = "incomplete"
		terminalType = "response.incomplete"
	}
	response := map[string]any{"type": terminalType, "response": map[string]any{"id": id, "model": model, "status": status, "output": []any{}}}
	if len(parsed.Usage) > 0 {
		var usage any
		if err := json.Unmarshal(parsed.Usage, &usage); err != nil {
			return nil, err
		}
		response["response"].(map[string]any)["usage"] = usage
	}
	if textValue.Len() > 0 {
		response["response"].(map[string]any)["output"] = []any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": textValue.String()}}}}
	}
	if status == "incomplete" {
		response["response"].(map[string]any)["incomplete_details"] = map[string]any{"reason": "max_output_tokens"}
	}
	if err := sseWrite(&out, terminalType, response); err != nil {
		return nil, err
	}
	out.WriteString("data: [DONE]\n\n")
	return out.Bytes(), nil
}

// ConvertResponsesSSEToChat converts the supported Responses event subset and
// rejects a missing terminal or [DONE].
func ConvertResponsesSSEToChat(data []byte) ([]byte, error) {
	frames, err := parseSSE(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	id, model, finish := "", "", ""
	done := false
	toolSeen := false
	var usage json.RawMessage
	for _, frame := range frames {
		if frame == "[DONE]" {
			done = true
			continue
		}
		fields, err := object([]byte(frame))
		if err != nil {
			return nil, err
		}
		typeName, err := requiredString(fields, "type", "Responses SSE.type")
		if err != nil {
			return nil, err
		}
		switch typeName {
		case "response.created":
			response, err := rawObject(fields["response"], "response.created.response")
			if err != nil {
				return nil, err
			}
			id, _, _ = stringField(response, "id")
			model, _, _ = stringField(response, "model")
		case "response.output_text.delta":
			value, err := requiredString(fields, "delta", typeName+".delta")
			if err != nil {
				return nil, err
			}
			if err := sseWrite(&out, "", chatChunk(id, model, map[string]any{"role": "assistant", "content": value}, nil)); err != nil {
				return nil, err
			}
		case "response.output_item.added":
			item, err := rawObject(fields["item"], typeName+".item")
			if err != nil {
				return nil, err
			}
			itemType, err := requiredString(item, "type", typeName+".item.type")
			if err != nil {
				return nil, err
			}
			if itemType != "function_call" {
				return nil, unsupported(typeName + ".item.type=" + itemType)
			}
			callID, err := requiredString(item, "call_id", typeName+".item.call_id")
			if err != nil {
				return nil, err
			}
			name, err := requiredString(item, "name", typeName+".item.name")
			if err != nil {
				return nil, err
			}
			toolSeen = true
			if err := sseWrite(&out, "", chatChunk(id, model, map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": callID, "type": "function", "function": map[string]any{"name": name, "arguments": ""}}}}, nil)); err != nil {
				return nil, err
			}
		case "response.function_call_arguments.delta":
			value, err := requiredString(fields, "delta", typeName+".delta")
			if err != nil {
				return nil, err
			}
			toolSeen = true
			if err := sseWrite(&out, "", chatChunk(id, model, map[string]any{"tool_calls": []any{map[string]any{"index": 0, "type": "function", "function": map[string]any{"arguments": value}}}}, nil)); err != nil {
				return nil, err
			}
		case "response.output_text.done", "response.output_item.done", "response.function_call_arguments.done":
		case "response.completed":
			response, err := rawObject(fields["response"], typeName+".response")
			if err != nil {
				return nil, err
			}
			if rawUsage, ok := response["usage"]; ok {
				usageValue, err := usageToChat(rawUsage)
				if err != nil {
					return nil, err
				}
				usage, err = json.Marshal(usageValue)
				if err != nil {
					return nil, err
				}
			}
			if toolSeen {
				finish = "tool_calls"
			} else {
				finish = "stop"
			}
		case "response.incomplete":
			if _, err := rawObject(fields["response"], typeName+".response"); err != nil {
				return nil, err
			}
			finish = "length"
		default:
			return nil, unsupported("Responses SSE.type=" + typeName)
		}
	}
	if !done && finish == "" {
		return nil, ErrIncompleteSSE
	}
	if finish != "" {
		if err := sseWrite(&out, "", chatChunk(id, model, map[string]any{}, &finish)); err != nil {
			return nil, err
		}
	}
	if len(usage) > 0 {
		var usageValue any
		if err := json.Unmarshal(usage, &usageValue); err != nil {
			return nil, err
		}
		// The usage-only chunk has an empty choices array, as required by the
		// Chat Completions streaming contract.
		if err := sseWrite(&out, "", map[string]any{"id": id, "object": "chat.completion.chunk", "model": model, "choices": []any{}, "usage": usageValue}); err != nil {
			return nil, err
		}
	}
	out.WriteString("data: [DONE]\n\n")
	return out.Bytes(), nil
}

func chatChunk(id, model string, delta map[string]any, finish *string) map[string]any {
	choice := map[string]any{"index": 0, "delta": delta, "finish_reason": nil}
	if finish != nil {
		choice["finish_reason"] = *finish
	}
	return map[string]any{"id": id, "object": "chat.completion.chunk", "model": model, "choices": []any{choice}}
}

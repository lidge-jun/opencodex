package kiro

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type ParsedEvent struct {
	Type                   string
	Data                   string
	ModelID                string
	Name                   string
	ToolUseID              string
	Input                  string
	Stop                   *bool
	Usage                  *types.Usage
	ContextUsagePercentage *float64
	ConversationID         string
	Message                string
	Reason                 string
}

var knownEventTypes = map[string]struct{}{"assistantResponseEvent": {}, "reasoningContentEvent": {}, "toolUseEvent": {}, "messageMetadataEvent": {}, "metadataEvent": {}, "invalidStateEvent": {}, "error": {}}

func ParseEvent(eventType string, payload []byte) (*ParsedEvent, error) {
	if _, known := knownEventTypes[eventType]; !known {
		return nil, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var object map[string]any
	if err := decoder.Decode(&object); err != nil || object == nil {
		return nil, fmt.Errorf("invalid Kiro %s payload: expected a JSON object", eventType)
	}
	if reason := TruncationReason(object); reason != "" {
		return &ParsedEvent{Type: "truncation", Data: reason}, nil
	}
	getString := func(key string) (string, error) {
		value, ok := object[key]
		if !ok || value == nil {
			return "", nil
		}
		text, ok := value.(string)
		if !ok {
			return "", fmt.Errorf("invalid Kiro %s payload: %s must be a string", eventType, key)
		}
		return text, nil
	}
	switch eventType {
	case "assistantResponseEvent":
		data, err := getString("content")
		if err != nil {
			return nil, err
		}
		model, err := getString("modelId")
		if err != nil {
			return nil, err
		}
		return &ParsedEvent{Type: "content", Data: data, ModelID: model}, nil
	case "reasoningContentEvent":
		data, err := getString("text")
		if err != nil {
			return nil, err
		}
		return &ParsedEvent{Type: "reasoning", Data: data}, nil
	case "toolUseEvent":
		name, err := getString("name")
		if err != nil {
			return nil, err
		}
		id, err := getString("toolUseId")
		if err != nil {
			return nil, err
		}
		input, err := getString("input")
		if err != nil {
			return nil, err
		}
		var stop *bool
		if value, ok := object["stop"]; ok && value != nil {
			flag, ok := value.(bool)
			if !ok {
				return nil, fmt.Errorf("invalid Kiro %s payload: stop must be a boolean", eventType)
			}
			stop = &flag
		}
		return &ParsedEvent{Type: "tool", Name: name, ToolUseID: id, Input: input, Stop: stop}, nil
	case "messageMetadataEvent":
		id, err := getString("conversationId")
		if err != nil {
			return nil, err
		}
		if id == "" {
			id, err = getString("utteranceId")
		}
		return &ParsedEvent{Type: "message_metadata", ConversationID: id}, err
	case "metadataEvent":
		usage, err := parseUsage(eventType, object["tokenUsage"])
		if err != nil {
			return nil, err
		}
		var percentage *float64
		if raw, ok := object["contextUsagePercentage"]; ok {
			number, err := jsonNumber(raw)
			if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
				return nil, fmt.Errorf("invalid Kiro %s payload: contextUsagePercentage must be a finite number", eventType)
			}
			percentage = &number
		}
		return &ParsedEvent{Type: "metadata", Usage: usage, ContextUsagePercentage: percentage}, nil
	case "invalidStateEvent":
		message, err := getString("message")
		return &ParsedEvent{Type: "invalid_state", Message: message}, err
	case "error":
		reason, err := getString("reason")
		if err != nil {
			return nil, err
		}
		if reason == "" {
			reason, err = getString("type")
		}
		if reason == "" && err == nil {
			reason, err = getString("__type")
		}
		if err != nil {
			return nil, err
		}
		message, err := getString("message")
		if message == "" && err == nil {
			message, err = getString("Message")
		}
		return &ParsedEvent{Type: "error", Reason: reason, Message: message}, err
	}
	return nil, nil
}

func parseUsage(eventType string, value any) (*types.Usage, error) {
	if value == nil {
		return nil, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid Kiro %s payload: tokenUsage must be an object", eventType)
	}
	count := func(key string, required bool) (int, error) {
		raw, ok := object[key]
		if !ok && !required {
			return 0, nil
		}
		number, ok := raw.(json.Number)
		if !ok {
			return 0, fmt.Errorf("invalid Kiro %s payload: %s must be a non-negative safe integer", eventType, key)
		}
		integer, err := number.Int64()
		if err != nil || integer < 0 || integer > int64(^uint(0)>>1) {
			return 0, fmt.Errorf("invalid Kiro %s payload: %s must be a non-negative safe integer", eventType, key)
		}
		return int(integer), nil
	}
	uncached, err := count("uncachedInputTokens", true)
	if err != nil {
		return nil, err
	}
	read, err := count("cacheReadInputTokens", false)
	if err != nil {
		return nil, err
	}
	write, err := count("cacheWriteInputTokens", false)
	if err != nil {
		return nil, err
	}
	output, err := count("outputTokens", true)
	if err != nil {
		return nil, err
	}
	total, err := count("totalTokens", true)
	if err != nil {
		return nil, err
	}
	maxInt := int(^uint(0) >> 1)
	if uncached > maxInt-read || uncached+read > maxInt-write {
		return nil, fmt.Errorf("invalid Kiro %s payload: input token usage overflowed", eventType)
	}
	return &types.Usage{InputTokens: uncached + read + write, OutputTokens: output, TotalTokens: total, CachedInputTokens: read, CacheReadInputTokens: read, CacheCreationInputTokens: write}, nil
}

func jsonNumber(value any) (float64, error) {
	switch number := value.(type) {
	case json.Number:
		return number.Float64()
	case float64:
		return number, nil
	default:
		return 0, fmt.Errorf("not a number")
	}
}

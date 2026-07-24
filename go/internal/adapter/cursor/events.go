package cursor

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type openToolCall struct{ Name, Arguments string }
type EventParser struct {
	open          map[string]*openToolCall
	completed     map[string]struct{}
	usage         types.Usage
	contextTokens int
	terminated    bool
}

func NewEventParser() *EventParser {
	return &EventParser{open: map[string]*openToolCall{}, completed: map[string]struct{}{}}
}

func (p *EventParser) Parse(data []byte) ([]types.AdapterEvent, error) {
	if p.terminated {
		return nil, nil
	}
	message, err := UnmarshalAgentServerMessage(data)
	if err != nil {
		return nil, err
	}
	switch message.Kind {
	case ServerCheckpoint:
		return p.parseCheckpoint(message.Payload)
	case ServerInteractionUpdate:
		return p.parseInteraction(message.Payload)
	default:
		return nil, nil
	}
}

func (p *EventParser) parseCheckpoint(data []byte) ([]types.AdapterEvent, error) {
	fields, err := parseFields(data)
	if err != nil {
		return nil, fmt.Errorf("decode Cursor checkpoint: %w", err)
	}
	for _, field := range fields {
		if field.Number != 5 {
			continue
		}
		details, err := parseFields(field.Bytes)
		if err != nil {
			return nil, err
		}
		for _, detail := range details {
			if detail.Number == 1 && int(detail.Varint) > p.contextTokens {
				p.contextTokens = int(detail.Varint)
			}
		}
	}
	if p.contextTokens == 0 {
		return nil, nil
	}
	usage := p.currentUsage()
	return []types.AdapterEvent{{Type: types.EventUsage, Usage: &usage}}, nil
}

func (p *EventParser) parseInteraction(data []byte) ([]types.AdapterEvent, error) {
	fields, err := parseFields(data)
	if err != nil {
		return nil, fmt.Errorf("decode Cursor interaction: %w", err)
	}
	var events []types.AdapterEvent
	for _, field := range fields {
		switch field.Number {
		case 1:
			text, err := nestedString(field.Bytes, 1)
			if err != nil {
				return nil, err
			}
			if text != "" {
				events = append(events, types.AdapterEvent{Type: types.EventTextDelta, Text: text})
			}
		case 2:
			if err := p.startTool(field.Bytes); err != nil {
				return nil, err
			}
		case 3:
			event, err := p.completeTool(field.Bytes)
			if err != nil {
				return nil, err
			}
			if event != nil {
				events = append(events, *event)
			}
		case 4:
			text, err := nestedString(field.Bytes, 1)
			if err != nil {
				return nil, err
			}
			if text != "" {
				events = append(events, types.AdapterEvent{Type: types.EventReasoning, Reasoning: text})
			}
		case 7:
			if err := p.partialTool(field.Bytes); err != nil {
				return nil, err
			}
		case 8:
			tokens, err := nestedVarint(field.Bytes, 1)
			if err != nil {
				return nil, err
			}
			p.usage.OutputTokens += int(tokens)
		case 14:
			events = append(events, p.finish()...)
		}
	}
	return events, nil
}

func (p *EventParser) startTool(update []byte) error {
	id, tool, err := parseToolUpdate(update)
	if err != nil {
		return err
	}
	if id == "" || tool.Name == "" {
		return nil
	}
	if _, done := p.completed[id]; done {
		return nil
	}
	if _, open := p.open[id]; !open {
		p.open[id] = &openToolCall{Name: tool.Name}
	}
	return nil
}

func (p *EventParser) partialTool(update []byte) error {
	fields, err := parseFields(update)
	if err != nil {
		return err
	}
	var id, cumulative string
	var tool decodedTool
	for _, field := range fields {
		switch field.Number {
		case 1:
			id = string(field.Bytes)
		case 2:
			tool, err = decodeToolCall(field.Bytes)
		case 3:
			cumulative = string(field.Bytes)
		}
	}
	if err != nil {
		return err
	}
	if id == "" {
		return nil
	}
	open := p.open[id]
	if open == nil && tool.Name != "" {
		open = &openToolCall{Name: tool.Name}
		p.open[id] = open
	}
	if open != nil && len(cumulative) >= len(open.Arguments) {
		open.Arguments = cumulative
	}
	return nil
}

func (p *EventParser) completeTool(update []byte) (*types.AdapterEvent, error) {
	id, tool, err := parseToolUpdate(update)
	if err != nil {
		return nil, err
	}
	if id == "" {
		return nil, nil
	}
	if _, done := p.completed[id]; done {
		return nil, nil
	}
	open := p.open[id]
	if open == nil {
		if tool.Name == "" {
			return nil, nil
		}
		open = &openToolCall{Name: tool.Name}
	}
	arguments := open.Arguments
	if len(tool.Arguments) > 0 {
		encoded, err := json.Marshal(tool.Arguments)
		if err != nil {
			return nil, err
		}
		arguments = string(encoded)
	}
	if !json.Valid([]byte(arguments)) {
		arguments = "{}"
	}
	if arguments == "" {
		arguments = "{}"
	}
	delete(p.open, id)
	p.completed[id] = struct{}{}
	return &types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: id, Name: open.Name, Arguments: json.RawMessage(arguments)}}, nil
}

func (p *EventParser) finish() []types.AdapterEvent {
	p.terminated = true
	if len(p.open) > 0 {
		ids := make([]string, 0, len(p.open))
		for id := range p.open {
			ids = append(ids, id)
		}
		p.open = map[string]*openToolCall{}
		return []types.AdapterEvent{{Type: types.EventError, Error: "Cursor stream ended with incomplete tool call(s): " + strings.Join(ids, ", "), StatusCode: 502}}
	}
	usage := p.currentUsage()
	return []types.AdapterEvent{{Type: types.EventDone, Usage: &usage, StopReason: "stop"}}
}

func (p *EventParser) currentUsage() types.Usage {
	usage := p.usage
	if p.contextTokens > 0 {
		usage.TotalTokens = p.contextTokens
		usage.InputTokens = max(0, p.contextTokens-usage.OutputTokens)
	} else {
		usage.TotalTokens = usage.InputTokens + usage.OutputTokens
	}
	return usage
}

type decodedTool struct {
	Name      string
	Arguments map[string]any
}

func parseToolUpdate(data []byte) (string, decodedTool, error) {
	fields, err := parseFields(data)
	if err != nil {
		return "", decodedTool{}, err
	}
	var id string
	var tool decodedTool
	for _, field := range fields {
		if field.Number == 1 {
			id = string(field.Bytes)
		}
		if field.Number == 2 {
			tool, err = decodeToolCall(field.Bytes)
		}
	}
	return id, tool, err
}

func decodeToolCall(data []byte) (decodedTool, error) {
	fields, err := parseFields(data)
	if err != nil {
		return decodedTool{}, err
	}
	var mcp []byte
	for _, field := range fields {
		if field.Number == 15 {
			mcp = field.Bytes
		}
	}
	if len(mcp) == 0 {
		return decodedTool{}, nil
	}
	mcpFields, err := parseFields(mcp)
	if err != nil {
		return decodedTool{}, err
	}
	var argsData []byte
	for _, field := range mcpFields {
		if field.Number == 1 {
			argsData = field.Bytes
		}
	}
	if len(argsData) == 0 {
		return decodedTool{}, nil
	}
	argsFields, err := parseFields(argsData)
	if err != nil {
		return decodedTool{}, err
	}
	tool := decodedTool{Arguments: map[string]any{}}
	provider := ""
	for _, field := range argsFields {
		switch field.Number {
		case 1:
			if tool.Name == "" {
				tool.Name = string(field.Bytes)
			}
		case 2:
			entry, err := parseFields(field.Bytes)
			if err != nil {
				return decodedTool{}, err
			}
			var key string
			var valueBytes []byte
			for _, item := range entry {
				if item.Number == 1 {
					key = string(item.Bytes)
				}
				if item.Number == 2 {
					valueBytes = item.Bytes
				}
			}
			if key != "" {
				value, err := UnmarshalValue(valueBytes)
				if err != nil {
					return decodedTool{}, err
				}
				tool.Arguments[key] = value
			}
		case 4:
			provider = string(field.Bytes)
		case 5:
			if string(field.Bytes) != "" {
				tool.Name = string(field.Bytes)
			}
		}
	}
	if provider != "" && provider != cursorToolProvider {
		return decodedTool{}, nil
	}
	tool.Name = strings.TrimPrefix(tool.Name, "mcp_"+cursorToolProvider+"_")
	return tool, nil
}

func nestedString(data []byte, number int) (string, error) {
	fields, err := parseFields(data)
	if err != nil {
		return "", err
	}
	for _, field := range fields {
		if field.Number == number {
			return string(field.Bytes), nil
		}
	}
	return "", nil
}
func nestedVarint(data []byte, number int) (uint64, error) {
	fields, err := parseFields(data)
	if err != nil {
		return 0, err
	}
	for _, field := range fields {
		if field.Number == number {
			return field.Varint, nil
		}
	}
	return 0, nil
}

package sidecar

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

func modelDiscoveryPayload(root *config.OrderedValue) ([]byte, error) {
	var out bytes.Buffer
	modelDiscovery := root.Find("modelDiscovery")
	policy := "on"
	if candidate, ok := modelDiscovery.Find("newModelPolicy").StringValue(); ok {
		policy = candidate
	}
	var disabled []string
	for _, item := range root.Find("disabledModels").Elements() {
		if slug, ok := item.StringValue(); ok {
			disabled = append(disabled, slug)
		}
	}
	out.WriteString(`{"policy":`)
	if err := writeJSONString(&out, policy); err != nil {
		return nil, err
	}
	out.WriteString(`,"providers":{`)
	for i, entry := range root.Find("providers").ECMAScriptEntries() {
		if i > 0 {
			out.WriteByte(',')
		}
		if err := writeJSONString(&out, entry.Key); err != nil {
			return nil, err
		}
		out.WriteByte(':')
		providerPolicy := "inherit"
		if candidate, ok := entry.Value.Find("newModelPolicy").StringValue(); ok {
			providerPolicy = candidate
		}
		if err := writeJSONString(&out, providerPolicy); err != nil {
			return nil, err
		}
	}
	out.WriteString(`},"recentArrivals":{`)
	for i, entry := range modelDiscovery.Find("recentArrivals").ECMAScriptEntries() {
		if i > 0 {
			out.WriteByte(',')
		}
		if err := writeJSONString(&out, entry.Key); err != nil {
			return nil, err
		}
		out.WriteString(`:[`)
		for j, row := range entry.Value.Elements() {
			if j > 0 {
				out.WriteByte(',')
			}
			id, _ := row.Find("id").StringValue()
			fields := row.ECMAScriptEntries()
			if fields == nil {
				return nil, fmt.Errorf("arrival row is not an object")
			}
			out.WriteByte('{')
			for k, field := range fields {
				if k > 0 {
					out.WriteByte(',')
				}
				if err := writeJSONString(&out, field.Key); err != nil {
					return nil, err
				}
				out.WriteByte(':')
				raw, err := field.Value.MarshalStringify()
				if err != nil {
					return nil, err
				}
				out.Write(raw)
			}
			if len(fields) > 0 {
				out.WriteByte(',')
			}
			out.WriteString(`"state":`)
			state := "enabled"
			if modelDisabled(disabled, entry.Key, id) {
				state = "auto-disabled"
			}
			if err := writeJSONString(&out, state); err != nil {
				return nil, err
			}
			out.WriteByte('}')
		}
		out.WriteByte(']')
	}
	out.WriteString(`},"baselineCounts":{`)
	for i, entry := range modelDiscovery.Find("knownModels").ECMAScriptEntries() {
		if i > 0 {
			out.WriteByte(',')
		}
		if err := writeJSONString(&out, entry.Key); err != nil {
			return nil, err
		}
		fmt.Fprintf(&out, ":%d", len(entry.Value.Find("ids").Elements()))
	}
	out.WriteString(`}}`)
	return out.Bytes(), nil
}
func writeJSONString(out *bytes.Buffer, value string) error {
	raw, err := config.JSONStringifyString(value)
	if err != nil {
		return err
	}
	out.Write(raw)
	return nil
}
func modelDisabled(disabled []string, provider, id string) bool {
	routed := provider + "/" + strings.ReplaceAll(id, "/", "-")
	raw := provider + "/" + id
	for _, stored := range disabled {
		if stored == raw || stored == routed {
			return true
		}
	}
	return false
}

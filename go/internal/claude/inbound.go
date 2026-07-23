package claude

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

var dateSuffix = regexp.MustCompile(`-\d{8}$`)
var routeDirective = regexp.MustCompile(`(?i)<!--\s*ocx-route:\s*([^\s]+)\s*-->`)

type InboundConfig struct {
	ModelMap      map[string]string
	BlockedSkills []string
}
type InboundTranslation struct {
	Body           map[string]any
	CacheKeySource string
}

func ResolveInboundModel(model string, cfg *InboundConfig) string {
	model = StripOneMillionMarker(model)
	if resolved, ok := ResolveAlias(model); ok {
		return resolved
	}
	if cfg != nil {
		if v := cfg.ModelMap[model]; v != "" {
			return v
		}
		if v := cfg.ModelMap[dateSuffix.ReplaceAllString(model, "")]; v != "" {
			return v
		}
	}
	return model
}
func EffortForThinkingBudget(n int) string {
	if n <= 4096 {
		return "low"
	}
	if n <= 16384 {
		return "medium"
	}
	return "high"
}
func ExtractRouteDirective(raw any) string {
	m, ok := raw.(map[string]any)
	if !ok {
		return ""
	}
	text := systemText(m["system"])
	match := routeDirective.FindStringSubmatch(text)
	if len(match) > 1 {
		return match[1]
	}
	return ""
}

func ParseAnthropicRequest(raw []byte, cfg *InboundConfig) (*types.NormalizedRequest, error) {
	var body any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("anthropic request: %w", err)
	}
	translated, err := AnthropicToResponses(body, cfg)
	if err != nil {
		return nil, err
	}
	wire, _ := json.Marshal(translated.Body)
	return ParseResponsesRequest(wire)
}

func AnthropicToResponses(raw any, cfg *InboundConfig) (InboundTranslation, error) {
	request, ok := raw.(map[string]any)
	if !ok {
		return InboundTranslation{}, fmt.Errorf("request body must be a JSON object")
	}
	model := stringField(request, "model")
	messages, ok := request["messages"].([]any)
	if model == "" {
		return InboundTranslation{}, fmt.Errorf("model is required")
	}
	if !ok || len(messages) == 0 {
		return InboundTranslation{}, fmt.Errorf("messages must be a non-empty array")
	}
	body := map[string]any{"model": ResolveInboundModel(model, cfg), "input": []any{}, "store": false, "stream": request["stream"] == true}
	input := body["input"].([]any)
	systems := []string{}
	if s := systemText(request["system"]); s != "" {
		systems = append(systems, s)
	}
	blocked := effectiveBlockedSkills(cfg)
	blockedCalls := blockedSkillCalls(messages, blocked)
	for _, value := range messages {
		msg, ok := value.(map[string]any)
		if !ok {
			return InboundTranslation{}, fmt.Errorf("each message must be an object")
		}
		role := stringField(msg, "role")
		switch role {
		case "system":
			if s := systemText(msg["content"]); s != "" {
				systems = append(systems, s)
			}
		case "user":
			var err error
			input, err = anthropicUser(input, msg["content"], blocked, blockedCalls)
			if err != nil {
				return InboundTranslation{}, err
			}
		case "assistant":
			var err error
			input, err = anthropicAssistant(input, msg["content"])
			if err != nil {
				return InboundTranslation{}, err
			}
		default:
			return InboundTranslation{}, fmt.Errorf("unsupported message role: %s", role)
		}
	}
	body["input"] = input
	if len(systems) > 0 {
		body["instructions"] = strings.Join(systems, "\n\n")
	}
	if tools, ok := request["tools"].([]any); ok {
		translated := []any{}
		for _, v := range tools {
			m, ok := v.(map[string]any)
			if !ok {
				continue
			}
			t := stringField(m, "type")
			if strings.HasPrefix(t, "web_search") {
				translated = append(translated, map[string]any{"type": "web_search"})
			} else if name := stringField(m, "name"); name != "" {
				if schema, ok := m["input_schema"].(map[string]any); ok {
					x := map[string]any{"type": "function", "name": name, "parameters": schema}
					if d := stringField(m, "description"); d != "" {
						x["description"] = d
					}
					translated = append(translated, x)
				}
			}
		}
		if len(translated) > 0 {
			body["tools"] = translated
		}
	}
	if choice, ok := request["tool_choice"].(map[string]any); ok {
		if choice["disable_parallel_tool_use"] == true {
			body["parallel_tool_calls"] = false
		}
		switch stringField(choice, "type") {
		case "auto", "none":
			body["tool_choice"] = stringField(choice, "type")
		case "any":
			body["tool_choice"] = "required"
		case "tool":
			name := stringField(choice, "name")
			if name == "" {
				return InboundTranslation{}, fmt.Errorf("tool_choice.tool requires a name")
			}
			body["tool_choice"] = map[string]any{"type": "function", "name": name}
		}
	}
	copyNumber(request, body, "max_tokens", "max_output_tokens")
	copyNumber(request, body, "temperature", "temperature")
	copyNumber(request, body, "top_p", "top_p")
	if stops, ok := request["stop_sequences"].([]any); ok && len(stops) > 0 {
		body["stop"] = stops
	}
	source := ""
	if metadata, ok := request["metadata"].(map[string]any); ok {
		if id := stringField(metadata, "user_id"); id != "" {
			body["user"] = id
			body["prompt_cache_key"] = hash32(id)
			source = "metadata"
		}
	}
	if source == "" && len(systems) > 0 {
		body["prompt_cache_key"] = hash32(canonical(map[string]any{"version": 2, "model": body["model"], "system": systems, "tools": body["tools"]}))
		source = "system"
	}
	thinking, _ := request["thinking"].(map[string]any)
	disabled := stringField(thinking, "type") == "disabled"
	effort := ""
	if output, ok := request["output_config"].(map[string]any); ok {
		candidate := stringField(output, "effort")
		if validEffort(candidate) {
			effort = candidate
		}
	}
	if !disabled && (thinking != nil || effort != "") {
		reasoning := map[string]any{"summary": "auto"}
		if effort != "" {
			reasoning["effort"] = effort
		} else if stringField(thinking, "type") == "enabled" {
			if n, ok := thinking["budget_tokens"].(float64); ok {
				reasoning["effort"] = EffortForThinkingBudget(int(n))
			}
		}
		body["reasoning"] = reasoning
	}
	return InboundTranslation{body, source}, nil
}

func anthropicUser(input []any, content any, blocked []string, calls map[string]bool) ([]any, error) {
	if s, ok := content.(string); ok {
		if s != "" {
			input = append(input, messageItem("user", []any{map[string]any{"type": "input_text", "text": s}}))
		}
		return input, nil
	}
	blocks, _ := content.([]any)
	pending := []any{}
	flush := func() {
		if len(pending) > 0 {
			input = append(input, messageItem("user", pending))
			pending = []any{}
		}
	}
	for _, v := range blocks {
		m, ok := v.(map[string]any)
		if !ok {
			continue
		}
		switch stringField(m, "type") {
		case "text":
			text := stringField(m, "text")
			if len(text) >= 10000 && strings.HasPrefix(text, "Base directory for this skill: ") {
				line := strings.SplitN(strings.TrimPrefix(text, "Base directory for this skill: "), "\n", 2)[0]
				base := strings.ToLower(filepath.Base(strings.ReplaceAll(strings.TrimSpace(line), "\\", "/")))
				if contains(blocked, base) {
					text = "[opencodex] '" + base + "' skill document bundle elided for routed models"
				}
			}
			pending = append(pending, map[string]any{"type": "input_text", "text": text})
		case "image":
			if image := imageBlock(m); image != nil {
				pending = append(pending, image)
			}
		case "document":
			pending = append(pending, map[string]any{"type": "input_text", "text": "[document: " + stringField(m, "title") + "]"})
		case "tool_result":
			flush()
			id := stringField(m, "tool_use_id")
			if id == "" {
				return input, fmt.Errorf("tool_result requires tool_use_id")
			}
			output := toolResult(m)
			if calls[id] {
				output = "[opencodex] Skill document bundle elided for routed models"
			}
			input = append(input, map[string]any{"type": "function_call_output", "call_id": id, "output": output})
		}
	}
	flush()
	return input, nil
}
func anthropicAssistant(input []any, content any) ([]any, error) {
	if s, ok := content.(string); ok {
		if s != "" {
			input = append(input, messageItem("assistant", []any{map[string]any{"type": "output_text", "text": s}}))
		}
		return input, nil
	}
	blocks, _ := content.([]any)
	pending := []any{}
	flush := func() {
		if len(pending) > 0 {
			input = append(input, messageItem("assistant", pending))
			pending = []any{}
		}
	}
	for _, v := range blocks {
		m, ok := v.(map[string]any)
		if !ok {
			continue
		}
		switch stringField(m, "type") {
		case "text":
			pending = append(pending, map[string]any{"type": "output_text", "text": stringField(m, "text")})
		case "tool_use":
			flush()
			id, name := stringField(m, "id"), stringField(m, "name")
			if id == "" || name == "" {
				return input, fmt.Errorf("tool_use requires id and name")
			}
			args, _ := json.Marshal(m["input"])
			input = append(input, map[string]any{"type": "function_call", "call_id": id, "name": name, "arguments": string(args)})
		}
	}
	flush()
	return input, nil
}
func messageItem(role string, content []any) map[string]any {
	return map[string]any{"type": "message", "role": role, "content": content}
}
func imageBlock(m map[string]any) map[string]any {
	source, ok := m["source"].(map[string]any)
	if !ok {
		return nil
	}
	if stringField(source, "type") == "base64" {
		return map[string]any{"type": "input_image", "image_url": "data:" + firstNonEmpty(stringField(source, "media_type"), "image/png") + ";base64," + stringField(source, "data")}
	}
	if u := stringField(source, "url"); u != "" {
		return map[string]any{"type": "input_image", "image_url": u}
	}
	return nil
}
func toolResult(m map[string]any) any {
	prefix := ""
	if m["is_error"] == true {
		prefix = "[tool error] "
	}
	if s, ok := m["content"].(string); ok {
		return prefix + s
	}
	return prefix
}
func effectiveBlockedSkills(cfg *InboundConfig) []string {
	values := []string{"claude-api"}
	if cfg != nil && cfg.BlockedSkills != nil {
		values = cfg.BlockedSkills
	}
	seen := map[string]bool{}
	out := []string{}
	for _, v := range values {
		v = strings.ToLower(strings.TrimSpace(v))
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}
func blockedSkillCalls(messages []any, blocked []string) map[string]bool {
	out := map[string]bool{}
	for _, v := range messages {
		m, ok := v.(map[string]any)
		if !ok || stringField(m, "role") != "assistant" {
			continue
		}
		a, _ := m["content"].([]any)
		for _, x := range a {
			b, ok := x.(map[string]any)
			if !ok || stringField(b, "type") != "tool_use" || stringField(b, "name") != "Skill" {
				continue
			}
			raw, _ := json.Marshal(b["input"])
			for _, name := range blocked {
				if strings.Contains(strings.ToLower(string(raw)), name) {
					out[stringField(b, "id")] = true
				}
			}
		}
	}
	return out
}
func systemText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	a, _ := v.([]any)
	out := []string{}
	for _, x := range a {
		if m, ok := x.(map[string]any); ok && stringField(m, "type") == "text" {
			out = append(out, stringField(m, "text"))
		}
	}
	return strings.Join(out, "\n\n")
}
func validEffort(s string) bool {
	return contains([]string{"minimal", "low", "medium", "high", "xhigh", "max", "ultra"}, s)
}
func contains(values []string, s string) bool {
	for _, v := range values {
		if v == s {
			return true
		}
	}
	return false
}
func copyNumber(from, to map[string]any, a, b string) {
	if n, ok := from[a].(float64); ok {
		to[b] = n
	}
}
func hash32(s string) string { sum := sha256.Sum256([]byte(s)); return hex.EncodeToString(sum[:])[:32] }
func canonical(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		b, _ := json.Marshal(x)
		return string(b)
	case float64, bool:
		b, _ := json.Marshal(x)
		return string(b)
	case []string:
		a := make([]any, len(x))
		for i := range x {
			a[i] = x[i]
		}
		return canonical(a)
	case []any:
		p := make([]string, len(x))
		for i := range x {
			p[i] = canonical(x[i])
		}
		return "[" + strings.Join(p, ",") + "]"
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		p := []string{}
		for _, k := range keys {
			kb, _ := json.Marshal(k)
			p = append(p, string(kb)+":"+canonical(x[k]))
		}
		return "{" + strings.Join(p, ",") + "}"
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}

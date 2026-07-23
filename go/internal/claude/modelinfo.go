package claude

import "fmt"

const modelInfoCreatedAt = "2026-01-01T00:00:00Z"

type CapabilitySupport struct {
	Supported bool `json:"supported"`
}
type EffortCapability struct {
	Supported bool               `json:"supported"`
	Low       CapabilitySupport  `json:"low"`
	Medium    CapabilitySupport  `json:"medium"`
	High      CapabilitySupport  `json:"high"`
	Max       CapabilitySupport  `json:"max"`
	XHigh     *CapabilitySupport `json:"xhigh"`
}
type ThinkingTypes struct {
	Adaptive CapabilitySupport `json:"adaptive"`
	Enabled  CapabilitySupport `json:"enabled"`
}
type ThinkingCapability struct {
	Supported bool          `json:"supported"`
	Types     ThinkingTypes `json:"types"`
}
type ModelCapabilities struct {
	Batch             CapabilitySupport  `json:"batch"`
	Citations         CapabilitySupport  `json:"citations"`
	CodeExecution     CapabilitySupport  `json:"code_execution"`
	Effort            EffortCapability   `json:"effort"`
	ImageInput        CapabilitySupport  `json:"image_input"`
	PDFInput          CapabilitySupport  `json:"pdf_input"`
	StructuredOutputs CapabilitySupport  `json:"structured_outputs"`
	Thinking          ThinkingCapability `json:"thinking"`
}
type ModelInfo struct {
	ID             string            `json:"id"`
	DisplayName    string            `json:"display_name"`
	Type           string            `json:"type"`
	CreatedAt      string            `json:"created_at"`
	Capabilities   ModelCapabilities `json:"capabilities"`
	MaxInputTokens *int              `json:"max_input_tokens"`
	MaxTokens      *int              `json:"max_tokens"`
}
type DiscoveryModel struct {
	Provider, ID     string
	DisplayName      string
	ReasoningEfforts []string
	ContextWindow    int
	ImageInput       bool
}

func BuildModelInfos(native []DiscoveryModel, routed []DiscoveryModel, auto AutoContextMode) []ModelInfo {
	out := []ModelInfo{}
	seen := map[string]bool{}
	push := func(info ModelInfo, window int, allowAuto bool) {
		if seen[info.ID] {
			return
		}
		seen[info.ID] = true
		out = append(out, info)
		mode := auto
		if !allowAuto {
			mode = AutoContextOff
		}
		if ShouldMarkOneMillion(window, mode) && !seen[info.ID+"[1m]"] {
			seen[info.ID+"[1m]"] = true
			variant := info
			variant.ID += "[1m]"
			if window >= OneMillion {
				variant.DisplayName += " · 1M"
			} else {
				variant.DisplayName += fmt.Sprintf(" · %dk", (window+500)/1000)
			}
			n := min(window, OneMillion)
			variant.MaxInputTokens = &n
			out = append(out, variant)
		}
	}
	for _, m := range native {
		id := ClaudeCodeNativeAlias(m.ID)
		push(newModelInfo(id, m.ID+" (native)", m), m.ContextWindow, true)
	}
	for _, m := range routed {
		id := ClaudeCodeAlias(m.Provider, m.ID)
		push(newModelInfo(id, m.ID+" ("+m.Provider+")", m), m.ContextWindow, m.Provider != "anthropic")
	}
	return out
}

func newModelInfo(id, display string, m DiscoveryModel) ModelInfo {
	rungs := map[string]bool{}
	for _, r := range m.ReasoningEfforts {
		if r == "low" || r == "medium" || r == "high" || r == "xhigh" || r == "max" {
			rungs[r] = true
		}
	}
	supported := len(rungs) > 0
	var xh *CapabilitySupport
	if supported {
		v := CapabilitySupport{rungs["xhigh"]}
		xh = &v
	}
	capFalse := CapabilitySupport{}
	caps := ModelCapabilities{Batch: capFalse, Citations: capFalse, CodeExecution: capFalse, ImageInput: CapabilitySupport{m.ImageInput}, PDFInput: capFalse, StructuredOutputs: capFalse,
		Effort: EffortCapability{supported, CapabilitySupport{rungs["low"]}, CapabilitySupport{rungs["medium"]}, CapabilitySupport{rungs["high"]}, CapabilitySupport{rungs["max"]}, xh}, Thinking: ThinkingCapability{supported, ThinkingTypes{CapabilitySupport{supported}, CapabilitySupport{supported}}}}
	var window *int
	if m.ContextWindow > 0 {
		n := m.ContextWindow
		window = &n
	}
	return ModelInfo{ID: id, DisplayName: display, Type: "model", CreatedAt: modelInfoCreatedAt, Capabilities: caps, MaxInputTokens: window}
}

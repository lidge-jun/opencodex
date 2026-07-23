package claude

import (
	"strconv"
	"strings"
)

const (
	OneMillion               = 1_000_000
	AutoCompactWindowDefault = 350_000
	AutoContextFloor         = 200_000
	AutoCompactWindowMin     = 100_000
	AutoCompactWindowMax     = OneMillion
)

type AutoContextMode struct {
	Enabled       bool
	CompactWindow int
}

var AutoContextOff = AutoContextMode{CompactWindow: AutoCompactWindowDefault}

type ContextConfig struct {
	AutoContext       *bool
	AutoCompactWindow int
	MaxContextTokens  int
}

type ContextModel struct {
	Provider      string
	ID            string
	ContextWindow int
}

func HasOneMillionMarker(s string) bool { return strings.HasSuffix(strings.ToLower(s), "[1m]") }
func StripOneMillionMarker(s string) string {
	if HasOneMillionMarker(s) {
		return s[:len(s)-4]
	}
	return s
}

func ResolveAutoContext(cfg *ContextConfig, envOverride string) AutoContextMode {
	if cfg != nil && cfg.AutoContext != nil && !*cfg.AutoContext {
		return AutoContextOff
	}
	if cfg != nil && cfg.MaxContextTokens > 0 {
		return AutoContextOff
	}
	if envOverride != "" {
		var n int
		if value, err := strconv.Atoi(envOverride); err == nil {
			n = value
		}
		if validCompactWindow(n) {
			return AutoContextMode{true, n}
		}
		return AutoContextOff
	}
	n := AutoCompactWindowDefault
	if cfg != nil && validCompactWindow(cfg.AutoCompactWindow) {
		n = cfg.AutoCompactWindow
	}
	return AutoContextMode{true, n}
}

func validCompactWindow(n int) bool { return n >= AutoCompactWindowMin && n <= AutoCompactWindowMax }

func ShouldMarkOneMillion(window int, auto AutoContextMode) bool {
	return window >= OneMillion || (window > AutoContextFloor && auto.Enabled && window >= auto.CompactWindow)
}

func WithOneMillionMarker(selector string, windows map[string]int, auto AutoContextMode) string {
	if selector == "" || HasOneMillionMarker(selector) {
		return selector
	}
	if ShouldMarkOneMillion(windows[StripOneMillionMarker(selector)], auto) {
		return selector + "[1m]"
	}
	return selector
}

func BuildClaudeContextWindows(native map[string]int, routed []ContextModel) map[string]int {
	out := map[string]int{}
	put := func(k string, n int) {
		if k != "" && n > 0 {
			if _, ok := out[k]; !ok {
				out[k] = n
			}
		}
	}
	for slug, window := range native {
		put(slug, window)
		if a, ok := AliasForNative(slug); ok {
			put(a, window)
		}
	}
	counts := map[string]int{}
	for _, m := range routed {
		counts[m.ID]++
	}
	for _, m := range routed {
		if m.ContextWindow <= 0 || (m.Provider == "anthropic" && m.ContextWindow < OneMillion) {
			continue
		}
		put(m.Provider+"/"+m.ID, m.ContextWindow)
		if a, ok := AliasForRoute(m.Provider, m.ID); ok {
			put(a, m.ContextWindow)
		}
		if counts[m.ID] == 1 {
			put(m.ID, m.ContextWindow)
		}
	}
	return out
}

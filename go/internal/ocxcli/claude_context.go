package ocxcli

// Claude-surface context-window + model-env computation — the Go mirror of
// src/claude/context-windows.ts (issue #56 slice). The [1m] marker semantics,
// the auto-compact window and the model-slot env map must byte-match TypeScript
// because Claude Code accounts tokens from the exact strings we hand it.

import (
	"math"
	"regexp"
	"strconv"
)

const (
	claudeAutoCompactDefault = 829_800
	claudeOneMillionTokens   = 1_000_000
	claudeAutoContextFloor   = 200_000
	// Binary-verified accepted range for CLAUDE_CODE_AUTO_COMPACT_WINDOW
	// (Claude Code 2.1.207: pSo=1e5, yDs=1e6).
	claudeAutoCompactMin = 100_000
	claudeAutoCompactMax = 1_000_000
)

// claudeAutoContextMode mirrors AutoContextMode.
type claudeAutoContextMode struct {
	Enabled       bool
	CompactWindow int64
}

// claudeAutoContextOff mirrors AUTO_CONTEXT_OFF.
var claudeAutoContextOff = claudeAutoContextMode{Enabled: false, CompactWindow: claudeAutoCompactDefault}

// ClaudeTierModels mirrors ClaudeTierModels (optional per slot).
type claudeTierModels struct {
	Opus, Sonnet, Haiku, Fable *string
}

// claudeAutoContextSlice is the part of the claudeCode config the auto-context
// resolver reads.
type claudeAutoContextSlice struct {
	AutoContext       *bool
	AutoCompactWindow *int64
	MaxContextTokens  *float64
}

// ClaudeCodeView is the launcher-relevant claudeCode config slice. Strings are
// empty when absent (matching `undefined` semantics on every read site).
type claudeCodeView struct {
	Enabled             *bool
	AuthMode            string
	Model               string
	SmallFastModel      string
	TierModels          claudeTierModels
	AutoContext         *bool
	AutoCompactWindow   *int64
	MaxContextTokens    *float64
	AlwaysEnableEffort  bool
	NativePassthrough   *bool
	InjectAgents        *bool
	SubagentEffort      string
	BlockedSkills       []string
	ModelMap            map[string]string
	subagentModels      []string
	providersConfigured map[string]bool
}

var oneMillionMarkerRe = regexp.MustCompile(`(?i)\[1m\]$`)

func hasOneMillionMarker(value string) bool {
	return oneMillionMarkerRe.MatchString(value)
}

func stripOneMillionMarker(value string) string {
	return oneMillionMarkerRe.ReplaceAllString(value, "")
}

func claudeInAutoCompactRange(value float64) bool {
	return value == math.Trunc(value) && value >= claudeAutoCompactMin && value <= claudeAutoCompactMax
}

// numberLike mirrors TS Number(value) for the env-override lane: parse a float,
// accepting hex and exponent forms and surrounding whitespace.
func numberLike(value string) (float64, bool) {
	v, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, false
	}
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

// claudeResolveAutoContext mirrors resolveAutoContext.
func claudeResolveAutoContext(slice claudeAutoContextSlice, envOverride string) claudeAutoContextMode {
	if slice.AutoContext != nil && !*slice.AutoContext {
		return claudeAutoContextOff
	}
	if slice.MaxContextTokens != nil {
		maxCtx := *slice.MaxContextTokens
		if !math.IsNaN(maxCtx) && !math.IsInf(maxCtx, 0) && maxCtx > 0 {
			return claudeAutoContextOff
		}
	}
	if envOverride != "" {
		parsed, ok := numberLike(envOverride)
		if ok && claudeInAutoCompactRange(parsed) {
			return claudeAutoContextMode{Enabled: true, CompactWindow: int64(parsed)}
		}
		return claudeAutoContextOff
	}
	window := int64(claudeAutoCompactDefault)
	if slice.AutoCompactWindow != nil {
		raw := float64(*slice.AutoCompactWindow)
		if claudeInAutoCompactRange(raw) {
			window = *slice.AutoCompactWindow
		}
	}
	return claudeAutoContextMode{Enabled: true, CompactWindow: window}
}

// claudeShouldMarkOneMillion mirrors shouldMarkOneMillion.
func claudeShouldMarkOneMillion(window int64, auto claudeAutoContextMode) bool {
	if window <= 0 {
		return false
	}
	if window >= claudeOneMillionTokens {
		return true
	}
	return auto.Enabled && window > claudeAutoContextFloor && window >= auto.CompactWindow
}

// claudeWithOneMillionMarker mirrors withOneMillionMarker.
func claudeWithOneMillionMarker(selector string, windows map[string]int64, auto claudeAutoContextMode) string {
	if selector == "" {
		return ""
	}
	if hasOneMillionMarker(selector) {
		return selector
	}
	window := windows[stripOneMillionMarker(selector)]
	if claudeShouldMarkOneMillion(window, auto) {
		return selector + "[1m]"
	}
	return selector
}

// claudeEffectiveModelEnv mirrors effectiveModelEnv: ANTHROPIC_MODEL plus the
// four tier defaults and the legacy small-fast alias. The effective-haiku
// contract: tierModels.haiku ?? smallFastModel injected into BOTH haiku vars.
func claudeEffectiveModelEnv(slice claudeCodeView, windows map[string]int64, autoOverride *claudeAutoContextMode) map[string]string {
	auto := claudeAutoContextOff
	if autoOverride != nil {
		auto = *autoOverride
	} else {
		auto = claudeResolveAutoContext(claudeAutoContextSlice{
			AutoContext:       slice.AutoContext,
			AutoCompactWindow: slice.AutoCompactWindow,
			MaxContextTokens:  slice.MaxContextTokens,
		}, "")
	}
	out := map[string]string{}
	set := func(name, value string) {
		marked := claudeWithOneMillionMarker(value, windows, auto)
		if marked != "" {
			out[name] = marked
		}
	}
	set("ANTHROPIC_MODEL", slice.Model)
	opus := ""
	if slice.TierModels.Opus != nil {
		opus = *slice.TierModels.Opus
	}
	set("ANTHROPIC_DEFAULT_OPUS_MODEL", opus)
	sonnet := ""
	if slice.TierModels.Sonnet != nil {
		sonnet = *slice.TierModels.Sonnet
	}
	set("ANTHROPIC_DEFAULT_SONNET_MODEL", sonnet)
	fable := ""
	if slice.TierModels.Fable != nil {
		fable = *slice.TierModels.Fable
	}
	set("ANTHROPIC_DEFAULT_FABLE_MODEL", fable)
	effectiveHaiku := slice.SmallFastModel
	if slice.TierModels.Haiku != nil {
		effectiveHaiku = *slice.TierModels.Haiku
	}
	set("ANTHROPIC_DEFAULT_HAIKU_MODEL", effectiveHaiku)
	set("ANTHROPIC_SMALL_FAST_MODEL", effectiveHaiku)
	return out
}

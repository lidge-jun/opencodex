package ocxcli

// v2_command_write.go — the Go-owned `ocx v2` write surface (issue #56, slice
// v2b). Byte mirror of src/cli/v2.ts cmdV2 for the verbs that mutate
// config.toml or config.json: on/off (feature flip through the upstream codex
// CLI + thread-limit migration), mode, keep-native-v1, threads, mode-hint, and
// the bare `v2` / `v2 status` summary. The trailing catalog resync mirrors
// syncModelsToCodex's cmdV2-visible contract: a desired-disabled config skips
// silently, and every other state delegates to the TS sync engine the way the
// Go-owned `ocx sync` command does (sync_command.go runSyncDelegate).

import (
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// runV2 dispatches the write verbs; `v2 status` and the bare `v2` keep the v2a
// reader (runV2Status) which this file extends with the rest of cmdV2.
func runV2(args []string, deps Deps) int {
	verb := "status"
	if len(args) > 0 {
		verb = strings.ToLower(strings.TrimSpace(args[0]))
	}
	switch verb {
	case "status":
		return runV2Status(args, deps)
	case "mode-hint":
		return runV2ModeHint(args, deps)
	case "threads":
		return runV2Threads(args, deps)
	case "mode":
		return runV2Mode(args, deps)
	case "keep-native-v1":
		return runV2KeepNativeV1(args, deps)
	case "on", "off":
		return runV2Flip(verb == "on", args, deps)
	default:
		fmt.Fprintf(deps.Stderr, "v2: unknown verb '%s' (expected status|on|off|mode <v1|default|v2>|keep-native-v1 <on|off>|threads <n>|mode-hint <text|--clear>)\n", verb)
		return ExitFailure
	}
}

func v2FeatureToggle(action, configPath string) func(enable bool) error {
	return func(enable bool) error {
		next := action
		if action == "" {
			if enable {
				next = "enable"
			} else {
				next = "disable"
			}
		}
		path := configPath
		if path == "" {
			path = codexConfigTomlPath()
		}
		return runCodexFeaturesToggle(next, path)
	}
}

// resyncAfterV2Flip mirrors the cmdV2 trailing `await syncModelsToCodex(port)`:
// desired-disabled returns silently (sync.ts skipped status); any other state
// delegates to the TS sync engine. failText carries the cmdV2 log prefix for
// the error path that returns 1.
//
// Known residue: the delegation runs the `ocx sync` command surface rather
// than the in-process syncModelsToCodex call, so on a machine where a service
// refuses the write (authority: service-home) the TS cmdV2 tail is silent
// while this delegate prints the sync command's refused wrapper to stderr.
// Functionally both refuse and leave the catalog untouched; parity rows keep
// the config integration OFF so the desired-disabled branch hides the wrapper
// on every machine.
func resyncAfterV2Flip(deps Deps, failText string) bool {
	if !shouldSyncCodexOnStart(loadRawConfigSafe()) {
		return true
	}
	if _, err := deps.Delegate([]string{"sync"}); err != nil {
		fmt.Fprintf(deps.Stderr, "%s %s — run 'ocx sync' manually.\n", failText, err)
		return false
	}
	return true
}

func runV2ModeHint(args []string, deps Deps) int {
	if len(args) < 2 {
		fmt.Fprintln(deps.Stderr, "v2 mode-hint: pass the hint text, or --clear to unset it.")
		return ExitFailure
	}
	value := args[1]
	if value == "--clear" {
		result := setCodexV2StringField("multi_agent_mode_hint_text", nil, "")
		if !result.ok {
			fmt.Fprintf(deps.Stderr, "v2 mode-hint: %s\n", result.err)
			return ExitFailure
		}
		if result.changed {
			fmt.Fprintln(deps.Stdout, "multi_agent_mode_hint_text cleared — effort-derived policy resumes (new sessions).")
		} else {
			fmt.Fprintln(deps.Stdout, "multi_agent_mode_hint_text already unset — nothing to do.")
		}
		return ExitOK
	}
	// `--clear` is the only reserved token; hints are otherwise arbitrary
	// nonblank text and may legitimately begin with a hyphen.
	if len(strings.TrimSpace(value)) == 0 {
		fmt.Fprintln(deps.Stderr, "v2 mode-hint: pass the hint text, or --clear to unset it.")
		return ExitFailure
	}
	if probe := probeCodexSupportsModeHint(); probe != nil && !*probe {
		fmt.Fprintln(deps.Stderr, "v2 mode-hint: installed Codex does not support multi_agent_mode_hint_text; update Codex first")
		return ExitFailure
	}
	result := setCodexV2StringField("multi_agent_mode_hint_text", &value, "")
	if !result.ok {
		fmt.Fprintf(deps.Stderr, "v2 mode-hint: %s\n", result.err)
		return ExitFailure
	}
	if result.changed {
		fmt.Fprintln(deps.Stdout, "multi_agent_mode_hint_text set (new sessions).")
	} else {
		fmt.Fprintln(deps.Stdout, "multi_agent_mode_hint_text already set — nothing to do.")
	}
	return ExitOK
}

func runV2Threads(args []string, deps Deps) int {
	if len(args) < 2 {
		fmt.Fprintln(deps.Stderr, "v2 threads: pass an integer >= 1 (features.multi_agent_v2.max_concurrent_threads_per_session)")
		return ExitFailure
	}
	value, ok := parseV2ThreadValue(args[1])
	if !ok {
		fmt.Fprintln(deps.Stderr, "v2 threads: pass an integer >= 1 (features.multi_agent_v2.max_concurrent_threads_per_session)")
		return ExitFailure
	}
	content, present := readCodexConfigToml()
	enabled := codexMultiAgentV2Enabled(content, present)
	result := transitionCodexMultiAgentV2(enabled, v2FeatureToggle("", ""), "", value, true)
	if !result.ok {
		fmt.Fprintf(deps.Stderr, "v2 threads: %s\n", result.err)
		return ExitFailure
	}
	if result.changed {
		unit := "v1"
		if enabled {
			unit = "v2"
		}
		fmt.Fprintf(deps.Stdout, "max_threads = %d (%s) — applies to new sessions.\n", value, unit)
	} else {
		fmt.Fprintf(deps.Stdout, "max_threads already %d — nothing to do.\n", value)
	}
	return ExitOK
}

func runV2Mode(args []string, deps Deps) int {
	// TS: (args[1] ?? "").trim().toLowerCase() — a bare `v2 mode` is the empty
	// string and fails the list check; only an explicit `default` resets.
	modeArg := ""
	if len(args) > 1 {
		modeArg = strings.ToLower(strings.TrimSpace(args[1]))
	}
	if modeArg != "v1" && modeArg != "default" && modeArg != "v2" {
		fmt.Fprintln(deps.Stderr, "v2 mode: expected v1|default|v2")
		return ExitFailure
	}
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	keepNative := cfg["keepNativeChatGptOnV1"] == true
	if modeArg != "default" {
		target := modeArg == "v2" && !keepNative
		transition := transitionCodexMultiAgentV2(target, v2FeatureToggle("", ""), "", 0, false)
		if !transition.ok {
			fmt.Fprintf(deps.Stderr, "multi-agent mode transition failed: %s\n", transition.err)
			return ExitFailure
		}
	}
	if modeArg == "default" {
		delete(cfg, "multiAgentMode")
	} else {
		cfg["multiAgentMode"] = modeArg
	}
	if err := configSaveRaw(cfg); err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	if !resyncAfterV2Flip(deps, "catalog resync failed:") {
		return ExitFailure
	}
	fmt.Fprintln(deps.Stdout, multiAgentModeLine(modeArg, false))
	fmt.Fprintln(deps.Stdout, "Applies to NEW sessions; running sessions keep their pinned multi-agent version.")
	return ExitOK
}

func runV2KeepNativeV1(args []string, deps Deps) int {
	flag := "off"
	if len(args) > 1 {
		flag = strings.ToLower(strings.TrimSpace(args[1]))
	}
	if flag != "on" && flag != "off" {
		fmt.Fprintln(deps.Stderr, "v2 keep-native-v1: expected on|off")
		return ExitFailure
	}
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	next := flag == "on"
	already := cfg["keepNativeChatGptOnV1"] == true == next
	// requiresGlobalV2Disabled(cfg.multiAgentMode, true): turning the pin ON
	// while mode is v2 conflicts with a live global override, so drop the
	// flag first (TS passes a fixed `true` here, not the current pin state).
	if next && cfg["multiAgentMode"] == "v2" {
		transition := transitionCodexMultiAgentV2(false, v2FeatureToggle("", ""), "", 0, false)
		if !transition.ok {
			fmt.Fprintf(deps.Stderr, "keep-native-v1 transition failed: %s\n", transition.err)
			return ExitFailure
		}
	}
	if next {
		cfg["keepNativeChatGptOnV1"] = true
	} else {
		delete(cfg, "keepNativeChatGptOnV1")
	}
	if err := configSaveRaw(cfg); err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	if !resyncAfterV2Flip(deps, "catalog resync failed:") {
		return ExitFailure
	}
	if already {
		if next {
			fmt.Fprintln(deps.Stdout, "keep_native_chatgpt_on_v1 already ON — catalog re-synced.")
		} else {
			fmt.Fprintln(deps.Stdout, "keep_native_chatgpt_on_v1 already OFF — catalog re-synced.")
		}
		return ExitOK
	}
	if next {
		fmt.Fprintln(deps.Stdout, "keep_native_chatgpt_on_v1: ON — ChatGPT-native rows stay v1 when mode is v2 (new sessions).")
	} else {
		fmt.Fprintln(deps.Stdout, "keep_native_chatgpt_on_v1: OFF — ChatGPT-native rows follow v1/base/v2 (new sessions).")
	}
	return ExitOK
}

func runV2Flip(want bool, args []string, deps Deps) int {
	if want {
		cfg, err := loadCLIConfig()
		if err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return ExitFailure
		}
		if cfg["multiAgentMode"] == "v2" && cfg["keepNativeChatGptOnV1"] == true {
			fmt.Fprintln(deps.Stderr, "v2 on: incompatible with keep-native-v1 while mode is v2 — Codex's global multi_agent_v2 overrides the native v1 catalog pin. Run 'ocx v2 keep-native-v1 off' first.")
			return ExitFailure
		}
	}
	action := "disable"
	if want {
		action = "enable"
	}
	transition := transitionCodexMultiAgentV2(want, v2FeatureToggle(action, ""), "", 0, false)
	if !transition.ok {
		fmt.Fprintf(deps.Stderr, "codex features %s multi_agent_v2 failed: %s\n", action, transition.err)
		return ExitFailure
	}
	if !transition.changed {
		state := "OFF"
		if want {
			state = "ON"
		}
		fmt.Fprintf(deps.Stdout, "multi_agent_v2 already %s — nothing to do.\n", state)
		return ExitOK
	}
	if !resyncAfterV2Flip(deps, "catalog resync failed (flag IS flipped):") {
		return ExitFailure
	}
	if want {
		fmt.Fprintln(deps.Stdout, "multi_agent_v2: ON — global V2 override active")
	} else {
		fmt.Fprintln(deps.Stdout, "multi_agent_v2: OFF — model catalog pins and defaults decide the surface")
	}
	fmt.Fprintln(deps.Stdout, "Applies to NEW sessions; running sessions keep their pinned multi-agent version. Restart the Codex app (or wait out its picker cache) to see the ladder change.")
	return ExitOK
}

// configSaveRaw writes the raw opencodex config map like TS saveConfig.
func configSaveRaw(raw map[string]any) error {
	return config.SaveRaw(raw)
}

// multiAgentModeLine mirrors src/cli/v2.ts multiAgentModeLine.
func multiAgentModeLine(mode string, keepNativeChatGptOnV1 bool) string {
	switch mode {
	case "v1":
		return "multi_agent_mode: v1 — ALL models forced to v1 surface (upstream pins overridden)"
	case "v2":
		if keepNativeChatGptOnV1 {
			return "multi_agent_mode: v2 hybrid — ChatGPT-native models use v1; routed models use v2"
		}
		return "multi_agent_mode: v2 — ALL models forced to v2 surface (upstream pins overridden)"
	default:
		return "multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)"
	}
}

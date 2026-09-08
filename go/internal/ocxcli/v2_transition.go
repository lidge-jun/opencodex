package ocxcli

// v2_transition.go — the migration core of `ocx v2 on|off|threads|mode|
// keep-native-v1` (issue #56, slice v2b). Byte mirror of
// src/codex/features.ts transitionMultiAgentV2 and its helpers
// (transitionConfigError / discoverStoredThreadLimit / activeThreadComment /
// applyConfigEditsAtomically / the v1<->v2 thread-limit translations). The
// enabled-flag flip itself is delegated to the upstream `codex features`
// CLI via the toggle callback; every failure path restores the exact original
// config bytes.

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

const (
	maxTranslatableV1ChildLimitV2 = 1_000_000
	maxTranslatableV2TotalLimitV2 = 1_000_001
)

type v2ThreadUnits string

const (
	v2ThreadUnitsChild v2ThreadUnits = "v1-child"
	v2ThreadUnitsTotal v2ThreadUnits = "v2-total"
)

type v2StoredThreadLimit struct {
	value int64
	units v2ThreadUnits
}

func isTranslatableV1ChildLimit(limit int64) bool {
	return limit >= 1 && limit <= maxTranslatableV1ChildLimitV2
}

func isTranslatableV2TotalLimit(limit int64) bool {
	return limit >= 1 && limit <= maxTranslatableV2TotalLimitV2
}

func v1ChildLimitToV2TotalLimit(childLimit int64) (int64, error) {
	if !isTranslatableV1ChildLimit(childLimit) {
		return 0, fmt.Errorf("v1 child limit out of translatable range: %d", childLimit)
	}
	return childLimit + 1, nil
}

func v2TotalLimitToV1ChildLimit(totalLimit int64) (int64, error) {
	if !isTranslatableV2TotalLimit(totalLimit) {
		return 0, fmt.Errorf("v2 total limit out of translatable range: %d", totalLimit)
	}
	if totalLimit <= 1 {
		return 1, nil
	}
	return totalLimit - 1, nil
}

// codexGetMaxConcurrentThreads mirrors getMaxConcurrentThreads: scanner-only
// (no underscore separators) read of the v2 total-thread limit.
func codexGetMaxConcurrentThreads(configPath string) (int64, bool) {
	content, ok := readCodexConfigTextAt(configPath)
	if !ok {
		return 0, false
	}
	return codexMaxConcurrentThreads(content, true)
}

// codexGetAgentsMaxThreads mirrors getAgentsMaxThreads: parse-first (underscore
// separators visible) read of the legacy [agents] child limit.
func codexGetAgentsMaxThreads(configPath string) (int64, bool) {
	content, ok := readCodexConfigTextAt(configPath)
	if !ok {
		return 0, false
	}
	return codexAgentsMaxThreads(content, true)
}

// codexIsMultiAgentV2Enabled mirrors isMultiAgentV2Enabled(path).
func codexIsMultiAgentV2Enabled(configPath string) bool {
	content, ok := readCodexConfigTextAt(configPath)
	if !ok {
		return false
	}
	return codexMultiAgentV2Enabled(content, true)
}

// codexHasAgentsMaxThreadsAt mirrors hasAgentsMaxThreads(path).
func codexHasAgentsMaxThreadsAt(configPath string) bool {
	content, ok := readCodexConfigTextAt(configPath)
	if !ok {
		return false
	}
	return codexHasAgentsMaxThreads(content, true)
}

// discoverStoredThreadLimit mirrors the migration-side sibling of
// getLogicalMaxThreads: which storage the active limit lives in, in that
// storage's native units, never translated.
func discoverStoredThreadLimit(configPath string) *v2StoredThreadLimit {
	if codexIsMultiAgentV2Enabled(configPath) {
		if v2, found := codexGetMaxConcurrentThreads(configPath); found {
			return &v2StoredThreadLimit{value: v2, units: v2ThreadUnitsTotal}
		}
		if legacy, found := codexGetAgentsMaxThreads(configPath); found {
			return &v2StoredThreadLimit{value: legacy, units: v2ThreadUnitsChild}
		}
		return nil
	}
	if legacy, found := codexGetAgentsMaxThreads(configPath); found {
		return &v2StoredThreadLimit{value: legacy, units: v2ThreadUnitsChild}
	}
	if v2, found := codexGetMaxConcurrentThreads(configPath); found {
		return &v2StoredThreadLimit{value: v2, units: v2ThreadUnitsTotal}
	}
	return nil
}

// activeThreadComment mirrors features.ts: the trailing comment of the limit
// line in the storage the migration leaves, so the value carries its provenance
// comment into the destination key.
func activeThreadComment(content string, v2Enabled bool) string {
	legacy := regexp.MustCompile(`(?m)^\s*max_threads\s*=\s*\d+(\s*#.*)$`).FindStringSubmatch(tomlTableBodyOr(content, "agents"))
	var legacyComment string
	if legacy != nil {
		legacyComment = legacy[1]
	}
	dedicated := regexp.MustCompile(`(?m)^\s*max_concurrent_threads_per_session\s*=\s*\d+(\s*#.*)$`).FindStringSubmatch(tomlTableBodyOr(content, "features.multi_agent_v2"))
	var dedicatedComment string
	if dedicated != nil {
		dedicatedComment = dedicated[1]
	}
	features := tomlTableBodyOr(content, "features")
	inlineLine := regexp.MustCompile(`(?m)^\s*multi_agent_v2\s*=\s*\{([^}]*)\}(\s*#.*)$`).FindStringSubmatch(features)
	var inlineComment string
	if inlineLine != nil && regexp.MustCompile(`(?:^|,)\s*max_concurrent_threads_per_session\s*=\s*\d+\s*(?:,|$)`).MatchString(inlineLine[1]) {
		inlineComment = inlineLine[2]
	}
	if v2Enabled {
		if dedicatedComment != "" {
			return dedicatedComment
		}
		if inlineComment != "" {
			return inlineComment
		}
		return legacyComment
	}
	if legacyComment != "" {
		return legacyComment
	}
	if dedicatedComment != "" {
		return dedicatedComment
	}
	return inlineComment
}

func tomlTableBodyOr(content, header string) string {
	body, ok := tomlTableBody(content, header)
	if !ok {
		return ""
	}
	return body
}

// transitionConfigError mirrors transitionConfigError: refuses dotted keys,
// duplicate tables/definitions and duplicate thread-limit keys before any
// migration touches a byte.
func transitionConfigError(content string) string {
	if regexp.MustCompile(`(?m)^\s*(?:features\.multi_agent_v2(?:\.[A-Za-z0-9_]+)?|agents\.max_threads)\s*=`).MatchString(content) {
		return "dotted multi-agent config keys are not supported for automatic migration"
	}
	countHeaders := func(header string) int {
		return len(regexp.MustCompile(`(?m)^\s*\[`+header+`\]\s*(?:#.*)?$`).FindAllString(content, -1))
	}
	dedicatedTables := countHeaders(`features\.multi_agent_v2`)
	featuresTables := countHeaders(`features`)
	agentsTables := countHeaders(`agents`)
	if dedicatedTables > 1 || featuresTables > 1 || agentsTables > 1 {
		return "duplicate multi-agent TOML tables cannot be migrated safely"
	}
	features := tomlTableBodyOr(content, "features")
	featureDefs := regexp.MustCompile(`(?m)^\s*multi_agent_v2\s*=`).FindAllString(features, -1)
	if len(featureDefs) > 1 || (dedicatedTables == 1 && len(featureDefs) == 1) {
		return "duplicate multi_agent_v2 definitions cannot be migrated safely"
	}
	if regexp.MustCompile(`(?m)^\s*multi_agent_v2\.(?:enabled|max_concurrent_threads_per_session)\s*=`).MatchString(features) {
		return "dotted multi_agent_v2 fields are not supported for automatic migration"
	}
	agents := tomlTableBodyOr(content, "agents")
	if len(regexp.MustCompile(`(?m)^\s*max_threads\s*=`).FindAllString(agents, -1)) > 1 {
		return "duplicate agents.max_threads definitions cannot be migrated safely"
	}
	dedicated := tomlTableBodyOr(content, "features.multi_agent_v2")
	if len(regexp.MustCompile(`(?m)^\s*max_concurrent_threads_per_session\s*=`).FindAllString(dedicated, -1)) > 1 {
		return "duplicate v2 thread-limit definitions cannot be migrated safely"
	}
	return ""
}

// applyCodexEditsAtomically mirrors applyConfigEditsAtomically: run the edit on
// a temp sibling of the real config, then promote it; a failed inner edit
// leaves the original untouched.
func applyCodexEditsAtomically(configPath string, edit func(tempPath string) codexEditResult) codexEditResult {
	content, ok := readCodexConfigTextAt(configPath)
	if !ok {
		return codexEditError(fmt.Sprintf("config.toml not readable at %s", configPath))
	}
	tempPath := fmt.Sprintf("%s.ocx-migration.%d.tmp", configPath, os.Getpid())
	if err := atomicWriteTextFile(tempPath, content); err != nil {
		return codexEditError(err.Error())
	}
	defer os.Remove(tempPath)
	result := edit(tempPath)
	if !result.ok {
		return result
	}
	edited, ok := readCodexConfigTextAt(tempPath)
	if !ok {
		return codexEditError("temporary config migration output is unreadable")
	}
	if edited == content {
		return codexEditResult{ok: true}
	}
	if err := atomicWriteTextFile(configPath, edited); err != nil {
		return codexEditError(err.Error())
	}
	return codexEditResult{ok: true, changed: true}
}

type v2TransitionResult struct {
	ok          bool
	changed     bool
	threadLimit int64
	hasThread   bool
	err         string
}

// nullEqual compares a config key read against a possibly-null expectation.
func nullEqual(value int64, found bool, want int64, wantSet bool) bool {
	if !wantSet {
		return !found
	}
	return found && value == want
}

// transitionCodexMultiAgentV2 mirrors transitionMultiAgentV2. toggleFeature
// runs the upstream `codex features enable|disable` flip; threadLimit is the
// caller-supplied limit in destination units (0 + hasThread=false = discover).
func transitionCodexMultiAgentV2(enabled bool, toggleFeature func(enable bool) error, configPath string, threadLimit int64, hasThread bool) v2TransitionResult {
	path := configPath
	if path == "" {
		path = codexConfigTomlPath()
	}
	if hasThread && threadLimit < 1 {
		return v2TransitionResult{err: "thread limit must be an integer >= 1"}
	}
	original, ok := readCodexConfigTextAt(path)
	if !ok {
		return v2TransitionResult{err: fmt.Sprintf("config.toml not readable at %s", path)}
	}
	if preflight := transitionConfigError(original); preflight != "" {
		return v2TransitionResult{err: preflight}
	}
	beforeEnabled := codexIsMultiAgentV2Enabled(path)
	discovered := discoverStoredThreadLimit(path)
	destUnits := v2ThreadUnitsTotal
	if !enabled {
		destUnits = v2ThreadUnitsChild
	}
	limit := threadLimit
	limitSet := hasThread
	if !hasThread {
		if discovered != nil {
			limit = discovered.value
			limitSet = true
		}
	}
	// A discovered limit crosses the root-slot boundary only when its units
	// differ from the destination's.
	if !hasThread && discovered != nil && discovered.units != destUnits {
		var translated int64
		var err error
		if discovered.units == v2ThreadUnitsChild {
			translated, err = v1ChildLimitToV2TotalLimit(discovered.value)
		} else {
			translated, err = v2TotalLimitToV1ChildLimit(discovered.value)
		}
		if err != nil {
			return v2TransitionResult{err: err.Error()}
		}
		limit = translated
		limitSet = true
	}
	migratedComment := activeThreadComment(original, beforeEnabled)
	fail := func(errText string) v2TransitionResult {
		// Restore the exact original bytes on any failure.
		if werr := atomicWriteTextFile(path, original); werr != nil {
			return v2TransitionResult{err: errText + "; rollback failed: " + werr.Error()}
		}
		return v2TransitionResult{err: errText}
	}
	if enabled {
		if !beforeEnabled {
			staged := applyCodexEditsAtomically(path, func(temp string) codexEditResult {
				v2 := ensureCodexDisabledV2Config(limit, limitSet, temp, migratedComment)
				if !v2.ok {
					return v2
				}
				return editCodexAgentsMaxThreads(0, true, temp, "")
			})
			if !staged.ok {
				return fail(staged.err)
			}
			if err := toggleFeature(true); err != nil {
				return fail(err.Error())
			}
		}
		if !codexIsMultiAgentV2Enabled(path) {
			return fail("codex feature command did not enable multi_agent_v2")
		}
		target := applyCodexEditsAtomically(path, func(temp string) codexEditResult {
			var v2 codexEditResult
			if limitSet {
				v2 = setCodexMaxConcurrentThreads(limit, temp, migratedComment)
			} else {
				v2 = removeCodexMaxConcurrentThreads(temp)
			}
			if !v2.ok {
				return v2
			}
			return editCodexAgentsMaxThreads(0, true, temp, "")
		})
		if !target.ok {
			return fail(target.err)
		}
		if codexHasAgentsMaxThreadsAt(path) {
			return fail("v2 thread-limit migration postcondition failed")
		}
		if got, found := codexGetMaxConcurrentThreads(path); !nullEqual(got, found, limit, limitSet) {
			return fail("v2 thread-limit migration postcondition failed")
		}
	} else {
		if beforeEnabled {
			if err := toggleFeature(false); err != nil {
				return fail(err.Error())
			}
		}
		if codexIsMultiAgentV2Enabled(path) {
			return fail("codex feature command did not disable multi_agent_v2")
		}
		target := applyCodexEditsAtomically(path, func(temp string) codexEditResult {
			v2 := removeCodexMaxConcurrentThreads(temp)
			if !v2.ok {
				return v2
			}
			return editCodexAgentsMaxThreads(limit, !limitSet, temp, migratedComment)
		})
		if !target.ok {
			return fail(target.err)
		}
		if _, found := codexGetMaxConcurrentThreads(path); found {
			return fail("v1 thread-limit migration postcondition failed")
		}
		if got, found := codexGetAgentsMaxThreads(path); !nullEqual(got, found, limit, limitSet) {
			return fail("v1 thread-limit migration postcondition failed")
		}
	}
	changed, _ := readCodexConfigTextAt(path)
	return v2TransitionResult{
		ok:          true,
		changed:     changed != original,
		threadLimit: limit,
		hasThread:   limitSet,
	}
}

// parseV2ThreadValue mirrors the `v2 threads` CLI parsing: integer >= 1.
func parseV2ThreadValue(text string) (int64, bool) {
	value, err := strconv.ParseInt(strings.TrimSpace(text), 10, 64)
	if err != nil || value < 1 {
		return 0, false
	}
	return value, true
}

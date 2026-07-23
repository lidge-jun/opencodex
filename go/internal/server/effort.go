package server

import (
	"encoding/json"
	"net/http"
	"strings"
)

var effortOrder = map[string]int{"none": 0, "minimal": 1, "low": 2, "medium": 3, "high": 4, "xhigh": 5, "max": 6, "ultra": 6}

// ResolveCappedEffort lowers requested to the highest supported rung at or below cap.
// The second return value is false when effort must be stripped.
func ResolveCappedEffort(requested, cap string, supported []string) (string, bool) {
	requested, cap = strings.ToLower(requested), strings.ToLower(cap)
	capRank, capKnown := effortOrder[cap]
	if !capKnown {
		return requested, requested != ""
	}
	if supported == nil {
		if rank, ok := effortOrder[requested]; ok && rank > capRank {
			return cap, true
		}
		return requested, requested != ""
	}
	best, bestRank := "", -1
	for _, candidate := range supported {
		candidate = strings.ToLower(candidate)
		if rank, ok := effortOrder[candidate]; ok && rank <= capRank && rank > bestRank {
			best, bestRank = candidate, rank
		}
	}
	if best == "" {
		return "", false
	}
	if rank, ok := effortOrder[requested]; !ok || rank <= bestRank {
		return requested, requested != ""
	}
	return best, true
}

// EnforceEffort applies the stricter of global and subagent caps.
func EnforceEffort(requested, globalCap, subagentCap string, subagent bool, supported []string) (string, bool) {
	cap := globalCap
	if subagent && lowerEffort(subagentCap, cap) {
		cap = subagentCap
	}
	if cap == "" {
		return requested, requested != ""
	}
	return ResolveCappedEffort(requested, cap, supported)
}

func lowerEffort(a, b string) bool {
	ar, aok := effortOrder[strings.ToLower(a)]
	br, bok := effortOrder[strings.ToLower(b)]
	return aok && (!bok || ar < br)
}

// IsThreadSpawnRequest recognizes the exact Codex spawned-child markers.
func IsThreadSpawnRequest(header http.Header) bool {
	if header.Get("X-OpenAI-Subagent") == "collab_spawn" {
		return true
	}
	var metadata struct {
		SubagentKind string `json:"subagent_kind"`
	}
	return json.Unmarshal([]byte(header.Get("X-Codex-Turn-Metadata")), &metadata) == nil && metadata.SubagentKind == "thread_spawn"
}

package config

import "strings"

var reasoningOrder = []string{"low", "medium", "high", "xhigh", "max", "ultra"}

// NormalizeReasoningEffort converts accepted client aliases to the Codex ladder.
// A false result means the value disables reasoning or is not recognized.
func NormalizeReasoningEffort(value string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "minimal":
		return "low", true
	case "low", "medium", "high", "xhigh", "max", "ultra":
		return normalized, true
	default:
		return "", false
	}
}

func ReasoningEffortRank(value string) int {
	normalized, ok := NormalizeReasoningEffort(value)
	if !ok {
		return -1
	}
	for i, effort := range reasoningOrder {
		if effort == normalized {
			return i
		}
	}
	return -1
}

// MapReasoningEffort applies the Codex ultra boundary, clamps to provider
// capabilities, and finally translates through the provider wire map.
func MapReasoningEffort(requested string, supported []string, wireMap map[string]string) (string, bool) {
	effort, ok := NormalizeReasoningEffort(requested)
	if !ok {
		return "", false
	}
	if effort == "ultra" {
		effort = "max"
	}
	if mapped, exists := wireMap[effort]; exists {
		return mapped, true
	}
	if supported != nil {
		effort, ok = clampEffort(effort, supported)
		if !ok {
			return "", false
		}
	}
	if mapped, exists := wireMap[effort]; exists {
		return mapped, true
	}
	return effort, true
}

func clampEffort(requested string, supported []string) (string, bool) {
	requestedRank := ReasoningEffortRank(requested)
	best := ""
	bestRank := -1
	lowest := ""
	lowestRank := len(reasoningOrder)
	for _, candidate := range supported {
		normalized, ok := NormalizeReasoningEffort(candidate)
		if !ok {
			continue
		}
		rank := ReasoningEffortRank(normalized)
		if rank < lowestRank {
			lowest, lowestRank = normalized, rank
		}
		if rank <= requestedRank && rank > bestRank {
			best, bestRank = normalized, rank
		}
	}
	if best != "" {
		return best, true
	}
	return lowest, lowest != ""
}

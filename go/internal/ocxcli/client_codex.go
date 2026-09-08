package ocxcli

// Codex journal + injected-routing ownership, ported from
// src/codex/journal.ts and src/codex/injected-marker.ts. These are the pieces
// `ocx disconnect` needs to decide whether it may unwind Codex routing and to
// restore the pre-connection config.toml/profile bytes from the journal.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
)

// OCX_SECTION_MARKER comment + root key detection (injected-marker.ts).

var rootKeyLine = regexp.MustCompile(`^\s*openai_base_url\s*=`)

func isRootOpenaiBaseURL(line string) bool { return rootKeyLine.MatchString(line) }

var tomlStringPattern = regexp.MustCompile(`^\s*(?:"([^"\n]*)"|'([^'\n]*)')\s*(?:#.*)?$`)

// parseTomlString decodes a TOML basic/literal string literal (quotes included
// by the caller's capture) the way parseTomlString in paths.ts does: JSON.parse
// for double-quoted values, plain strip for single-quoted.
func parseTomlStringLiteral(raw string) string {
	if strings.HasPrefix(raw, `"`) {
		var decoded string
		if err := json.Unmarshal([]byte(raw), &decoded); err == nil {
			return decoded
		}
		return raw[1 : len(raw)-1]
	}
	return raw[1 : len(raw)-1]
}

// rootTomlString returns the trimmed value of a root-level key assignment in
// TOML content, or "" when absent. Only the pre-table root region is scanned.
func rootTomlString(content, key string) string {
	lines := strings.Split(content, "\n")
	rootEnd := len(lines)
	for index, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			rootEnd = index
			break
		}
	}
	pattern := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(key) + `\s*=\s*("(?:\\\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$`)
	for _, line := range lines[:rootEnd] {
		match := pattern.FindStringSubmatch(line)
		if match != nil {
			return strings.TrimSpace(parseTomlStringLiteral(match[1]))
		}
	}
	return ""
}

// providerTableStart finds the start index of [model_providers.<provider>].
func providerTableStart(lines []string, provider string) int {
	pattern := regexp.MustCompile(`^\s*\[\s*(?:model_providers|"model_providers"|'model_providers')\s*\.\s*` + regexp.QuoteMeta(provider) + `\s*\]\s*(?:#.*)?$`)
	for index, line := range lines {
		if pattern.MatchString(line) {
			return index
		}
	}
	return -1
}

func providerTableString(content, provider, key string) string {
	lines := strings.Split(content, "\n")
	start := providerTableStart(lines, provider)
	if start == -1 {
		return ""
	}
	pattern := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(key) + `\s*=\s*("(?:\\\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$`)
	for index := start + 1; index < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[index]), "["); index++ {
		match := pattern.FindStringSubmatch(lines[index])
		if match != nil {
			return strings.TrimSpace(parseTomlStringLiteral(match[1]))
		}
	}
	return ""
}

// hasInjectedOpenaiBaseURL reports the marker-adjacency ownership evidence.
func hasInjectedOpenaiBaseURL(content string) bool {
	lines := strings.Split(content, "\n")
	rootEnd := len(lines)
	for index, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			rootEnd = index
			break
		}
	}
	for index := 1; index < rootEnd; index++ {
		if isRootOpenaiBaseURL(lines[index]) && strings.Contains(lines[index-1], ocxSectionMarker) {
			return true
		}
	}
	return false
}

// hasInjectedCodexRouting mirrors hasInjectedCodexRouting: the marker-adjacent
// root override, or the legacy provider table.
func hasInjectedCodexRouting(content string) bool {
	if hasInjectedOpenaiBaseURL(content) {
		return true
	}
	return rootTomlString(content, "model_provider") == "opencodex" &&
		providerTableString(content, "opencodex", "base_url") != ""
}

// isCodexRoutingInjected reads the current Codex config and applies the
// ownership predicate (the isCodexRoutingInjected export of src/codex/inject).
func isCodexRoutingInjected(codexHome string) bool {
	content, err := os.ReadFile(codexConfigPath(codexHome))
	if err != nil {
		return false
	}
	return hasInjectedCodexRouting(string(content))
}

// Codex journal (src/codex/journal.ts).

type journalOwnerKind string

const (
	journalOwnerProcess journalOwnerKind = "process"
	journalOwnerClient  journalOwnerKind = "client"
)

type journalRecord struct {
	originalConfig      string // base64
	originalProfile     string // base64, "" when null
	injectedConfigHash  string // sha256 hex; "" when absent
	hasInjectedProfile  bool   // injectedProfileHash key present
	injectedProfileHash string // sha256 hex or "" when recorded null
	ownerKind           journalOwnerKind
	ownerAPIKeyID       string
	ownerPID            int64
	journalPID          int64
}

type restoreJournalResult struct {
	configRestored  bool
	profileRestored bool
	configChanged   bool
	profileChanged  bool
	complete        bool
}

func readJournal(codexHome string) (*journalRecord, error) {
	path := journalPath(codexHome)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var parsed struct {
		Version             int     `json:"version"`
		OriginalConfig      string  `json:"originalConfig"`
		OriginalProfile     *string `json:"originalProfile"`
		InjectedConfigHash  string  `json:"injectedConfigHash"`
		InjectedProfileHash *string `json:"injectedProfileHash"`
		PID                 int64   `json:"pid"`
		Owner               *struct {
			Kind     string `json:"kind"`
			PID      int64  `json:"pid"`
			APIKeyID string `json:"apiKeyId"`
		} `json:"owner"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		_ = os.Remove(path)
		return nil, nil
	}
	if parsed.Version != 1 {
		_ = os.Remove(path)
		return nil, nil
	}
	record := &journalRecord{
		originalConfig:     parsed.OriginalConfig,
		injectedConfigHash: parsed.InjectedConfigHash,
		journalPID:         parsed.PID,
	}
	if parsed.OriginalProfile != nil {
		record.originalProfile = *parsed.OriginalProfile
	}
	if parsed.InjectedProfileHash != nil {
		record.hasInjectedProfile = true
		record.injectedProfileHash = *parsed.InjectedProfileHash
	}
	if parsed.Owner != nil {
		switch parsed.Owner.Kind {
		case "client":
			record.ownerKind = journalOwnerClient
			record.ownerAPIKeyID = parsed.Owner.APIKeyID
		case "process":
			record.ownerKind = journalOwnerProcess
			record.ownerPID = parsed.Owner.PID
		}
	}
	return record, nil
}

func (r *journalRecord) owner() (journalOwnerKind, string, int64) {
	if r == nil {
		return "", "", 0
	}
	switch r.ownerKind {
	case journalOwnerClient:
		if r.ownerAPIKeyID != "" {
			return journalOwnerClient, r.ownerAPIKeyID, 0
		}
	case journalOwnerProcess:
		if r.ownerPID > 0 {
			return journalOwnerProcess, "", r.ownerPID
		}
	}
	if r.journalPID > 0 {
		return journalOwnerProcess, "", r.journalPID
	}
	return "", "", 0
}

// restoreJournalState mirrors restoreJournalState in src/codex/journal.ts.
func restoreJournalState(codexHome string) restoreJournalResult {
	journal, err := readJournal(codexHome)
	if err != nil || journal == nil {
		return restoreJournalResult{complete: false}
	}
	configContent := ""
	if raw, readErr := os.ReadFile(codexConfigPath(codexHome)); readErr == nil {
		configContent = string(raw)
	}
	var profileContent *string
	if raw, readErr := os.ReadFile(codexProfilePath(codexHome)); readErr == nil {
		text := string(raw)
		profileContent = &text
	}
	configUnchanged := journal.injectedConfigHash == "" || sha256Hex(configContent) == journal.injectedConfigHash
	profileUnchanged := true
	if journal.hasInjectedProfile {
		var currentHash *string
		if profileContent != nil {
			hash := sha256Hex(*profileContent)
			currentHash = &hash
		}
		profileUnchanged = sameOrNil(currentHash, journal.injectedProfileHash)
	}

	configRestored := false
	profileRestored := false
	if configUnchanged {
		if decoded, decodeErr := base64.StdEncoding.DecodeString(journal.originalConfig); decodeErr == nil {
			if writeErr := writeAtomic(codexConfigPath(codexHome), decoded); writeErr == nil {
				configRestored = true
			}
		}
	}
	if profileUnchanged {
		if journal.originalProfile != "" {
			if decoded, decodeErr := base64.StdEncoding.DecodeString(journal.originalProfile); decodeErr == nil {
				if writeErr := writeAtomic(codexProfilePath(codexHome), decoded); writeErr == nil {
					profileRestored = true
				}
			}
		} else if _, statErr := os.Stat(codexProfilePath(codexHome)); statErr == nil {
			if removeErr := os.Remove(codexProfilePath(codexHome)); removeErr == nil || errors.Is(removeErr, os.ErrNotExist) {
				profileRestored = true
			}
		} else {
			profileRestored = true
		}
	}
	complete := configRestored && profileRestored
	if complete {
		_ = os.Remove(journalPath(codexHome))
	}
	return restoreJournalResult{
		configRestored:  configRestored,
		profileRestored: profileRestored,
		configChanged:   !configUnchanged,
		profileChanged:  !profileUnchanged,
		complete:        complete,
	}
}

func sameOrNil(left *string, right string) bool {
	if left == nil {
		return right == ""
	}
	return *left == right
}

package ocxcli

// Claude Code custom-agent definition injection — the Go mirror of
// src/claude/agents-inject.ts (issue #56 slice). Rendered .md bytes must match
// TypeScript exactly: Claude Code loads ocx-*.md agent definitions at session
// start and the subagent roster is the routing contract for `ocx claude`.
//
// Ownership contract: this module only creates/overwrites/deletes files named
// ocx-*.md inside the agents dir; anything without the generated marker is user
// property and never touched. Writes are atomic (tmp + rename).

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

const (
	claudeOwnedPrefix    = "ocx-"
	claudeGeneratedMarker = "generated-by: opencodex"
	// defaultSubagentModels mirrors DEFAULT_SUBAGENT_MODELS (src/config.ts).
	defaultSubagentModels = "gpt-5.5\ngpt-5.6-sol\ngpt-5.6-terra\ngpt-5.6-luna\ngpt-5.4-mini"
	// claudeNoModelArg mirrors NO_MODEL_ARG — appended to every ocx-* description.
	claudeNoModelArg = "NOTE: this agent's real model is pinned by the opencodex proxy — the `model` argument is ignored. Pass model: \"haiku\" as a placeholder (or omit it); routing is unaffected either way."
)

var (
	claudeInvalidNameRe = regexp.MustCompile(`[^a-z0-9]+`)
	claudeClaudePrefixRe = regexp.MustCompile(`^(?:claude|anthropic)(?:-|$)`)
	claudeDateSuffixRe  = regexp.MustCompile(`-\d{8}$`)
)

type claudeAgentDef struct {
	File          string
	Name          string
	Model         string
	Description   string
	Effort        string
	BlockedSkills []string
}

func claudeSanitizeName(value string) string {
	cleaned := claudeInvalidNameRe.ReplaceAllString(strings.ToLower(value), "-")
	cleaned = strings.Trim(cleaned, "-")
	if cleaned == "" {
		return "model"
	}
	return cleaned
}

// claudePickerDefaultModel reads settings.json `model` (the /model picker save).
func claudePickerDefaultModel(configDir string) string {
	data, err := os.ReadFile(filepath.Join(configDir, "settings.json"))
	if err != nil {
		return ""
	}
	var parsed struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return ""
	}
	model := strings.TrimSpace(parsed.Model)
	if model == "" {
		return ""
	}
	return model
}

// claudeWithSubagentContextMarker mirrors withSubagentContextMarker: generated
// defs mark [1m] on the AUTHORITATIVE window only (never the main-session
// auto-context predicate); strip an unsafe marker with no window support.
func claudeWithSubagentContextMarker(selector string, windows map[string]int64) string {
	bare := stripOneMillionMarker(selector)
	wasMarked := selector != bare
	canonicalExact := selector
	if wasMarked {
		canonicalExact = bare + "[1m]"
	}
	window, ok := windows[selector]
	if !ok {
		window, ok = windows[canonicalExact]
	}
	if !ok {
		window, ok = windows[bare]
	}
	if ok && window > 0 {
		if claudeShouldMarkOneMillion(window, claudeAutoContextOff) {
			return claudeWithOneMillionMarker(selector, windows, claudeAutoContextOff)
		}
		return bare
	}
	if wasMarked {
		return selector
	}
	return bare
}

// claudeNativePassthroughFor mirrors the nativePassthrough predicate in
// buildClaudeAgentDefs.blockedSkillsFor. resolve-inbound equality is scoped to
// the alias decode (modelMap/classifier lanes are a documented residual: they
// need src/claude/inbound.ts's configured classifier routing, which the
// launcher-facing predicate does not exercise in any parity fixture).
func claudeNativePassthroughFor(model string, slice *claudeCodeView) bool {
	if slice != nil && slice.NativePassthrough != nil && !*slice.NativePassthrough {
		return false
	}
	unmarked := stripOneMillionMarker(model)
	if strings.Contains(unmarked, "/") {
		return false
	}
	if !claudeClaudePrefixRe.MatchString(unmarked) {
		return false
	}
	if _, ok := claudeResolveAlias(unmarked); ok {
		return false
	}
	return true
}

// claudeEntryParts mirrors entryParts: bare native slugs or provider/id entries.
// A provider WITH an own provider config decodes vendor-encoded ids through the
// router registry; that decode lane is a documented residual (Go keeps the raw
// model part until the slug-codec slice lands), so parity fixtures use unowned
// providers where identity is authoritative on both sides.
type claudeAgentEntry struct {
	Alias    string
	ID       string
	Provider string
}

func claudeAgentEntryFor(entry string, slice *claudeCodeView) claudeAgentEntry {
	slash := strings.Index(entry, "/")
	if slash > 0 {
		provider := entry[:slash]
		id := entry[slash+1:]
		configured := false
		if slice != nil && slice.providersConfigured[provider] {
			configured = true
		}
		if !configured {
			id = entry[slash+1:]
		}
		return claudeAgentEntry{Alias: claudeCodeAlias(provider, id), ID: id, Provider: provider}
	}
	return claudeAgentEntry{Alias: claudeCodeNativeAlias(entry), ID: entry, Provider: claudeNativeProvider}
}

func claudeEffectiveBlockedSkills(slice *claudeCodeView) []string {
	var names []string
	if slice != nil && len(slice.BlockedSkills) > 0 {
		names = slice.BlockedSkills
	} else {
		names = []string{"claude-api"}
	}
	seen := map[string]bool{}
	var out []string
	for _, name := range names {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}

// claudeBuildAgentDefs mirrors buildClaudeAgentDefs.
func claudeBuildAgentDefs(slice *claudeCodeView, subagentModels []string, windows map[string]int64, configDir string) []claudeAgentDef {
	blockedSkills := claudeEffectiveBlockedSkills(slice)
	blockedSkillsFor := func(model string) []string {
		if claudeNativePassthroughFor(model, slice) {
			return nil
		}
		return blockedSkills
	}
	var defs []claudeAgentDef
	usedNames := map[string]bool{}
	coveredModels := map[string]bool{}

	push := func(name, alias, description string) {
		model := claudeWithSubagentContextMarker(alias, windows)
		bare := strings.ToLower(alias)
		if coveredModels[bare] {
			return
		}
		coveredModels[bare] = true
		unique := name
		for i := 2; usedNames[unique]; i++ {
			unique = name + "-" + strconv.Itoa(i)
		}
		usedNames[unique] = true
		effort := ""
		if slice != nil {
			effort = slice.SubagentEffort
		}
		defs = append(defs, claudeAgentDef{
			File:          claudeOwnedPrefix + unique + ".md",
			Name:          claudeOwnedPrefix + unique,
			Model:         model,
			Description:   description,
			Effort:        effort,
			BlockedSkills: blockedSkillsFor(model),
		})
	}

	roster := subagentModels
	if roster == nil {
		roster = strings.Split(defaultSubagentModels, "\n")
	}
	limit := len(roster)
	if limit > 5 {
		limit = 5
	}
	for _, entry := range roster[:limit] {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := claudeAgentEntryFor(entry, slice)
		desc := "Delegate work to " + parts.ID + " (" + parts.Provider + ") via opencodex routing. General-purpose worker/explorer on that model. " + claudeNoModelArg
		push(claudeSanitizeName(parts.ID), parts.Alias, desc)
	}

	selfModel := claudePickerDefaultModel(configDir)
	if selfModel == "" && slice != nil {
		selfModel = strings.TrimSpace(slice.Model)
	}
	if selfModel != "" {
		marked := claudeWithSubagentContextMarker(selfModel, windows)
		effort := ""
		if slice != nil {
			effort = slice.SubagentEffort
		}
		defs = append(defs, claudeAgentDef{
			File:          claudeOwnedPrefix + "self.md",
			Name:          claudeOwnedPrefix + "self",
			Model:         marked,
			Description:   "Self-clone: delegate to your default main model (" + marked + "), synced from the /model picker at launch. " + claudeNoModelArg,
			Effort:        effort,
			BlockedSkills: blockedSkillsFor(marked),
		})
	}
	return defs
}

// claudeJSONString mirrors JSON.stringify scalar emission WITHOUT HTML escaping
// (TS JSON.stringify leaves < > & alone).
func claudeJSONString(value string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(value)
	return strings.TrimSuffix(buf.String(), "\n")
}

// claudeSkillNameLiteral mirrors skillNameLiteral: stringify then escape the
// three characters that would terminate an HTML comment or parse as markup.
func claudeSkillNameLiteral(name string) string {
	out := claudeJSONString(name)
	out = strings.ReplaceAll(out, "`", "\\u0060")
	out = strings.ReplaceAll(out, "<", "\\u003c")
	out = strings.ReplaceAll(out, ">", "\\u003e")
	return out
}

func claudeRenderAgentDef(def claudeAgentDef) string {
	var blockedGuard []string
	if len(def.BlockedSkills) > 0 {
		var names []string
		for _, skill := range def.BlockedSkills {
			names = append(names, claudeSkillNameLiteral(skill))
		}
		blockedGuard = []string{
			"",
			"Do not invoke blocked Claude Code skills: " + strings.Join(names, ", ") + ".",
			"Their document bundles are intentionally omitted for routed models; continue without loading them.",
		}
	}
	lines := []string{
		"---",
		"name: " + claudeJSONString(def.Name),
		"description: " + claudeJSONString(def.Description),
		"model: " + claudeJSONString(def.Model),
	}
	if def.Effort != "" {
		lines = append(lines, "effort: "+claudeJSONString(def.Effort))
	}
	lines = append(lines,
		"---",
		"",
		"<!-- "+claudeGeneratedMarker+" -->",
		"<!-- ocx-route: "+def.Model+" -->",
	)
	if def.Effort != "" {
		lines = append(lines, "<!-- ocx-effort: "+def.Effort+" -->")
	}
	lines = append(lines,
		"",
		"You are a delegated worker running on `"+def.Model+"` through the local opencodex proxy.",
		"IDENTITY: your ACTUAL underlying model is `"+def.Model+"` — the opencodex proxy routes this",
		"session there regardless of what model name the Claude Code harness displays or claims.",
		"If asked which model you are, answer with the id above; do not guess a Claude model name.",
	)
	lines = append(lines, blockedGuard...)
	lines = append(lines,
		"",
		"Complete the dispatched task directly and report results concisely. This file is",
		"auto-generated by opencodex (`ocx claude`) from the featured subagent roster —",
		"manual edits will be overwritten; remove the model from the roster to drop it.",
		"",
	)
	return strings.Join(lines, "\n")
}

// claudeIsOwnedFile mirrors isOwnedFile: regular file with the generated marker.
func claudeIsOwnedFile(path string) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return bytes.Contains(data, []byte(claudeGeneratedMarker))
}

// claudeAtomicRename mirrors renameAtomicFile on Unix; Windows needs the
// remove-then-rename fallback (os.Rename cannot overwrite).
func claudeAtomicRename(tmp, target string) error {
	if err := os.Rename(tmp, target); err == nil || runtime.GOOS != "windows" {
		return err
	}
	if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.Rename(tmp, target)
}

// claudeSyncAgentDefs mirrors syncClaudeAgentDefs: written names + nil error on
// success; nil result is represented as err != nil (best-effort contract).
func claudeSyncAgentDefs(defs []claudeAgentDef, configDir string) ([]string, error) {
	dir := filepath.Join(configDir, "agents")
	if len(defs) == 0 {
		if _, err := os.Lstat(dir); err != nil {
			if os.IsNotExist(err) {
				return []string{}, nil
			}
			return nil, err
		}
	} else if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	keep := map[string]bool{}
	for _, def := range defs {
		keep[def.File] = true
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, claudeOwnedPrefix) || !strings.HasSuffix(name, ".md") {
			continue
		}
		if keep[name] {
			continue
		}
		target := filepath.Join(dir, name)
		if claudeIsOwnedFile(target) {
			_ = os.Remove(target) // best-effort prune
		}
	}
	var written []string
	for _, def := range defs {
		target := filepath.Join(dir, def.File)
		if _, err := os.Lstat(target); err == nil {
			if !claudeIsOwnedFile(target) {
				continue // user property: skip the def
			}
		} else if !os.IsNotExist(err) {
			continue
		}
		tmp := target + ".tmp-" + strconv.Itoa(os.Getpid())
		if err := os.WriteFile(tmp, []byte(claudeRenderAgentDef(def)), 0o644); err != nil {
			return nil, err
		}
		if err := claudeAtomicRename(tmp, target); err != nil {
			return nil, err
		}
		written = append(written, def.File)
	}
	return written, nil
}

// claudeInjectAgentDefs mirrors injectClaudeAgentDefs: disabled -> prune owned
// files so stale defs stop loading; enabled -> build + sync.
func claudeInjectAgentDefs(slice *claudeCodeView, subagentModels []string, windows map[string]int64, configDir string) ([]string, error) {
	if slice != nil && ((slice.Enabled != nil && !*slice.Enabled) || (slice.InjectAgents != nil && !*slice.InjectAgents)) {
		return claudeSyncAgentDefs(nil, configDir)
	}
	defs := claudeBuildAgentDefs(slice, subagentModels, windows, configDir)
	return claudeSyncAgentDefs(defs, configDir)
}



package ocxcli

import (
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// export_models.go — the /api/models row → client model pipeline behind
// `ocx export`. Ports the catalog visibility rules (opencodeCatalogFromProxyRows
// in src/cli/opencode.ts), the ExportModel projection and per-client gating in
// src/clients/config-export.ts, and the shared reasoning-effort helpers.

// codexReasoningLadder is the canonical Codex order (low..ultra).
var codexReasoningLadder = []string{"low", "medium", "high", "xhigh", "max", "ultra"}

// canonicalizeExportReasoningEfforts mirrors canonicalizeReasoningEfforts:
// `none`/`minimal` sentinels first (that order), then ladder members in
// canonical order, duplicates dropped.
func canonicalizeExportReasoningEfforts(values []string) []string {
	seen := map[string]bool{}
	for _, value := range values {
		seen[value] = true
	}
	out := []string{}
	for _, sentinel := range []string{"none", "minimal"} {
		if seen[sentinel] {
			out = append(out, sentinel)
		}
	}
	for _, effort := range codexReasoningLadder {
		if seen[effort] {
			out = append(out, effort)
		}
	}
	return out
}

// sanitizeExportReasoningEfforts mirrors sanitizeCodexReasoningEfforts: keep
// only sentinels + ladder members, drop duplicates, order by ladder rank with
// sentinels first (stable among equal ranks, like V8 sort).
func sanitizeExportReasoningEfforts(efforts []string) []string {
	if efforts == nil {
		return nil
	}
	seen := map[string]bool{}
	rank := map[string]int{}
	for index, effort := range codexReasoningLadder {
		rank[effort] = index
	}
	kept := make([]string, 0, len(efforts))
	position := map[string]int{}
	for _, effort := range efforts {
		valid := effort == "none" || effort == "minimal"
		if !valid {
			if _, ok := rank[effort]; !ok {
				continue
			}
		}
		if seen[effort] {
			continue
		}
		seen[effort] = true
		position[effort] = len(kept)
		kept = append(kept, effort)
	}
	out := append([]string(nil), kept...)
	sort.SliceStable(out, func(i, j int) bool {
		return exportEffortRank(out[i]) < exportEffortRank(out[j])
	})
	_ = position
	return out
}

func exportEffortRank(effort string) int {
	if effort == "none" || effort == "minimal" {
		return -1
	}
	for index, candidate := range codexReasoningLadder {
		if candidate == effort {
			return index
		}
	}
	return -1
}

// exportModelRow is one /api/models row decoded into the fields the catalog
// pipeline reads.
type exportModelRow struct {
	namespaced             string
	provider               string
	id                     string
	native                 bool
	disabled               bool
	displayName            string
	displayNameSource      string
	contextWindow          *jsonwire.Value
	reasoningEfforts       []string
	defaultReasoningEffort string
	inputModalities        []string
}

func decodeExportModelRow(row *jsonwire.Value) exportModelRow {
	var out exportModelRow
	if row == nil || row.Kind() != jsonwire.Object {
		return out
	}
	field := func(key string) *jsonwire.Value { return row.Find(key) }
	out.namespaced = exportMemberString(field("namespaced"))
	out.provider = exportMemberString(field("provider"))
	out.id = exportMemberString(field("id"))
	out.native = exportMemberBool(field("native"))
	out.disabled = exportMemberBool(field("disabled"))
	out.displayName = exportMemberString(field("displayName"))
	out.displayNameSource = exportMemberString(field("displayNameSource"))
	out.contextWindow = field("contextWindow")
	out.defaultReasoningEffort = exportMemberString(field("defaultReasoningEffort"))
	out.reasoningEfforts = exportMemberStringArray(field("reasoningEfforts"))
	out.inputModalities = exportMemberStringArray(field("inputModalities"))
	return out
}

func exportMemberString(value *jsonwire.Value) string {
	if value == nil || value.Kind() != jsonwire.String {
		return ""
	}
	return value.String()
}

func exportMemberBool(value *jsonwire.Value) bool {
	if value == nil || value.Kind() != jsonwire.Bool {
		return false
	}
	return value.Bool()
}

func exportMemberStringArray(value *jsonwire.Value) []string {
	if value == nil || value.Kind() != jsonwire.Array {
		return nil
	}
	out := []string{}
	for _, element := range value.Elements() {
		if element != nil && element.Kind() == jsonwire.String {
			out = append(out, element.String())
		}
	}
	return out
}

// exportCatalogModel mirrors OpencodeCatalogModel (the deduped catalog entry).
type exportCatalogModel struct {
	namespaced             string
	native                 bool
	provider               string
	id                     string
	contextWindow          float64
	hasContextWindow       bool
	displayName            string
	reasoningEfforts       []string
	defaultReasoningEffort string
}

// exportModel mirrors ExportModel (provider/id/… rows after the projection).
type exportModel struct {
	namespaced             string
	provider               string
	id                     string
	native                 bool
	displayName            string
	contextWindow          float64
	hasContextWindow       bool
	inputModalities        []string
	reasoningEfforts       []string
	defaultReasoningEffort string
}

// codexAccountModeDirect mirrors providerCodexAccountMode("openai", …):
// persisted pool/direct wins; the canonical openai registry mode is "pool".
func codexAccountModeDirect(mode string) bool {
	return mode == "direct"
}

// opencodeCatalogFromProxyRows ports src/cli/opencode.ts:
// omitNative only under Codex Direct; disabled rows drop; first namespaced
// wins; displayName is dropped when displayNameSource is "fallback".
func opencodeCatalogFromProxyRows(rows []exportModelRow, codexDirect bool) []exportCatalogModel {
	omitNative := codexDirect
	seen := map[string]bool{}
	catalog := []exportCatalogModel{}
	for _, row := range rows {
		namespaced := strings.TrimSpace(row.namespaced)
		if namespaced == "" || row.disabled {
			continue
		}
		if omitNative && row.native {
			continue
		}
		if seen[namespaced] {
			continue
		}
		seen[namespaced] = true
		entry := exportCatalogModel{
			namespaced:             namespaced,
			native:                 row.native,
			provider:               row.provider,
			id:                     row.id,
			displayName:            row.displayName,
			reasoningEfforts:       row.reasoningEfforts,
			defaultReasoningEffort: row.defaultReasoningEffort,
		}
		if row.displayNameSource == "fallback" {
			entry.displayName = ""
		}
		if row.contextWindow != nil && row.contextWindow.Kind() == jsonwire.Number {
			if parsed, err := strconv.ParseFloat(row.contextWindow.NumberRaw(), 64); err == nil {
				entry.contextWindow = parsed
				entry.hasContextWindow = true
			}
		}
		catalog = append(catalog, entry)
	}
	return catalog
}

// exportModelsFromProxyRows ports exportModelsFromProxyRows: joins modalities
// by namespaced and projects the catalog entry into an ExportModel.
func exportModelsFromProxyRows(rows []exportModelRow, codexDirect bool) []exportModel {
	modalities := map[string][]string{}
	for _, row := range rows {
		namespaced := strings.TrimSpace(row.namespaced)
		if namespaced == "" {
			continue
		}
		if _, exists := modalities[namespaced]; exists {
			continue
		}
		if len(row.inputModalities) > 0 {
			modalities[namespaced] = append([]string(nil), row.inputModalities...)
		}
	}
	catalog := opencodeCatalogFromProxyRows(rows, codexDirect)
	out := make([]exportModel, 0, len(catalog))
	for _, entry := range catalog {
		model := exportModel{
			namespaced:             entry.namespaced,
			id:                     entry.id,
			displayName:            entry.displayName,
			hasContextWindow:       entry.hasContextWindow,
			contextWindow:          entry.contextWindow,
			reasoningEfforts:       entry.reasoningEfforts,
			defaultReasoningEffort: entry.defaultReasoningEffort,
		}
		if entry.provider != "" {
			model.provider = entry.provider
		} else if entry.native {
			model.provider = "openai"
		} else {
			model.provider = "routed"
		}
		if entry.native {
			model.native = true
		}
		if entry.id == "" {
			model.id = entry.namespaced
		}
		if input := modalities[entry.namespaced]; input != nil {
			model.inputModalities = append([]string(nil), input...)
		}
		out = append(out, model)
	}
	return out
}

// normalizeExportModels mirrors normalizeExportModels: dedupe by namespaced
// (first wins) then sort by namespaced ascending (JS string order).
func normalizeExportModels(models []exportModel) []exportModel {
	seen := map[string]bool{}
	unique := []exportModel{}
	for _, model := range models {
		if seen[model.namespaced] {
			continue
		}
		seen[model.namespaced] = true
		unique = append(unique, model)
	}
	sort.Slice(unique, func(i, j int) bool { return unique[i].namespaced < unique[j].namespaced })
	return unique
}

// exportModelLabel mirrors exportModelLabel: "<displayName|id> (native|provider|routed)".
func exportModelLabel(model exportModel) string {
	providerLabel := "routed"
	if model.native {
		providerLabel = "native"
	} else if model.provider != "" {
		providerLabel = model.provider
	}
	id := model.id
	if id == "" {
		id = model.namespaced
	}
	if model.displayName != "" {
		return model.displayName + " (" + providerLabel + ")"
	}
	return id + " (" + providerLabel + ")"
}

// authoritativeExportContextWindow mirrors authoritativeContextWindow:
// a missing/non-finite/non-positive window has no authoritative value; floors
// positive windows (integer floor > 0 required).
func authoritativeExportContextWindow(model exportModel) (float64, bool) {
	if !model.hasContextWindow || model.contextWindow <= 0 {
		return 0, false
	}
	integer := math.Floor(model.contextWindow)
	if integer <= 0 {
		return 0, false
	}
	return integer, true
}

const exportSchemaRequiredOutputBudget = 32_000.0

// outputBudgetForExport mirrors outputBudgetFor: min(32000, context).
func outputBudgetForExport(context float64) float64 {
	if context < exportSchemaRequiredOutputBudget {
		return context
	}
	return exportSchemaRequiredOutputBudget
}

// inputModalitiesForExportClient mirrors inputModalitiesForClient (pi/gajae/
// zcode accepted enum text|image): unknown→["text"], incompatible (no kept)→nil.
func inputModalitiesForExportClient(modalities []string) []string {
	declared := modalities
	if len(declared) == 0 {
		return []string{"text"}
	}
	kept := []string{}
	for _, value := range declared {
		if (value == "text" || value == "image") && !exportContains(kept, value) {
			kept = append(kept, value)
		}
	}
	if len(kept) > 0 {
		return kept
	}
	return nil
}

// dshExportInputModalities mirrors dshInputModalities.
func dshExportInputModalities(modalities []string) []string {
	declared := modalities
	if len(declared) == 0 {
		return []string{"text"}
	}
	kept := []string{}
	for _, value := range declared {
		if (value == "text" || value == "image") && !exportContains(kept, value) {
			kept = append(kept, value)
		}
	}
	if len(kept) > 0 {
		return kept
	}
	allAudio := true
	for _, value := range declared {
		if value != "audio" {
			allAudio = false
			break
		}
	}
	if allAudio {
		return nil
	}
	return []string{"text"}
}

func exportContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

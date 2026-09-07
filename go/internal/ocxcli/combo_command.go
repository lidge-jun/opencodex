package ocxcli

// ocx combo — the virtual-model routing surface (and the `ocx route combo`
// spelling, which shares this implementation). Ports src/cli/combo.ts plus the
// runtime-api error taxonomy; both runtimes read GET /api/combos and write PUT
// /api/combos / DELETE /api/combos through the live proxy's management plane.

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

const comboUsage = `Usage:
  ocx combo [list] [--json]
  ocx combo show <id> [--json]
  ocx combo set <id> --targets <provider/model[:weight],...>
      [--strategy <failover|round-robin|random|least-used|reset-window>] [--sticky <1-100>]
      [--effort <low|medium|high|xhigh|max|ultra|->] [--alias <name|->]
      [--native-alias] [--display-name <label|->]
      [--rename-from <id>] [--json]
  ocx combo remove <id> --yes [--json]`

const comboStrategiesError = "--strategy must be failover, round-robin, random, least-used, or reset-window"

type comboRow struct {
	id       string
	idOK     bool
	model    string
	modelOK  bool
	imageInputDisabled bool
}

// comboListRows decodes the /api/combos `combos` array into the projection the
// renderer consumes (document order preserved).
func comboListRows(value *jsonwire.Value) []comboRow {
	var rows []comboRow
	combos := value.Find("combos")
	if combos == nil || combos.Kind() != jsonwire.Array {
		return rows
	}
	for _, element := range combos.Elements() {
		if element == nil || element.Kind() != jsonwire.Object {
			continue
		}
		row := comboRow{}
		if id := element.Find("id"); id != nil {
			row.id, row.idOK = comboRowID(id)
		}
		if model := element.Find("model"); model != nil && model.Kind() == jsonwire.String {
			row.model, row.modelOK = model.String(), true
		}
		if imageInput := element.Find("imageInput"); imageInput != nil && imageInput.Kind() == jsonwire.String {
			row.imageInputDisabled = imageInput.String() == "disabled"
		}
		rows = append(rows, row)
	}
	return rows
}

// comboRowID mirrors String(row.id): a string stays as-is, other kinds go
// through JS String() semantics (only strings are exercised by the oracle).
func comboRowID(value *jsonwire.Value) (string, bool) {
	if value.Kind() == jsonwire.String {
		return value.String(), true
	}
	if value.Kind() == jsonwire.Number {
		if number, ok := parseJSONNumber(value.NumberRaw()); ok {
			return jsonwire.FormatV8Number(number), true
		}
	}
	return "", false
}

// runCombo implements `ocx combo` and the `ocx route combo <sub>` spelling.
func runCombo(args []string, deps Deps) int {
	sub := "list"
	rest := append([]string(nil), args...)
	if len(rest) > 0 {
		sub = rest[0]
		rest = rest[1:]
	}
	switch sub {
	case "list":
		return runComboList(rest, deps)
	case "show":
		return runComboShow(rest, deps)
	case "set", "create", "update":
		return runComboSet(rest, deps)
	case "remove", "delete":
		return runComboRemove(rest, deps)
	default:
		return routingUsageError(deps, "unknown combo command "+sub, comboUsage)
	}
}

func runComboList(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	jsonOutput := takeFlag(&rest, "--json")
	if len(rest) != 0 {
		return routingUsageError(deps, routingUnexpectedArgs(rest), comboUsage)
	}
	value, rawText, status, err := routingRoundTrip(deps, http.MethodGet, "/api/combos", nil)
	if err == nil {
		err = routingErrorFromRoundTrip(value, rawText, status)
	}
	if err != nil {
		return routingReportError(deps, err.(routingAPIError))
	}
	rows := comboListRows(value)
	var lines []string
	for _, row := range rows {
		display := row.model
		if !row.modelOK {
			// String(row.model ?? `combo/${row.id}`): only a missing/null model
			// falls back to the synthesized public id.
			display = "combo/" + row.id
		}
		lines = append(lines, row.id+"  "+display)
	}
	if len(lines) == 0 {
		lines = []string{"No combos configured."}
	}
	routingPrintData(deps, value, rawText, jsonOutput, lines)
	return ExitOK
}

func runComboShow(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	id := ""
	if len(rest) > 0 {
		id = rest[0]
		rest = rest[1:]
	}
	jsonOutput := takeFlag(&rest, "--json")
	if id == "" {
		return routingUsageError(deps, "combo id is required", comboUsage)
	}
	if len(rest) != 0 {
		return routingUsageError(deps, routingUnexpectedArgs(rest), comboUsage)
	}
	value, rawText, status, err := routingRoundTrip(deps, http.MethodGet, "/api/combos", nil)
	if err == nil {
		err = routingErrorFromRoundTrip(value, rawText, status)
	}
	if err != nil {
		return routingReportError(deps, err.(routingAPIError))
	}
	if row := comboRowForID(value, id); row != nil {
		// printData without human lines prints the row as JSON even without
		// --json, exactly like the TS show path.
		routingPrintData(deps, row, "", jsonOutput, nil)
		return ExitOK
	}
	return routingUsageError(deps, "unknown combo "+id, "")
}

// comboRowForID re-finds the raw /api/combos element whose id equals want so
// the JSON echo prints the server bytes (document order and number literals),
// not a decoded projection.
func comboRowForID(value *jsonwire.Value, want string) *jsonwire.Value {
	combos := value.Find("combos")
	if combos == nil || combos.Kind() != jsonwire.Array {
		return nil
	}
	for _, element := range combos.Elements() {
		if element == nil || element.Kind() != jsonwire.Object {
			continue
		}
		id := element.Find("id")
		if id != nil {
			if text, ok := comboRowID(id); ok && text == want {
				return element
			}
		}
	}
	return nil
}

func runComboSet(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	id := ""
	if len(rest) > 0 {
		id = strings.TrimSpace(rest[0])
		rest = rest[1:]
	}
	jsonOutput := takeFlag(&rest, "--json")
	if id == "" {
		return routingUsageError(deps, "combo id is required", comboUsage)
	}
	targetsRaw, targetsGiven, err := routingTakeOption(&rest, "--targets")
	if err != nil {
		return routingUsageError(deps, err.Error(), "")
	}
	if !targetsGiven || targetsRaw == "" {
		return routingUsageError(deps, "--targets is required", comboUsage)
	}
	strategy, strategyGiven, err := routingTakeOption(&rest, "--strategy")
	if err != nil {
		return routingUsageError(deps, err.Error(), "")
	}
	if !strategyGiven {
		strategy = "failover"
	}
	if strategy != "failover" && strategy != "round-robin" && strategy != "random" && strategy != "least-used" && strategy != "reset-window" {
		return routingUsageError(deps, comboStrategiesError, comboUsage)
	}
	sticky, stickyGiven, err := routingTakeIntegerOption(&rest, "--sticky", 1)
	if err != nil {
		return routingUsageError(deps, err.Error(), "")
	}
	if stickyGiven {
		if sticky > 100 {
			return routingUsageError(deps, "--sticky must be <= 100", comboUsage)
		}
		if strategy != "round-robin" {
			return routingUsageError(deps, "--sticky applies only to round-robin", comboUsage)
		}
	}
	effort, effortGiven, err := routingTakeOption(&rest, "--effort")
	if err != nil {
		return routingUsageError(deps, err.Error(), "")
	}
	alias, aliasGiven, err := routingTakeOption(&rest, "--alias")
	if err != nil {
		return routingUsageError(deps, err.Error(), "")
	}
	nativeAlias := takeFlag(&rest, "--native-alias")
	displayName, displayNameGiven, err := routingTakeOption(&rest, "--display-name")
	if err != nil {
		return routingUsageError(deps, err.Error(), "")
	}
	renameFrom, renameFromGiven, err := routingTakeOption(&rest, "--rename-from")
	if err != nil {
		return routingUsageError(deps, err.Error(), "")
	}
	if len(rest) != 0 {
		return routingUsageError(deps, routingUnexpectedArgs(rest), comboUsage)
	}
	targets, parseErr := parseComboTargets(targetsRaw)
	if parseErr != nil {
		return routingUsageError(deps, parseErr.Error(), comboUsage)
	}
	combo := comboBody(strategy, sticky, stickyGiven, targets, effort, effortGiven, alias, aliasGiven, nativeAlias, displayName, displayNameGiven)
	putBody := jsonwire.ObjectValue()
	putBody.Set("id", jsonwire.StringValue(id))
	putBody.Set("combo", combo)
	if renameFromGiven {
		putBody.Set("renameFrom", jsonwire.StringValue(renameFrom))
	}
	// imageInput is preserved only when the existing combo disabled image input;
	// a newly-created or auto-mode combo never echoes the default back. The GET
	// runs before the PUT exactly like combo.ts, and its failure is fatal.
	existingKey := id
	if renameFromGiven {
		existingKey = renameFrom
	}
	current, rawText, status, getErr := routingRoundTrip(deps, http.MethodGet, "/api/combos", nil)
	if getErr == nil {
		getErr = routingErrorFromRoundTrip(current, rawText, status)
	}
	if getErr != nil {
		return routingReportError(deps, getErr.(routingAPIError))
	}
	for _, row := range comboListRows(current) {
		if row.id == existingKey && row.imageInputDisabled {
			combo.Set("imageInput", jsonwire.StringValue("disabled"))
		}
	}
	encoded, encodeErr := putBody.Encode()
	if encodeErr != nil {
		fmt.Fprintln(deps.Stderr, "Error: "+encodeErr.Error())
		return ExitFailure
	}
	value, rawText, status, putErr := routingRoundTrip(deps, http.MethodPut, "/api/combos", encoded)
	if putErr == nil {
		putErr = routingErrorFromRoundTrip(value, rawText, status)
	}
	if putErr != nil {
		return routingReportError(deps, putErr.(routingAPIError))
	}
	routingPrintData(deps, value, rawText, jsonOutput, []string{"Saved combo " + id + "."})
	return ExitOK
}

// comboBody mirrors the combo object construction order in combo.ts so the PUT
// payload key order matches the TS client for the same argv.
func comboBody(strategy string, sticky int, stickyGiven bool, targets []comboTarget, effort string, effortGiven bool, alias string, aliasGiven bool, nativeAlias bool, displayName string, displayNameGiven bool) *jsonwire.Value {
	combo := jsonwire.ObjectValue()
	combo.Set("strategy", jsonwire.StringValue(strategy))
	stickyValue := 1
	if stickyGiven {
		stickyValue = sticky
	}
	combo.Set("stickyLimit", jsonwire.NumberFrom(float64(stickyValue)))
	targetsArray := jsonwire.EmptyArray()
	for _, target := range targets {
		element := jsonwire.ObjectValue()
		element.Set("provider", jsonwire.StringValue(target.provider))
		element.Set("model", jsonwire.StringValue(target.model))
		if target.hasWeight {
			element.Set("weight", jsonwire.NumberFrom(float64(target.weight)))
		}
		targetsArray.AppendArray(element)
	}
	combo.Set("targets", targetsArray)
	if effortGiven {
		if effort == "-" {
			combo.Set("defaultEffort", jsonwire.NullValue())
		} else {
			combo.Set("defaultEffort", jsonwire.StringValue(effort))
		}
	}
	if aliasGiven {
		if alias == "-" {
			combo.Set("alias", jsonwire.StringValue(""))
		} else {
			combo.Set("alias", jsonwire.StringValue(alias))
		}
	}
	if nativeAlias {
		combo.Set("nativeAlias", jsonwire.BoolValue(true))
	}
	if displayNameGiven {
		if displayName == "-" {
			combo.Set("displayName", jsonwire.StringValue(""))
		} else {
			combo.Set("displayName", jsonwire.StringValue(displayName))
		}
	}
	return combo
}

type comboTarget struct {
	provider  string
	model     string
	weight    int
	hasWeight bool
}

// parseComboTargets mirrors parseTargets in combo.ts. The error messages echo
// the ORIGINAL trimmed comma-segment, exactly like TypeScript.
func parseComboTargets(value string) ([]comboTarget, error) {
	var targets []comboTarget
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		colon := strings.LastIndex(part, ":")
		selector := part
		var weight int
		hasWeight := false
		if colon > strings.Index(part, "/") {
			if parsed, ok := parseIntLiteral(part[colon+1:]); ok {
				selector = part[:colon]
				weight = parsed
				hasWeight = true
			}
		}
		slash := strings.Index(selector, "/")
		if slash <= 0 || slash == len(selector)-1 {
			return nil, fmt.Errorf("invalid target \"%s\"; use provider/model[:weight]", part)
		}
		target := comboTarget{provider: selector[:slash], model: selector[slash+1:], weight: weight, hasWeight: hasWeight}
		if hasWeight && (weight < 1 || weight > 10_000) {
			return nil, fmt.Errorf("target weight must be 1-10000: %s", part)
		}
		targets = append(targets, target)
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("--targets requires at least one provider/model")
	}
	return targets, nil
}

// parseIntLiteral mirrors Number(raw) + Number.isInteger for the decimal
// targets the CLI documents: commas and underscores are not Number()-valid in
// JS and hex prefixes are not exercised by the documented surface.
func parseIntLiteral(raw string) (int, bool) {
	cleaned := strings.TrimSpace(raw)
	if cleaned == "" {
		return 0, true // Number("") === 0
	}
	value, err := strconv.ParseFloat(cleaned, 64)
	if err != nil || value != float64(int64(value)) {
		return 0, false
	}
	return int(value), true
}

func runComboRemove(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	id := ""
	if len(rest) > 0 {
		id = strings.TrimSpace(rest[0])
		rest = rest[1:]
	}
	jsonOutput := takeFlag(&rest, "--json")
	yes := takeFlag(&rest, "--yes")
	if id == "" {
		return routingUsageError(deps, "combo id is required", comboUsage)
	}
	if !yes {
		return routingUsageError(deps, "remove requires --yes", comboUsage)
	}
	if len(rest) != 0 {
		return routingUsageError(deps, routingUnexpectedArgs(rest), comboUsage)
	}
	path := "/api/combos?id=" + routingEncodePathComponent(id)
	value, rawText, status, err := routingRoundTrip(deps, http.MethodDelete, path, nil)
	if err == nil {
		err = routingErrorFromRoundTrip(value, rawText, status)
	}
	if err != nil {
		return routingReportError(deps, err.(routingAPIError))
	}
	routingPrintData(deps, value, rawText, jsonOutput, []string{"Removed combo " + id + "."})
	return ExitOK
}

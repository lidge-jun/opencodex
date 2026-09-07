package ocxcli

// ocx route — the routing-features gate (`ocx route <combo|policy>
// <subcommand>`) plus the `route policy` family. The gate mirrors the dispatch
// check in src/cli/dispatch.ts before it fans out to the shared combo and
// policy implementations; route policy itself is the port of
// src/cli/route-policy.ts against GET/POST /api/routing-profiles.

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

const routeUsageLine = "Usage: ocx route <combo|policy> <subcommand>"

const routePolicyUsage = `Usage:
  ocx route policy list [--json]
  ocx route policy show <id> [--json]
  ocx route policy dry-run <id> [--model-context <tokens>] [--tools]
      [--image] [--structured-output] [--json]
  ocx route policy evaluate <id> [--model-context <tokens>] [--tools]
      [--image] [--structured-output] [--json]`

// runRoute implements the `ocx route` gate. It assumes the caller validated
// ownership; argv carries only this command's own arguments.
func runRoute(args []string, deps Deps) int {
	if len(args) == 0 || (args[0] != "combo" && args[0] != "policy") {
		fmt.Fprintln(deps.Stderr, routeUsageLine)
		return routingExitUsage
	}
	if args[0] == "combo" {
		return runCombo(args[1:], deps)
	}
	return runRoutePolicy(args[1:], deps)
}

// runRoutePolicy mirrors handleRoutePolicyCommand. Subcommand names are
// compared literally, exactly like combo.
func runRoutePolicy(args []string, deps Deps) int {
	sub := ""
	rest := append([]string(nil), args...)
	if len(rest) > 0 {
		sub = rest[0]
		rest = rest[1:]
	}
	if sub == "" {
		return routingUsageError(deps, "route policy requires a subcommand (list, show, dry-run, evaluate)", routePolicyUsage)
	}
	switch sub {
	case "list":
		return runRoutePolicyList(rest, deps)
	case "show":
		return runRoutePolicyShow(rest, deps)
	case "dry-run", "evaluate":
		return runRoutePolicyDryRun(rest, deps)
	default:
		return routingUsageError(deps, "unknown route policy command: "+sub, routePolicyUsage)
	}
}

// profileRow is the projection of one /api/routing-profiles entry the
// renderer consumes.
type profileRow struct {
	id       string
	idOK     bool
	model    string
	modelOK  bool
	revision *jsonwire.Value
	raw      *jsonwire.Value
}

func profileRows(value *jsonwire.Value) []profileRow {
	var rows []profileRow
	profiles := value.Find("profiles")
	if profiles == nil || profiles.Kind() != jsonwire.Array {
		return rows
	}
	for _, element := range profiles.Elements() {
		if element == nil || element.Kind() != jsonwire.Object {
			continue
		}
		row := profileRow{raw: element}
		if id := element.Find("id"); id != nil {
			row.id, row.idOK = profileRowID(id)
		}
		if model := element.Find("model"); model != nil && model.Kind() == jsonwire.String {
			row.model, row.modelOK = model.String(), true
		}
		if revision := element.Find("revision"); revision != nil {
			row.revision = revision
		}
		rows = append(rows, row)
	}
	return rows
}

// profileRowID mirrors String(row.id) for the id field.
func profileRowID(value *jsonwire.Value) (string, bool) {
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

// profileRevisionText mirrors String(row.revision ?? "-"): null/absent become
// "-", numbers render through V8 number-to-string, strings verbatim.
func profileRevisionText(revision *jsonwire.Value) string {
	if revision == nil || revision.Kind() == jsonwire.Null {
		return "-"
	}
	if revision.Kind() == jsonwire.String {
		return revision.String()
	}
	if revision.Kind() == jsonwire.Number {
		if number, ok := parseJSONNumber(revision.NumberRaw()); ok {
			return jsonwire.FormatV8Number(number)
		}
	}
	return fmt.Sprint(revision.NumberRaw())
}

func runRoutePolicyList(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	jsonOutput := takeFlag(&rest, "--json")
	if len(rest) != 0 {
		return routingUsageError(deps, routingUnexpectedArgs(rest), routePolicyUsage)
	}
	value, rawText, status, err := routingRoundTrip(deps, http.MethodGet, "/api/routing-profiles", nil)
	if err == nil {
		err = routingErrorFromRoundTrip(value, rawText, status)
	}
	if err != nil {
		return routingReportError(deps, err.(routingAPIError))
	}
	rows := profileRows(value)
	var lines []string
	for _, row := range rows {
		display := row.model
		if !row.modelOK {
			display = "policy/" + row.id
		}
		lines = append(lines, fmt.Sprintf("%s  %s  rev:%s", row.id, display, profileRevisionText(row.revision)))
	}
	if len(lines) == 0 {
		lines = []string{"No routing profiles configured."}
	}
	routingPrintData(deps, value, rawText, jsonOutput, lines)
	return ExitOK
}

func runRoutePolicyShow(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	id := ""
	if len(rest) > 0 {
		id = rest[0]
		rest = rest[1:]
	}
	jsonOutput := takeFlag(&rest, "--json")
	if id == "" || strings.HasPrefix(id, "-") {
		return routingUsageError(deps, "profile id is required", routePolicyUsage)
	}
	if len(rest) != 0 {
		return routingUsageError(deps, routingUnexpectedArgs(rest), routePolicyUsage)
	}
	value, rawText, status, err := routingRoundTrip(deps, http.MethodGet, "/api/routing-profiles", nil)
	if err == nil {
		err = routingErrorFromRoundTrip(value, rawText, status)
	}
	if err != nil {
		return routingReportError(deps, err.(routingAPIError))
	}
	for _, row := range profileRows(value) {
		if row.id == id {
			routingPrintData(deps, row.raw, "", jsonOutput, nil)
			return ExitOK
		}
	}
	return routingUsageError(deps, "unknown routing profile: "+id, routePolicyUsage)
}

func runRoutePolicyDryRun(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	id := ""
	if len(rest) > 0 {
		id = rest[0]
		rest = rest[1:]
	}
	jsonOutput := takeFlag(&rest, "--json")
	if id == "" || strings.HasPrefix(id, "-") {
		return routingUsageError(deps, "profile id is required", routePolicyUsage)
	}
	modelContext, modelContextGiven, err := routingTakeIntegerOption(&rest, "--model-context", 1)
	if err != nil {
		return routingUsageError(deps, err.Error(), "")
	}
	tools := takeFlag(&rest, "--tools")
	image := takeFlag(&rest, "--image")
	structuredOutput := takeFlag(&rest, "--structured-output")
	if len(rest) != 0 {
		return routingUsageError(deps, routingUnexpectedArgs(rest), routePolicyUsage)
	}
	body := jsonwire.ObjectValue()
	body.Set("profile", jsonwire.StringValue(id))
	evidence := jsonwire.ObjectValue()
	if modelContextGiven {
		evidence.Set("contextWindow", jsonwire.NumberFrom(float64(modelContext)))
	}
	if tools {
		evidence.Set("toolsRequired", jsonwire.BoolValue(true))
	}
	if image {
		evidence.Set("imageInputRequired", jsonwire.BoolValue(true))
	}
	if structuredOutput {
		evidence.Set("structuredOutputRequired", jsonwire.BoolValue(true))
	}
	body.Set("evidence", evidence)
	encoded, encodeErr := body.Encode()
	if encodeErr != nil {
		fmt.Fprintln(deps.Stderr, "Error: "+encodeErr.Error())
		return ExitFailure
	}
	value, rawText, status, roundErr := routingRoundTrip(deps, http.MethodPost, "/api/routing-profiles/dry-run", encoded)
	if roundErr == nil {
		roundErr = routingErrorFromRoundTrip(value, rawText, status)
	}
	if roundErr != nil {
		return routingReportError(deps, roundErr.(routingAPIError))
	}
	// The policy commands always print the decision as JSON, --json or not.
	routingPrintData(deps, value, rawText, jsonOutput, nil)
	return ExitOK
}

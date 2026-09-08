package ocxcli

// ocx lab — read-only Compatibility Lab projection inspection plus the
// explicit operator surfaces (src/cli/lab.ts). This file ports the CLI shape
// and the local SQLite status read; the remaining verbs are management/operator
// surfaces (public evidence crypto, the automation scheduler, manual runs) that
// keep their TypeScript owner through a per-subcommand delegation map, the same
// incremental idiom models/observe use during the takeover.

import (
	"database/sql"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"

	_ "modernc.org/sqlite"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

const labUsage = `Usage:
  ocx lab status [--json]
  ocx lab production-signals --subject <id> [--limit <n>] [--json]
  ocx lab verdicts [--subject <id>] [--layer <layer>] [--suite <id>] [--verdict <v>] [--from <ms>] [--to <ms>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab subjects [--kind <kind>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab subject <subjectId> [--json]
  ocx lab observations [--subject <id>] [--layer <layer>] [--suite <id>] [--scenario <id>] [--outcome <o>] [--execution-mode <m>] [--from <ms>] [--to <ms>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab events [--event-kind <k>] [--subject <id>] [--from <ms>] [--to <ms>] [--excluded <true|false>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab event <eventId> [--json]
  ocx lab artifacts [--status <s>] [--artifact-class <c>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab artifact <digest> [--json]
  ocx lab catalog [--layer <layer>] [--suite <id>] [--json]
  ocx lab public preview --event <eventId> [--event <eventId> ...] [--json]
  ocx lab public export --event <eventId> [--event <eventId> ...] [--json]
  ocx lab public verify --file <bundle.json> [--json]
  ocx lab public import --file <bundle.json> [--json]
  ocx lab public community [--json]
  ocx lab automation status [--json]
  ocx lab automation enable [--protocol] [--live] [--json]
  ocx lab automation disable [--json]
  ocx lab automation runs [--limit <n>] [--cursor <c>] [--json]
  ocx lab run --layer <layer> --scenario <id> [--provider <name>] [--model <id>] [--json]`

// labRuntimeSubcommands mirrors the model/config runtime maps: subcommands that
// still route through the TypeScript owner during the takeover. Their state is
// local (projection rows, public crypto bundles, automation policy/scheduler,
// manual-run planner) and their client keeps TS request/response semantics.
var labRuntimeSubcommands = map[string]Ownership{
	"production-signals": TypeScriptOwned,
	"verdicts":           TypeScriptOwned,
	"subjects":           TypeScriptOwned,
	"subject":            TypeScriptOwned,
	"observations":       TypeScriptOwned,
	"events":             TypeScriptOwned,
	"event":              TypeScriptOwned,
	"artifacts":          TypeScriptOwned,
	"artifact":           TypeScriptOwned,
	"catalog":            TypeScriptOwned,
	"public":             TypeScriptOwned,
	"automation":         TypeScriptOwned,
	"run":                TypeScriptOwned,
}

// runLab mirrors handleLabCommand for the Go-owned slice: `--json` is consumed
// before the subcommand shift (so `lab --json` is a JSON status), status reads
// the local SQLite projection, and unknown verbs print the TypeScript usage
// error. The verbs in labRuntimeSubcommands never reach this switch — OwnershipFor
// delegates them to their TypeScript owner before dispatch.
func runLab(args []string, deps Deps) int {
	argv := append([]string(nil), args...)
	wantsJSON := takeFlag(&argv, "--json")
	sub := "status"
	if len(argv) > 0 {
		sub = argv[0]
		argv = argv[1:]
	}
	return runManagementAction(deps, func() error {
		switch sub {
		case "status":
			if err := managementRejectArgs(argv, labUsage, false); err != nil {
				return err
			}
			dto, lines := labStatusQuery()
			familyPrintManagementData(deps, dto, wantsJSON, lines)
			return nil
		default:
			return usageErrorWith(fmt.Sprintf("unknown lab subcommand: %s", sub), labUsage)
		}
	})
}

// labStatusQuery mirrors queryLabStatus against <configDir>/lab/compatibility.sqlite.
// Every failure the status verb can hit resolves into a projection-availability
// DTO (never a thrown error); only a genuine schema/spec mismatch is reported as
// incompatible. Returned lines mirror statusSummary in src/cli/lab.ts.
func labStatusQuery() (*jsonwire.Value, []string) {
	unavailable := func() (*jsonwire.Value, []string) {
		dto := jsonwire.ObjectValue()
		dto.Set("projectionAvailable", jsonwire.BoolValue(false))
		return dto, []string{"Lab projection: unavailable"}
	}
	incompatible := func() (*jsonwire.Value, []string) {
		dto := jsonwire.ObjectValue()
		dto.Set("projectionAvailable", jsonwire.BoolValue(false))
		dto.Set("projectionIncompatible", jsonwire.BoolValue(true))
		return dto, []string{"Lab projection: incompatible"}
	}
	configDir, err := config.Dir()
	if err != nil {
		return unavailable()
	}
	sqlitePath := filepath.Join(configDir, "lab", "compatibility.sqlite")
	if _, err := os.Stat(sqlitePath); err != nil {
		return unavailable()
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(sqlitePath)+"?mode=ro")
	if err != nil {
		return unavailable()
	}
	defer db.Close()
	meta, err := db.Query("SELECT key, value FROM schema_meta")
	if err != nil {
		return unavailable()
	}
	metaMap := map[string]string{}
	for meta.Next() {
		var key, value string
		if err := meta.Scan(&key, &value); err != nil {
			meta.Close()
			return unavailable()
		}
		metaMap[key] = value
	}
	meta.Close()
	schemaRaw, schemaOK := metaMap["schema_version"]
	specRaw, specOK := metaMap["projection_spec_version"]
	builtRaw, builtOK := metaMap["built_at_ms"]
	if !schemaOK || !specOK || !builtOK {
		return unavailable()
	}
	var schemaVersion float64
	if parsed, ok := parseJSNumber(schemaRaw); ok {
		schemaVersion = parsed
	} else {
		return incompatible()
	}
	var builtAtMs float64
	if parsed, ok := parseJSNumber(builtRaw); ok {
		builtAtMs = parsed
	} else {
		return incompatible()
	}
	if schemaVersion != math.Trunc(schemaVersion) || schemaVersion != labSQLiteSchemaVersion ||
		specRaw != labProjectionSpecVersion || math.IsNaN(builtAtMs) || math.IsInf(builtAtMs, 0) {
		return incompatible()
	}
	counts := []struct {
		table string
		key   string
	}{
		{"events", "eventCount"}, {"subjects", "subjectCount"}, {"observations", "observationCount"},
		{"claims", "claimCount"}, {"verdicts", "verdictCount"}, {"artifacts", "artifactCount"},
		{"corruption", "corruptionCount"},
	}
	countValues := map[string]float64{}
	for _, table := range counts {
		row := db.QueryRow("SELECT COUNT(*) AS c FROM " + table.table)
		var c int64
		if err := row.Scan(&c); err != nil {
			return unavailable()
		}
		countValues[table.key] = float64(c)
	}
	dto := jsonwire.ObjectValue()
	dto.Set("projectionAvailable", jsonwire.BoolValue(true))
	dto.Set("sqliteSchemaVersion", jsonwire.NumberFrom(schemaVersion))
	dto.Set("projectionSpecVersion", jsonwire.StringValue(specRaw))
	dto.Set("builtAtMs", jsonwire.NumberFrom(builtAtMs))
	for _, table := range counts {
		dto.Set(table.key, jsonwire.NumberFrom(countValues[table.key]))
	}
	lines := []string{
		"Lab projection: available",
		"SQLite schema: " + formatJSNumber(schemaVersion),
		"Projection spec: " + specRaw,
		"Built at: " + formatJSNumber(builtAtMs),
		"Events: " + formatJSNumber(countValues["eventCount"]) + " | Subjects: " + formatJSNumber(countValues["subjectCount"]) + " | Observations: " + formatJSNumber(countValues["observationCount"]),
		"Claims: " + formatJSNumber(countValues["claimCount"]) + " | Verdicts: " + formatJSNumber(countValues["verdictCount"]) + " | Artifacts: " + formatJSNumber(countValues["artifactCount"]),
		"Corruption rows: " + formatJSNumber(countValues["corruptionCount"]),
	}
	return dto, lines
}

const (
	labSQLiteSchemaVersion   = 3
	labProjectionSpecVersion = "cl-02.v1"
)

// formatJSNumber prints a number the way String(n) does in V8 for the integral
// values the projection carries (schema version, epoch ms, row counts): no
// exponent, no trailing fraction.
func formatJSNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// labHelp mirrors the TypeScript registry entry for `ocx help lab`.
const labHelp = "Usage: ocx lab <status|verdicts|subjects|subject|observations|events|event|artifacts|artifact|catalog> [options] [--json]\n" +
	"\n" +
	"Read-only Compatibility Lab projection inspection (local SQLite; no daemon).\n" +
	"\n" +
	"status                Projection availability, schema versions, and row counts.\n" +
	"verdicts              Paginated derived compatibility verdicts with filters.\n" +
	"subjects              List subjects; subject <id> returns one typed subject.\n" +
	"observations          Paginated observation rows from the projection.\n" +
	"events                Event history; event <id> returns one safe typed event.\n" +
	"artifacts             Artifact metadata only (no content download).\n" +
	"catalog               Packaged protocol/live scenario catalog metadata.\n" +
	"Reads never rebuild the projection, trigger probes, or require the proxy.\n"

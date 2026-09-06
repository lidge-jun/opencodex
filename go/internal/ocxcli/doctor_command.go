package ocxcli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// DoctorTODOSection records a TypeScript doctor section for which Go has no
// equivalent probe yet. Keeping this list in the assembler makes the remaining
// ownership work explicit: callers get a complete ordered report without
// pretending that an unavailable probe has a useful result.
type DoctorTODOSection struct {
	Heading string
	Reason  string
}

// DoctorCommandResult is the native assembly seam. Doctor remains
// TypeScript-owned; this result is deliberately not wired into Run yet.
type DoctorCommandResult struct {
	Text   string
	Stderr string
	Exit   int
	TODOs  []DoctorTODOSection
}

// DoctorCommandDeps supplies the already-portable doctor probes. Each probe is
// injectable so the complete assembly can be compared to TypeScript without a
// live service, OAuth store, or network request.
type DoctorCommandDeps struct {
	Paths            func() []DoctorPathRow
	Mounts           func() string
	ResponseTemps    func(bool) DoctorResponseTempResult
	Env              func() map[string]string
	Config           func() StatusConfigDiagnostic
	OrderedProviders func() *config.OrderedValue
	CodexConfigText  func() string
	ServiceToken     func() bool
	Shim             func() DoctorShimDiagnostic
	RunningProxyEnv  func() DoctorRunningProxyEnv
	OrcaHome         func() DoctorOrcaHome
	RestartSafety    func() DoctorRestartSafety
	RuntimeSelection func() DoctorRuntimeSelection
	WHAM             func() DoctorWhamResult
	AgentRoles       func() []string
	WSL              func() DoctorWslDiagnostic
	BunVersion       func() string
	Memory           func() DoctorServiceMemoryReport
	History          func() DoctorHistoryPending
	HistoryNamespace func() DoctorHistoryState
	ProjectConfigs   func() []DoctorProjectConfigWarning
	ProxyDownHint    func() string
	Coordinator      func() DoctorCoordinatorDiagnostic
	OAuth            func() []DoctorOAuthCheck
	OAuthLive        func() (DoctorOAuthHealthSource, []DoctorOAuthAccount)
	Catalog          func() DoctorCatalogState
	Hints            func(DoctorHintsInput) []string
}

func defaultDoctorCommandDeps(deps DoctorCommandDeps) DoctorCommandDeps {
	if deps.Paths == nil {
		deps.Paths = CollectDoctorPaths
	}
	if deps.Mounts == nil {
		deps.Mounts = ReadDoctorMounts
	}
	if deps.ResponseTemps == nil {
		deps.ResponseTemps = func(reclaim bool) DoctorResponseTempResult {
			if reclaim {
				return ReclaimDoctorResponseTemps()
			}
			return InspectDoctorResponseTemps()
		}
	}
	if deps.Env == nil {
		deps.Env = doctorProcessEnv
	}
	if deps.Config == nil {
		deps.Config = ReadStatusConfigDiagnostics
	}
	if deps.OrderedProviders == nil {
		deps.OrderedProviders = func() *config.OrderedValue {
			dir, err := config.Dir()
			if err != nil {
				return nil
			}
			ordered, err := config.LoadOrderedFromDir(dir)
			if err != nil {
				return nil
			}
			return ordered.Find("providers")
		}
	}
	if deps.CodexConfigText == nil {
		deps.CodexConfigText = func() string {
			raw, _ := os.ReadFile(filepath.Join(doctorCodexHome(), "config.toml"))
			return string(raw)
		}
	}
	if deps.ServiceToken == nil {
		deps.ServiceToken = func() bool {
			dir, err := config.Dir()
			if err != nil {
				return false
			}
			raw, err := os.ReadFile(filepath.Join(dir, "service-api-token"))
			return err == nil && strings.TrimSpace(string(raw)) != ""
		}
	}
	if deps.Shim == nil {
		deps.Shim = func() DoctorShimDiagnostic { return DoctorShimDiagnostic{} }
	}
	if deps.RunningProxyEnv == nil {
		deps.RunningProxyEnv = func() DoctorRunningProxyEnv { return CollectDoctorRunningProxyEnv(int(readStatusPIDFile()), nil) }
	}
	if deps.OrcaHome == nil {
		deps.OrcaHome = CollectDoctorOrcaHome
	}
	if deps.RestartSafety == nil {
		deps.RestartSafety = func() DoctorRestartSafety {
			return CollectDoctorRestartSafety(CollectStatusExtraDomains(deps.Config(), StatusExtraDeps{}).Startup)
		}
	}
	if deps.RuntimeSelection == nil {
		deps.RuntimeSelection = CollectDoctorRuntimeSelection
	}
	if deps.WHAM == nil {
		// The token-aware implementation lands with the native-profile collector.
		// Until then this remains a real reachability probe without reading or
		// serializing credentials.
		deps.WHAM = func() DoctorWhamResult {
			return ProbeDoctorWHAM(context.Background(), &http.Client{}, "", "")
		}
	}
	if deps.AgentRoles == nil {
		deps.AgentRoles = func() []string { return CollectDoctorAgentRoles(doctorCodexHome()) }
	}
	if deps.WSL == nil {
		deps.WSL = CollectCurrentDoctorWslDualInstall
	}
	if deps.BunVersion == nil {
		deps.BunVersion = doctorBunVersion
	}
	if deps.Memory == nil {
		deps.Memory = func() DoctorServiceMemoryReport {
			runtime, err := ReadRuntime()
			if err != nil {
				return DoctorServiceMemoryReport{Status: "not_running"}
			}
			return FetchDoctorServiceMemory(context.Background(), DoctorManagementReader{Runtime: runtime})
		}
	}
	if deps.History == nil {
		deps.History = CollectCurrentDoctorHistoryPending
	}
	if deps.HistoryNamespace == nil {
		deps.HistoryNamespace = CollectDoctorHistoryNamespace
	}
	if deps.ProjectConfigs == nil {
		deps.ProjectConfigs = func() []DoctorProjectConfigWarning {
			return CollectDoctorProjectConfigsWithGlobal(doctorCodexHome(), "")
		}
	}
	if deps.ProxyDownHint == nil {
		deps.ProxyDownHint = func() string { return "" }
	}
	if deps.Coordinator == nil {
		deps.Coordinator = CollectDoctorCoordinator
	}
	if deps.OAuth == nil {
		deps.OAuth = CollectDoctorOAuthReliabilityDefault
	}
	if deps.OAuthLive == nil {
		deps.OAuthLive = func() (DoctorOAuthHealthSource, []DoctorOAuthAccount) { return DoctorOAuthUnavailable, nil }
	}
	if deps.Catalog == nil {
		deps.Catalog = CollectDoctorCatalogStateDefault
	}
	if deps.Hints == nil {
		deps.Hints = CollectDoctorHints
	}
	return deps
}

var doctorCommandTODOs = []DoctorTODOSection{}

func doctorTODO(section DoctorTODOSection) []string {
	return []string{section.Heading, "  TODO: " + section.Reason}
}

const doctorJSONUsage = "ocx doctor does not support --json yet. Run `ocx doctor` for the human report, or use `ocx status --json` and `ocx ready --json` for machine-readable health.\n"
const doctorJSONExit = 2

// doctorJSONOption mirrors isJsonOption in src/cli/runtime-api.ts. Doctor is
// prose-only until its remaining diagnostics have a structured contract, so a
// JSON-looking flag must fail instead of silently printing prose to stdout.
func doctorJSONOption(arg string) bool {
	normalized := strings.Map(func(r rune) rune {
		switch r {
		case '‐', '‑', '‒', '–', '—', '−':
			return '-'
		default:
			return r
		}
	}, arg)
	body := strings.TrimLeft(normalized, "-")
	return body == "json" || strings.HasPrefix(body, "json=")
}

// AssembleDoctorCommand preserves runDoctor's report ordering. It implements
// only the probes that have native evidence. The explicit TODO sections are a
// convergence ledger, not substitute diagnostics.
func AssembleDoctorCommand(args []string, deps DoctorCommandDeps) DoctorCommandResult {
	deps = defaultDoctorCommandDeps(deps)
	for _, arg := range args {
		if doctorJSONOption(arg) {
			return DoctorCommandResult{Stderr: doctorJSONUsage, Exit: doctorJSONExit, TODOs: append([]DoctorTODOSection(nil), doctorCommandTODOs...)}
		}
	}
	// The two action modes are intentionally not emulated: they write runtime or
	// Codex state and need their TypeScript transaction ports before ownership can
	// move. Reporting failure is safer than an apparent successful no-op.
	for _, arg := range args {
		if arg == "--fix-codex-runtime" || arg == "--recover-zero-byte-coordinator" {
			return DoctorCommandResult{Text: "opencodex doctor\n\nTODO: " + arg + " requires its TypeScript diagnostic and recovery transaction.\n", Exit: ExitFailure, TODOs: append([]DoctorTODOSection(nil), doctorCommandTODOs...)}
		}
	}
	reclaim := false
	var reclaimWarnings []string
	for _, arg := range args {
		if arg == "--reclaim-response-temps" {
			reclaim = true
		}
		if arg != "--reclaim-response-temps" && strings.HasPrefix(arg, "--reclaim") {
			reclaimWarnings = append(reclaimWarnings, "  !!  Unrecognized flag "+arg+"; did you mean --reclaim-response-temps? Reporting only.")
		}
	}
	env := deps.Env()
	diagnostic := deps.Config()
	sections := [][]string{
		FormatDoctorPaths(deps.Paths(), deps.Mounts()),
		append([]string{"Response-state temp files"}, append(reclaimWarnings, FormatDoctorResponseTemps(deps.ResponseTemps(reclaim), reclaim)...)...),
		FormatDoctorOrcaHome(deps.OrcaHome()),
		FormatDoctorRestartSafety(deps.RestartSafety()),
		FormatDoctorRuntimeSelection(deps.RuntimeSelection()),
		FormatDoctorCurrentProxyEnv(CollectDoctorProxyEnv(env)),
		FormatDoctorConfiguredProxy(CollectDoctorConfiguredProxy(diagnostic, env)),
		FormatDoctorProviderAPIKeys(CollectDoctorProviderAPIKeysOrdered(deps.OrderedProviders(), env)),
		FormatDoctorCodexEnvKeyReadiness(CollectDoctorCodexEnvKeyReadiness(deps.CodexConfigText(), env, deps.Shim(), deps.ServiceToken())),
		FormatDoctorRunningProxyEnv(deps.RunningProxyEnv()),
		formatDoctorMemorySection(deps.Memory(), deps.BunVersion()),
		FormatDoctorWHAM(deps.WHAM()),
		FormatDoctorHistoryState(deps.HistoryNamespace()), append([]string{"Codex native-write coordinator"}, FormatDoctorCoordinator(deps.Coordinator())...), FormatDoctorHistoryPending(deps.History()), FormatDoctorProjectConfigs(deps.ProjectConfigs()),
		FormatDoctorAgentRoles(deps.AgentRoles()),
		FormatDoctorWslDualInstall(deps.WSL()),
		append(formatDoctorOAuthSection(deps.OAuth(), deps.OAuthLive), FormatDoctorCatalogState(deps.Catalog())...),
	}
	providerRows := CollectDoctorProviderAPIKeysOrdered(deps.OrderedProviders(), env)
	providerHints := make([]string, 0, len(providerRows))
	for _, row := range providerRows {
		providerHints = append(providerHints, row.Detail+". Set "+row.EnvName+" in the shell that starts the proxy, or store a literal key in config (value hidden here).")
	}
	readiness := CollectDoctorCodexEnvKeyReadiness(deps.CodexConfigText(), env, deps.Shim(), deps.ServiceToken())
	startup := CollectStatusExtraDomains(diagnostic, StatusExtraDeps{}).Startup
	recommended, restore := "", startup.Commands.RestoreNative
	if startup.RecommendedCommand != nil {
		recommended = *startup.RecommendedCommand
	}
	input := DoctorHintsInput{ProxyDown: deps.ProxyDownHint(), ProviderKeyDetails: providerHints, RebootSafe: deps.RestartSafety().RebootSafe, RecommendedCommand: recommended, RestoreNativeCommand: restore, ProbeOK: deps.WHAM().OK, ProbeClassification: deps.WHAM().Classification, PendingFailed: deps.History().Failed, PendingFailureReason: deps.History().FailureReason, BackupEntries: deps.History().BackupEntries}
	if readiness != nil {
		input.CodexEnvKeyDetail, input.CodexEnvKeyAction = readiness.Detail, readiness.Action
	}
	hints := deps.Hints(input)
	if len(hints) > 0 {
		last := []string{"Hints"}
		for _, hint := range hints {
			last = append(last, "  - "+hint)
		}
		sections = append(sections, last)
	}
	parts := make([]string, 0, len(sections))
	for _, section := range sections {
		if len(section) == 0 {
			continue
		}
		parts = append(parts, strings.Join(section, "\n"))
	}
	exit := ExitOK
	for _, row := range deps.OAuth() {
		if row.Level == "FAIL" {
			exit = ExitFailure
		}
	}
	return DoctorCommandResult{Text: "opencodex doctor\n\n" + strings.Join(parts, "\n\n") + "\n", Exit: exit, TODOs: append([]DoctorTODOSection(nil), doctorCommandTODOs...)}
}

func formatDoctorOAuthSection(checks []DoctorOAuthCheck, live func() (DoctorOAuthHealthSource, []DoctorOAuthAccount)) []string {
	lines := FormatDoctorOAuthChecks(checks)
	source, accounts := live()
	liveLines := FormatDoctorOAuthLive(source, accounts)
	return append(lines, liveLines[1:]...)
}

// RunDoctorCommand is the future command dispatch target. It exists now so
// argument and exit behavior are testable while cli.go retains TypeScript
// ownership.
func RunDoctorCommand(args []string, stdout, stderr io.Writer, deps DoctorCommandDeps) int {
	result := AssembleDoctorCommand(args, deps)
	if result.Stderr != "" {
		if _, err := fmt.Fprint(stderr, result.Stderr); err != nil {
			return ExitFailure
		}
	}
	if _, err := fmt.Fprint(stdout, result.Text); err != nil {
		return ExitFailure
	}
	return result.Exit
}

package ocxcli

import (
	"fmt"
	"io"
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
	ProxyDownHint    func() string
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
	if deps.ProxyDownHint == nil {
		deps.ProxyDownHint = func() string { return "" }
	}
	return deps
}

var doctorCommandTODOs = []DoctorTODOSection{
	{"Codex app home targeting", "Orca/Codex home diagnostic has not been ported."},
	{"Codex restart safety", "startup/restart safety diagnostic has not been ported."},
	{"Codex runtime selection", "runtime selection and live version diagnostics have not been ported."},
	{"Memory / runtime", "live service memory/runtime diagnostic has not been ported."},
	{"WHAM reachability", "WHAM network reachability probe has not been ported."},
	{"Codex history metadata restore", "history metadata restore diagnostic has not been ported."},
	{"Codex native-write coordinator", "native-write coordinator diagnostic has not been ported."},
	{"Project Codex configs", "project config bypass diagnostic has not been ported."},
	{"Codex agent role files", "agent-role model_fallback diagnostic has not been ported."},
	{"WSL Codex installs", "WSL dual-install diagnostic has not been ported."},
	{"OAuth reliability", "OAuth health and catalog freshness diagnostics have not been ported."},
	{"Hints", "remaining hints need their source diagnostics; proxy-down hint is assembled when supplied."},
}

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
		doctorTODO(doctorCommandTODOs[0]), doctorTODO(doctorCommandTODOs[1]), doctorTODO(doctorCommandTODOs[2]),
		FormatDoctorCurrentProxyEnv(CollectDoctorProxyEnv(env)),
		FormatDoctorConfiguredProxy(CollectDoctorConfiguredProxy(diagnostic, env)),
		FormatDoctorProviderAPIKeys(CollectDoctorProviderAPIKeysOrdered(deps.OrderedProviders(), env)),
		FormatDoctorCodexEnvKeyReadiness(CollectDoctorCodexEnvKeyReadiness(deps.CodexConfigText(), env, deps.Shim(), deps.ServiceToken())),
		FormatDoctorRunningProxyEnv(deps.RunningProxyEnv()),
		doctorTODO(doctorCommandTODOs[3]), doctorTODO(doctorCommandTODOs[4]), doctorTODO(doctorCommandTODOs[5]), doctorTODO(doctorCommandTODOs[6]), doctorTODO(doctorCommandTODOs[7]), doctorTODO(doctorCommandTODOs[8]), doctorTODO(doctorCommandTODOs[9]), doctorTODO(doctorCommandTODOs[10]),
	}
	last := doctorTODO(doctorCommandTODOs[11])
	if hint := deps.ProxyDownHint(); hint != "" {
		last = append(last, "  - "+hint)
	}
	sections = append(sections, last)
	parts := make([]string, 0, len(sections))
	for _, section := range sections {
		parts = append(parts, strings.Join(section, "\n"))
	}
	return DoctorCommandResult{Text: "opencodex doctor\n\n" + strings.Join(parts, "\n\n") + "\n", Exit: ExitOK, TODOs: append([]DoctorTODOSection(nil), doctorCommandTODOs...)}
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

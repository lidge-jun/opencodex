package ocxcli

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// ocx export — print a client config (OpenCode, Pi, OMP, Hermes, OpenClaw,
// Kimi Code, Gajae Code, DeepSeek Harness, MiniMax Code, ZCode, Prime Agent,
// Aside) wired to the running proxy. This file ports src/cli/export-command.ts
// and the destination/path helpers of src/clients/config-export.ts.
//
// --json stdout is exactly the client config as JSON (every client — the flag
// is about machine readability, not the client's native format); the native
// format leads the human path. The command never writes the user's real config
// path: --out is an explicit target and refuses to clobber without --force.

const exportUsageUsage = `Usage:
  ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime|aside> [--json] [--out <path>] [--force]`

var exportClientIDs = []string{"opencode", "pi", "omp", "hermes", "openclaw", "kimi", "gajae", "dsh", "mcode", "zcode", "prime", "aside"}

func exportIsClientID(value string) bool {
	for _, id := range exportClientIDs {
		if id == value {
			return true
		}
	}
	return false
}

type exportClientSpec struct {
	id         string
	filename   string
	apiKeyEnv  string
	exportHint string
	format     exportFormat
	build      func(ctx exportContext) *jsonwire.Value
}

func exportSpecs() map[string]exportClientSpec {
	specs := map[string]exportClientSpec{}
	add := func(spec exportClientSpec) { specs[spec.id] = spec }
	add(exportClientSpec{id: "opencode", filename: "opencode.json", apiKeyEnv: exportOpenCodeAPIKeyEnv,
		exportHint: "export " + exportOpenCodeAPIKeyEnv + "=<your key>", format: exportFormatJSON, build: buildExportOpenCodeClientConfig})
	add(exportClientSpec{id: "pi", filename: "pi-models.json", exportHint: "Pi reads a non-secret placeholder from models.json; loopback needs no key.", format: exportFormatJSON, build: buildExportPiClientConfig})
	add(exportClientSpec{id: "omp", filename: "omp-models.yaml", exportHint: "OMP reads a non-secret placeholder from models.yml; loopback needs no key.", format: exportFormatYAML, build: buildExportOmpClientConfig})
	add(exportClientSpec{id: "hermes", filename: "hermes-config.yaml", apiKeyEnv: exportHermesAPIKeyEnv,
		exportHint: "export " + exportHermesAPIKeyEnv + "=<your key>", format: exportFormatYAML, build: buildExportHermesClientConfig})
	add(exportClientSpec{id: "openclaw", filename: "openclaw.json5", apiKeyEnv: exportOpenClawAPIKeyEnv,
		exportHint: "export " + exportOpenClawAPIKeyEnv + "=<your key>", format: exportFormatJSON5, build: buildExportOpenclawClientConfig})
	add(exportClientSpec{id: "kimi", filename: "kimi-config.toml", exportHint: "Kimi Code reads credentials from its config file; loopback needs no key.", format: exportFormatTOML, build: buildExportKimiClientConfig})
	add(exportClientSpec{id: "gajae", filename: "gajae-models.yaml", apiKeyEnv: exportGajaeAPIKeyEnv,
		exportHint: "export " + exportGajaeAPIKeyEnv + "=<your key>", format: exportFormatYAML, build: buildExportGajaeClientConfig})
	add(exportClientSpec{id: "dsh", filename: "settings.yaml", exportHint: "DSH uses a non-secret loopback bearer placeholder in settings.yaml; loopback needs no key.", format: exportFormatYAML, build: buildExportDshClientConfig})
	add(exportClientSpec{id: "mcode", filename: "mcode-config.yaml", exportHint: "MiniMax Code reads a non-secret placeholder from config.yaml; loopback needs no key.", format: exportFormatYAML, build: buildExportMcodeClientConfig})
	add(exportClientSpec{id: "zcode", filename: "config.json", exportHint: "ZCode reads a non-secret placeholder from v2/config.json; loopback needs no key.", format: exportFormatJSON, build: buildExportZcodeClientConfig})
	add(exportClientSpec{id: "prime", filename: "prime-models.json", exportHint: "Prime Agent reads a non-secret placeholder from models.json; loopback needs no key.", format: exportFormatJSON, build: buildExportPiClientConfig})
	add(exportClientSpec{id: "aside", filename: "aside-models.json", exportHint: "Aside reads a non-secret placeholder from models.json; loopback needs no key.", format: exportFormatJSON, build: buildExportPiClientConfig})
	return specs
}

// ─────────────────────────────────────────────────────────────────────────────
// Destination path resolution (port of the config-export.ts path helpers).

// exportHome mirrors homedir() through the process environment.
func exportHome() string {
	if home := os.Getenv("HOME"); home != "" {
		return home
	}
	if home, err := os.UserHomeDir(); err == nil {
		return home
	}
	return "."
}

func exportJoinPath(parts ...string) string { return filepath.Join(parts...) }

func exportFileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func exportEnvValue(env map[string]string, key string) string { return env[key] }

// exportAbsoluteClientPath mirrors absoluteClientPath: expand ~ against home,
// refuse anything still relative.
func exportAbsoluteClientPath(raw, home, variable string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "~" {
		return home, nil
	}
	if strings.HasPrefix(trimmed, "~/") || strings.HasPrefix(trimmed, `~\`) {
		return exportJoinPath(home, trimmed[2:]), nil
	}
	if !filepath.IsAbs(trimmed) {
		return "", errors.New(variable + " must be an absolute path or start with ~; \"" + trimmed + "\" depends on the working directory, so opencodex and the client would disagree about which file it names.")
	}
	return trimmed, nil
}

func exportOmpProfileName(env map[string]string) (string, error) {
	raw, hasOMP := env["OMP_PROFILE"]
	if !hasOMP {
		raw = env["PI_PROFILE"]
	}
	profile := strings.TrimSpace(raw)
	if profile == "" || profile == "default" {
		return "", nil
	}
	valid := len(profile) >= 1 && len(profile) <= 64 && isASCIILowerAlnumDotDashUnderscore(profile)
	reserved := regexpExportWindowsReserved(profile)
	if profile == "." || profile == ".." || strings.HasSuffix(profile, ".") || !valid || reserved {
		return "", errors.New("Invalid OMP profile \"" + raw + "\"")
	}
	return profile, nil
}

func isASCIILowerAlnumDotDashUnderscore(value string) bool {
	for index, character := range value {
		if index == 0 {
			if !(character >= 'a' && character <= 'z' || character >= '0' && character <= '9') {
				return false
			}
			continue
		}
		ok := character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' ||
			character == '.' || character == '_' || character == '-'
		if !ok {
			return false
		}
	}
	return true
}

var exportWindowsReserved = []string{"CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"}

func regexpExportWindowsReserved(value string) bool {
	upper := strings.ToUpper(value)
	for _, reserved := range exportWindowsReserved {
		if upper == reserved || strings.HasPrefix(upper, reserved+".") {
			return true
		}
	}
	return false
}

func exportPiAgentDir(env map[string]string, home string) (string, error) {
	if override := strings.TrimSpace(env["PI_CODING_AGENT_DIR"]); override != "" {
		return exportAbsoluteClientPath(override, home, "PI_CODING_AGENT_DIR")
	}
	return exportJoinPath(home, ".pi", "agent"), nil
}

func exportPiConfigPath(env map[string]string, home string) (string, error) {
	dir, err := exportPiAgentDir(env, home)
	if err != nil {
		return "", err
	}
	return exportJoinPath(dir, "models.json"), nil
}

func exportOmpAgentDir(env map[string]string, home string) (string, error) {
	profile, err := exportOmpProfileName(env)
	if err != nil {
		return "", err
	}
	if profile == "" {
		if override := strings.TrimSpace(env["PI_CODING_AGENT_DIR"]); override != "" {
			return exportAbsoluteClientPath(override, home, "PI_CODING_AGENT_DIR")
		}
	}
	rootName := env["PI_CONFIG_DIR"]
	if rootName == "" {
		rootName = ".omp"
	}
	root := exportJoinPath(home, rootName)
	if profile != "" {
		return exportJoinPath(root, "profiles", profile, "agent"), nil
	}
	return exportJoinPath(root, "agent"), nil
}

func exportOmpModelsConfigPath(env map[string]string, home string) (string, error) {
	agentDir, err := exportOmpAgentDir(env, home)
	if err != nil {
		return "", err
	}
	yamlFallback := exportJoinPath(agentDir, "models.yaml")
	canonical := exportJoinPath(agentDir, "models.yml")
	if !exportFileExists(canonical) && exportFileExists(yamlFallback) {
		return yamlFallback, nil
	}
	return canonical, nil
}

func exportOpenCodeGlobalConfigPath(env map[string]string, home string) string {
	xdg := env["XDG_CONFIG_HOME"]
	if xdg == "" {
		xdg = exportJoinPath(home, ".config")
	}
	return exportJoinPath(xdg, "opencode", "opencode.json")
}

func exportHermesHomeDir(env map[string]string, home string) string {
	if override := strings.TrimSpace(env["HERMES_HOME"]); override != "" {
		return override
	}
	if os.PathSeparator == '\\' {
		local := strings.TrimSpace(env["LOCALAPPDATA"])
		if local == "" {
			local = exportJoinPath(home, "AppData", "Local")
		}
		return exportJoinPath(local, "hermes")
	}
	return exportJoinPath(home, ".hermes")
}

func exportHermesConfigPath(env map[string]string, home string) string {
	return exportJoinPath(exportHermesHomeDir(env, home), "config.yaml")
}

func exportOpenclawEffectiveHome(env map[string]string, home string) (string, error) {
	if override := strings.TrimSpace(env["OPENCLAW_HOME"]); override != "" {
		return exportAbsoluteClientPath(override, home, "OPENCLAW_HOME")
	}
	return home, nil
}

func exportOpenclawHomeDir(env map[string]string, home string) (string, error) {
	effectiveHome, err := exportOpenclawEffectiveHome(env, home)
	if err != nil {
		return "", err
	}
	if stateDir := strings.TrimSpace(env["OPENCLAW_STATE_DIR"]); stateDir != "" {
		return exportAbsoluteClientPath(stateDir, effectiveHome, "OPENCLAW_STATE_DIR")
	}
	profile := strings.TrimSpace(env["OPENCLAW_PROFILE"])
	if profile != "" && !strings.EqualFold(profile, "default") {
		return exportJoinPath(effectiveHome, ".openclaw-"+profile), nil
	}
	modern := exportJoinPath(effectiveHome, ".openclaw")
	if exportFileExists(modern) {
		return modern, nil
	}
	legacy := exportJoinPath(effectiveHome, ".clawdbot")
	if exportFileExists(legacy) {
		return legacy, nil
	}
	return modern, nil
}

func exportOpenclawConfigPath(env map[string]string, home string) (string, error) {
	effectiveHome, err := exportOpenclawEffectiveHome(env, home)
	if err != nil {
		return "", err
	}
	if explicit := strings.TrimSpace(env["OPENCLAW_CONFIG_PATH"]); explicit != "" {
		return exportAbsoluteClientPath(explicit, effectiveHome, "OPENCLAW_CONFIG_PATH")
	}
	stateOverride := strings.TrimSpace(env["OPENCLAW_STATE_DIR"])
	profile := strings.TrimSpace(env["OPENCLAW_PROFILE"])
	scoped := stateOverride != "" || (profile != "" && !strings.EqualFold(profile, "default"))
	stateDir, err := exportOpenclawHomeDir(env, home)
	if err != nil {
		return "", err
	}
	var candidates []string
	if scoped {
		candidates = []string{exportJoinPath(stateDir, "openclaw.json"), exportJoinPath(stateDir, "clawdbot.json")}
	} else {
		candidates = []string{
			exportJoinPath(effectiveHome, ".openclaw", "openclaw.json"),
			exportJoinPath(effectiveHome, ".openclaw", "clawdbot.json"),
			exportJoinPath(effectiveHome, ".clawdbot", "openclaw.json"),
			exportJoinPath(effectiveHome, ".clawdbot", "clawdbot.json"),
		}
	}
	for _, candidate := range candidates {
		if exportFileExists(candidate) {
			return candidate, nil
		}
	}
	return candidates[0], nil
}

func exportKimiConfigPath(env map[string]string, home string) string {
	override := strings.TrimSpace(env["KIMI_CODE_HOME"])
	if override != "" {
		return exportJoinPath(override, "config.toml")
	}
	return exportJoinPath(home, ".kimi-code", "config.toml")
}

func exportGajaeConfigPath(env map[string]string, home string) string {
	return exportJoinPath(home, ".gjc", "agent", "models.yml")
}

func exportDshHomeDir(env map[string]string, home string) (string, error) {
	raw, present := env["DSH_HOME"]
	if !present || strings.TrimSpace(raw) == "" {
		return exportJoinPath(home, ".dsh"), nil
	}
	if raw == "~" {
		return home, nil
	}
	if strings.HasPrefix(raw, "~/") || strings.HasPrefix(raw, `~\`) {
		return exportJoinPath(home, raw[2:]), nil
	}
	if !filepath.IsAbs(raw) {
		return "", errors.New("DSH_HOME must be an absolute path or start with ~; \"" + raw + "\" depends on the working directory, so opencodex and DSH would disagree about which settings file it names.")
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", err
	}
	return abs, nil
}

func exportDshConfigPath(env map[string]string, home string) (string, error) {
	dir, err := exportDshHomeDir(env, home)
	if err != nil {
		return "", err
	}
	return exportJoinPath(dir, "settings.yaml"), nil
}

func exportMcodeHomeDir(env map[string]string, home string) (string, error) {
	if primary := strings.TrimSpace(env["MINIMAX_DATA_DIR"]); primary != "" {
		return exportAbsoluteClientPath(primary, home, "MINIMAX_DATA_DIR")
	}
	if legacy := strings.TrimSpace(env["MAVIS_DATA_DIR"]); legacy != "" {
		return exportAbsoluteClientPath(legacy, home, "MAVIS_DATA_DIR")
	}
	return exportJoinPath(home, ".minimax"), nil
}

func exportMcodeConfigPath(env map[string]string, home string) (string, error) {
	dir, err := exportMcodeHomeDir(env, home)
	if err != nil {
		return "", err
	}
	return exportJoinPath(dir, "config.yaml"), nil
}

func exportZcodeConfigPath(env map[string]string, home string) (string, error) {
	var dir string
	if override := strings.TrimSpace(env["ZCODE_DATA_DIR"]); override != "" {
		expanded, err := exportAbsoluteClientPath(override, home, "ZCODE_DATA_DIR")
		if err != nil {
			return "", err
		}
		dir = expanded
	} else {
		dir = exportJoinPath(home, ".zcode")
	}
	return exportJoinPath(dir, "v2", "config.json"), nil
}

func exportPrimeConfigPath(env map[string]string, home string) (string, error) {
	var dir string
	if override := strings.TrimSpace(env["PRIME_AGENT_CODING_AGENT_DIR"]); override != "" {
		expanded, err := exportAbsoluteClientPath(override, home, "PRIME_AGENT_CODING_AGENT_DIR")
		if err != nil {
			return "", err
		}
		dir = expanded
	} else {
		dir = exportJoinPath(home, ".prime", "agent")
	}
	return exportJoinPath(dir, "models.json"), nil
}

func exportAsideCurrentAccountID(root string) (int, error) {
	manifest := exportJoinPath(root, "accounts.json")
	raw, err := os.ReadFile(manifest)
	if err != nil {
		return 0, errors.New("Aside's account manifest is missing or unreadable at " + manifest + ", so opencodex cannot tell which account's model catalog to write. Launch Aside once to create it.")
	}
	value, parseErr := jsonwire.Parse(raw)
	if parseErr != nil || value.Kind() != jsonwire.Object {
		return 0, errors.New("Aside's account manifest at " + manifest + " is not readable JSON, so the account it names cannot be trusted. Writing a guessed account would target a different account's catalog.")
	}
	idField := value.Find("currentAccountId")
	if idField == nil || idField.Kind() != jsonwire.Number {
		return 0, errors.New("Aside's account manifest at " + manifest + " declares no usable currentAccountId, so opencodex cannot tell which account is current.")
	}
	id := idField.NumberRaw()
	parsed, err := strconvExportAtoi(id)
	if err != nil || parsed < 0 {
		return 0, errors.New("Aside's account manifest at " + manifest + " declares no usable currentAccountId, so opencodex cannot tell which account is current.")
	}
	return parsed, nil
}

func strconvExportAtoi(raw string) (int, error) {
	var out int
	for _, character := range raw {
		if character < '0' || character > '9' {
			return 0, errors.New("not an integer")
		}
		out = out*10 + int(character-'0')
	}
	return out, nil
}

func exportAsideConfigPath(env map[string]string, home string) (string, error) {
	root := exportJoinPath(home, ".aside")
	id, err := exportAsideCurrentAccountID(root)
	if err != nil {
		return "", err
	}
	return exportJoinPath(root, "u", fmt.Sprintf("%d", id), "models.json"), nil
}

// exportClientDestination mirrors spec.destination(env).
func exportClientDestination(id string, env map[string]string, home string) (string, error) {
	switch id {
	case "opencode":
		return exportOpenCodeGlobalConfigPath(env, home), nil
	case "pi":
		return exportPiConfigPath(env, home)
	case "omp":
		return exportOmpModelsConfigPath(env, home)
	case "hermes":
		return exportHermesConfigPath(env, home), nil
	case "openclaw":
		return exportOpenclawConfigPath(env, home)
	case "kimi":
		return exportKimiConfigPath(env, home), nil
	case "gajae":
		return exportGajaeConfigPath(env, home), nil
	case "dsh":
		return exportDshConfigPath(env, home)
	case "mcode":
		return exportMcodeConfigPath(env, home)
	case "zcode":
		return exportZcodeConfigPath(env, home)
	case "prime":
		return exportPrimeConfigPath(env, home)
	case "aside":
		return exportAsideConfigPath(env, home)
	}
	return "", errors.New("unknown export client " + id)
}

// ─────────────────────────────────────────────────────────────────────────────
// Command entry.

func exportEnv() map[string]string {
	out := map[string]string{}
	for _, entry := range os.Environ() {
		if index := strings.Index(entry, "="); index >= 0 {
			out[entry[:index]] = entry[index+1:]
		}
	}
	return out
}

func readExportConfig() (exportConfigView, *jsonwire.Value, error) {
	view := exportConfigView{}
	dir, err := config.Dir()
	if err != nil {
		return view, nil, nil
	}
	path := filepath.Join(dir, "config.json")
	raw, readErr := os.ReadFile(path)
	if readErr != nil {
		if os.IsNotExist(readErr) {
			return view, nil, nil
		}
		return view, nil, errors.New("Could not load opencodex config at " + path + ": " + readErr.Error())
	}
	value, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		return view, nil, errors.New("Could not load opencodex config at " + path + ": " + parseErr.Error())
	}
	if value.Kind() != jsonwire.Object {
		return view, value, nil
	}
	if hostname := value.Find("hostname"); hostname != nil && hostname.Kind() == jsonwire.String {
		view.hostname = hostname.String()
	}
	if providers := value.Find("providers"); providers != nil && providers.Kind() == jsonwire.Object {
		if openai := providers.Find("openai"); openai != nil && openai.Kind() == jsonwire.Object {
			if mode := openai.Find("codexAccountMode"); mode != nil && mode.Kind() == jsonwire.String {
				view.codexDirect = codexAccountModeDirect(mode.String())
			}
		}
	}
	if combos := value.Find("combos"); combos != nil {
		view.combos = combos
	}
	if listener := value.Find("unauthenticatedLoopbackListener"); listener != nil && listener.Kind() == jsonwire.Object {
		if enabled := listener.Find("enabled"); enabled != nil && enabled.Kind() == jsonwire.Bool {
			view.unauthLoopback = enabled.Bool()
		}
	}
	return view, value, nil
}

// exportHasContextLimit mirrors hasContextLimit for the degraded-count line.
func exportHasContextLimit(model exportModel) bool {
	return model.hasContextWindow && model.contextWindow > 0
}

// exportModelsFromProxyRowsRaw decodes a /api/models array.
func exportModelsFromProxyRowsRaw(rowsValue *jsonwire.Value, config exportConfigView) []exportModel {
	if rowsValue == nil || rowsValue.Kind() != jsonwire.Array {
		return nil
	}
	rows := make([]exportModelRow, 0, len(rowsValue.Elements()))
	for _, element := range rowsValue.Elements() {
		rows = append(rows, decodeExportModelRow(element))
	}
	return exportModelsFromProxyRows(rows, config.codexDirect)
}

// exportWriteFile mirrors writeExport: `wx` refusal without --force.
func exportWriteFile(path, text string, force bool) error {
	flags := os.O_WRONLY | os.O_CREATE
	if !force {
		flags |= os.O_EXCL
	}
	file, err := os.OpenFile(path, flags, 0o666)
	if err != nil {
		if os.IsExist(err) {
			return errors.New(path + " already exists. Re-run with --force to replace it, or print the config and merge it yourself.")
		}
		return err
	}
	defer file.Close()
	if _, err := io.WriteString(file, text); err != nil {
		return err
	}
	return nil
}

func runExport(argv []string, deps Deps) int {
	rest := append([]string(nil), argv...)
	// takeOption mirrors (missing flag is distinct from a present flag with no
	// value): the former reports `--client is required (...)`, the latter
	// `--client requires a value` without a usage block.
	client, clientGiven, err := takeUsageOption(&rest, "--client")
	clientFlagPresent := containsString(rest, "--client")
	if err != nil && clientFlagPresent {
		return exportUsageError(deps, err, false)
	}
	if !clientGiven {
		return exportUsageError(deps, errors.New("--client is required ("+strings.Join(exportClientIDs, ", ")+")"), true)
	}
	client = strings.ToLower(strings.TrimSpace(client))
	if !exportIsClientID(client) {
		return exportUsageError(deps, errors.New("--client must be one of: "+strings.Join(exportClientIDs, ", ")), true)
	}
	wantsJSON := takeUsageFlag(&rest, "--json")
	force := takeUsageFlag(&rest, "--force")
	out, outGiven, err := takeUsageOption(&rest, "--out")
	outFlagPresent := containsString(rest, "--out")
	if err != nil && outFlagPresent {
		return exportUsageError(deps, err, false)
	}
	if ok, code := exportRejectArgs(deps, rest); !ok {
		return code
	}
	spec := exportSpecs()[client]

	configView, _, configErr := readExportConfig()
	if configErr != nil {
		fmt.Fprintln(deps.Stderr, "Error: "+configErr.Error())
		return 1
	}
	state, found := liveProxyEndpoint(deps)
	if !found {
		fmt.Fprintln(deps.Stderr, "Error: Proxy is not running. Start it with: ocx start")
		return 1
	}
	root := baseURL(state)
	body, rawText, responseStatus, fetchErr := fetchManagementJSON(deps, http.MethodGet, "/api/models", nil)
	if fetchErr != nil {
		return observeReportAPIError(deps, fetchErr.Error(), responseStatus)
	}
	if responseStatus < 200 || responseStatus >= 300 {
		return observeReportAPIError(deps, usageResponseMessage(body, rawText, responseStatus), responseStatus)
	}
	rowsValue := body
	if rowsValue == nil || rowsValue.Kind() != jsonwire.Array {
		message := "Management API returned an unexpected /api/models payload."
		fmt.Fprintln(deps.Stderr, "Error: "+message)
		return 1
	}
	models := exportModelsFromProxyRowsRaw(rowsValue, configView)
	ctx := exportContext{baseURL: root + "/v1", models: models, config: configView}
	document := spec.build(ctx)
	text, serializeErr := serializeExportDocument(document, spec.format)
	if serializeErr != nil {
		fmt.Fprintln(deps.Stderr, "Error: "+serializeErr.Error())
		return 1
	}
	if outGiven {
		if writeErr := exportWriteFile(out, text, force); writeErr != nil {
			if exportIsCliUsage(writeErr) {
				return exportUsageError(deps, writeErr, true)
			}
			fmt.Fprintln(deps.Stderr, "Error: "+writeErr.Error())
			return 1
		}
		if wantsJSON {
			fmt.Fprintln(deps.Stderr, "Wrote "+out)
		}
	}
	degraded := 0
	for _, model := range models {
		if !exportHasContextLimit(model) {
			degraded++
		}
	}
	if wantsJSON {
		if err := observePrintPayload(deps, document, ""); err != nil {
			fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
			return 1
		}
		return 0
	}
	fmt.Fprintln(deps.Stdout, strings.TrimRight(text, "\n"))
	fmt.Fprintln(deps.Stdout, "")
	if outGiven {
		fmt.Fprintln(deps.Stdout, "Wrote "+out)
	}
	destination, destErr := exportClientDestination(client, exportEnv(), exportHome())
	if destErr != nil {
		fmt.Fprintln(deps.Stderr, "Error: "+destErr.Error())
		return 1
	}
	fmt.Fprintln(deps.Stdout, "Destination: "+destination)
	fmt.Fprintln(deps.Stdout, "Merge this generated configuration into that file; do not replace it.")
	fmt.Fprintln(deps.Stdout, "Before launching: "+spec.exportHint)
	count := len(models)
	plural := "models"
	if count == 1 {
		plural = "model"
	}
	fmt.Fprintf(deps.Stdout, "%d %s; %d omit context limits (the client applies its own defaults).\n", count, plural, degraded)
	return 0
}

func exportIsCliUsage(err error) bool {
	return strings.Contains(err.Error(), "already exists")
}

func exportUsageError(deps Deps, err error, withUsage bool) int {
	fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
	if withUsage {
		fmt.Fprintln(deps.Stderr, exportUsageUsage)
	}
	return usageExitUsage
}

// exportRejectArgs mirrors the export command's rejectArgs(args, USAGE):
// leftover positional arguments print the export USAGE block, not observe's.
func exportRejectArgs(deps Deps, rest []string) (ok bool, code int) {
	if len(rest) == 0 {
		return true, 0
	}
	return false, exportUsageError(deps, errors.New("Unexpected argument(s): "+strings.Join(rest, " ")), true)
}

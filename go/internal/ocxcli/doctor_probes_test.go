package ocxcli

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

func TestDoctorPathAndProxyProbeFragmentsMatchTypeScriptDoctor(t *testing.T) {
	// The command remains TypeScript-owned. Run its real text-mode command in a
	// hermetic home and compare only the Go-portable report fragments byte for
	// byte; unrelated live, OAuth, and network probes remain outside this slice.
	home := t.TempDir()
	codexHome := filepath.Join(home, "codex")
	if err := os.Mkdir(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "auth.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("HTTP_PROXY", "")
	t.Setenv("http_proxy", "")
	t.Setenv("HTTPS_PROXY", "")
	t.Setenv("https_proxy", "")
	t.Setenv("ALL_PROXY", "")
	t.Setenv("all_proxy", "")
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")

	output, exitCode := runTypeScriptDoctor(t, home, codexHome)
	if exitCode != 0 {
		t.Fatalf("TypeScript doctor exit = %d; output=%s", exitCode, output)
	}

	paths := strings.Join(FormatDoctorPaths(CollectDoctorPaths(), ReadDoctorMounts()), "\n")
	if got, want := doctorSection(output, "Paths", "Response-state temp files"), paths; got != want {
		t.Fatalf("Paths bytes\n got: %q\nwant: %q", got, want)
	}
	current := strings.Join(FormatDoctorCurrentProxyEnv(CollectCurrentDoctorProxyEnv()), "\n")
	if got, want := doctorSection(output, "Current doctor process proxy env (presence only)", "Configured proxy (value hidden)"), current; got != want {
		t.Fatalf("current proxy environment bytes\n got: %q\nwant: %q", got, want)
	}
	running := strings.Join(FormatDoctorRunningProxyEnv(CollectDoctorRunningProxyEnv(0, nil)), "\n")
	if got, want := doctorSection(output, "Running proxy process proxy env (presence only)", "Memory / runtime"), running; got != want {
		t.Fatalf("running proxy environment bytes\n got: %q\nwant: %q", got, want)
	}
}

func runTypeScriptDoctor(t *testing.T, home, codexHome string) (string, int) {
	return runTypeScriptDoctorArgs(t, home, codexHome)
}

func runTypeScriptDoctorArgs(t *testing.T, home, codexHome string, args ...string) (string, int) {
	t.Helper()
	repo := typeScriptOracleRepo(t)
	command := append([]string{"src/cli/index.ts", "doctor"}, args...)
	cmd := exec.Command("bun", command...)
	cmd.Dir = repo
	clean := make([]string, 0, len(os.Environ())+4)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key == "HOME" || key == "OPENCODEX_HOME" || key == "CODEX_HOME" ||
			strings.EqualFold(key, "HTTP_PROXY") || strings.EqualFold(key, "HTTPS_PROXY") ||
			strings.EqualFold(key, "ALL_PROXY") || strings.EqualFold(key, "NO_PROXY") {
			continue
		}
		clean = append(clean, entry)
	}
	cmd.Env = append(clean, "HOME="+home, "OPENCODEX_HOME="+home, "CODEX_HOME="+codexHome)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return string(out), 0
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return string(out), exitError.ExitCode()
	}
	t.Fatalf("TypeScript doctor oracle: %v: %s", err, out)
	return "", -1
}

func doctorSection(output, heading, nextHeading string) string {
	start := "\n" + heading + "\n"
	index := strings.Index(output, start)
	if index < 0 {
		if strings.HasPrefix(output, heading+"\n") {
			index = 0
		} else {
			return ""
		}
	} else {
		index++
	}
	end := "\n\n" + nextHeading + "\n"
	rest := output[index:]
	endIndex := strings.Index(rest, end)
	if endIndex < 0 {
		return rest
	}
	return rest[:endIndex]
}

func TestDoctorProbePureContracts(t *testing.T) {
	fs := DetectDoctorFilesystem("/mnt/c/Users/a/.codex", "none / overlay rw 0 0\nC: /mnt/c drvfs rw 0 0\n")
	if fs.Type != "drvfs" || fs.Mount != "/mnt/c" || !fs.IsDrvfs || !fs.IsMntDrive {
		t.Fatalf("filesystem = %#v", fs)
	}
	if got := DetectDoctorFilesystem("/x", ""); got.Type != "n/a" || got.Mount != "" {
		t.Fatalf("empty mounts = %#v", got)
	}
	rows := CollectDoctorProxyEnv(map[string]string{"http_proxy": " http://secret.example "})
	if !rows[0].Present || rows[1].Present {
		t.Fatalf("proxy rows = %#v", rows)
	}
	parsed := ParseDoctorProcessEnvironment("HTTP_PROXY=secret\x00NO_PROXY=localhost\x00broken\x00")
	if parsed["HTTP_PROXY"] != "secret" || parsed["NO_PROXY"] != "localhost" {
		t.Fatalf("parsed env = %#v", parsed)
	}
	if got := CollectDoctorRunningProxyEnv(7, func(int) (string, error) { return "", errors.New("denied") }); got.Status != "unavailable" || got.Reason != "could not read process environment" {
		t.Fatalf("unavailable = %#v", got)
	}
}

func TestDoctorConfigAndTempProbeFragmentsMatchTypeScriptDoctor(t *testing.T) {
	home := t.TempDir()
	codexHome := filepath.Join(home, "codex")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte("{\"proxy\":\"$"+"{DOCTOR_PROXY}\",\"providers\":{\"missing\":{\"adapter\":\"openai-chat\",\"baseUrl\":\"https://example.test/v1\",\"authMode\":\"key\",\"apiKey\":\"$DOCTOR_KEY\",\"defaultModel\":\"m\"}},\"defaultProvider\":\"missing\"}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("model_provider = \"opencodex\"\n\n[model_providers.opencodex]\nenv_key = \"OPENCODEX_API_AUTH_TOKEN\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "service-api-token"), []byte("secret-that-must-not-appear"), 0o600); err != nil {
		t.Fatal(err)
	}
	temp := filepath.Join(home, "responses-state.json.ocx.999999.1.tmp")
	if err := os.WriteFile(temp, make([]byte, 2*1024*1024), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-16 * time.Minute)
	if err := os.Chtimes(temp, old, old); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("DOCTOR_PROXY", "")
	t.Setenv("DOCTOR_KEY", "")
	t.Setenv("OPENCODEX_API_AUTH_TOKEN", "")
	for _, key := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"} {
		t.Setenv(key, "")
	}

	oracle, exitCode := runTypeScriptDoctor(t, home, codexHome)
	if exitCode != 0 {
		t.Fatalf("TypeScript doctor exit = %d; output=%s", exitCode, oracle)
	}
	diagnostic := ReadStatusConfigDiagnostics()
	configured := strings.Join(FormatDoctorConfiguredProxy(CollectDoctorConfiguredProxy(diagnostic, doctorProcessEnv())), "\n")
	if got := doctorSection(oracle, "Configured proxy (value hidden)", "Provider API keys (value hidden)"); got != configured {
		t.Fatalf("configured proxy bytes\n got: %q\nwant: %q", got, configured)
	}
	ordered, err := config.LoadOrderedFromDir(home)
	if err != nil {
		t.Fatal(err)
	}
	keys := strings.Join(FormatDoctorProviderAPIKeys(CollectDoctorProviderAPIKeysOrdered(ordered.Find("providers"), doctorProcessEnv())), "\n")
	if got := doctorSection(oracle, "Provider API keys (value hidden)", "Codex env_key launch readiness"); got != keys {
		t.Fatalf("provider key bytes\n got: %q\nwant: %q", got, keys)
	}
	codexConfig, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	readiness := strings.Join(FormatDoctorCodexEnvKeyReadiness(CollectDoctorCodexEnvKeyReadiness(string(codexConfig), doctorProcessEnv(), DoctorShimDiagnostic{}, true)), "\n")
	if got := doctorSection(oracle, "Codex env_key launch readiness", "Running proxy process proxy env (presence only)"); got != readiness {
		t.Fatalf("env_key readiness bytes\n got: %q\nwant: %q", got, readiness)
	}
	temps := strings.Join(append([]string{"Response-state temp files"}, FormatDoctorResponseTemps(InspectDoctorResponseTemps(), false)...), "\n")
	if got := doctorSection(oracle, "Response-state temp files", "Codex app home targeting"); got != temps {
		t.Fatalf("response temps bytes\n got: %q\nwant: %q", got, temps)
	}
	if strings.Contains(configured+keys+readiness, "secret-that-must-not-appear") {
		t.Fatal("doctor diagnostics leaked a secret")
	}
}

func TestDoctorResponseTempReclaimFragmentMatchesTypeScriptDoctor(t *testing.T) {
	home := t.TempDir()
	codexHome := filepath.Join(home, "codex")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	writeTemp := func() string {
		path := filepath.Join(home, "responses-state.json.ocx.999999.1.tmp")
		if err := os.WriteFile(path, make([]byte, 2*1024*1024), 0o600); err != nil {
			t.Fatal(err)
		}
		old := time.Now().Add(-16 * time.Minute)
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
		return path
	}
	path := writeTemp()
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	for _, key := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"} {
		t.Setenv(key, "")
	}

	oracle, exitCode := runTypeScriptDoctorArgs(t, home, codexHome, "--reclaim-response-temps")
	if exitCode != 0 {
		t.Fatalf("TypeScript doctor exit = %d; output=%s", exitCode, oracle)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("TypeScript reclaim left %s: %v", path, err)
	}
	path = writeTemp()
	goReport := ReclaimDoctorResponseTemps()
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Go reclaim left %s: %v", path, err)
	}
	goSection := strings.Join(append([]string{"Response-state temp files"}, FormatDoctorResponseTemps(goReport, true)...), "\n")
	if got := doctorSection(oracle, "Response-state temp files", "Codex app home targeting"); got != goSection {
		t.Fatalf("response-temp reclaim bytes\n got: %q\nwant: %q", got, goSection)
	}
}

func TestDoctorProbe3StableFragmentsMatchTypeScriptDoctor(t *testing.T) {
	home := t.TempDir()
	codexHome := filepath.Join(home, "codex")
	if err := os.MkdirAll(filepath.Join(codexHome, "agents"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "agents", "reviewer.toml"), []byte("model_fallback = []\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	for _, key := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"} {
		t.Setenv(key, "")
	}
	oracle, exitCode := runTypeScriptDoctor(t, home, codexHome)
	if exitCode != 0 {
		t.Fatalf("TypeScript doctor exit = %d; output=%s", exitCode, oracle)
	}
	if got := strings.Join(FormatDoctorOrcaHome(CollectDoctorOrcaHome()), "\n"); got != doctorSection(oracle, "Codex app home targeting", "Codex restart safety") {
		t.Fatalf("Orca home bytes\n got: %q\nwant: %q", got, doctorSection(oracle, "Codex app home targeting", "Codex restart safety"))
	}
	extra := CollectStatusExtraDomains(ReadStatusConfigDiagnostics(), StatusExtraDeps{})
	if got := strings.Join(FormatDoctorRestartSafety(CollectDoctorRestartSafety(extra.Startup)), "\n"); got != doctorSection(oracle, "Codex restart safety", "Codex runtime selection") {
		t.Fatalf("restart safety bytes\n got: %q\nwant: %q", got, doctorSection(oracle, "Codex restart safety", "Codex runtime selection"))
	}
	if got := strings.Join(FormatDoctorRuntimeSelection(CollectDoctorRuntimeSelection()), "\n"); got != doctorSection(oracle, "Codex runtime selection", "Current doctor process proxy env (presence only)") {
		t.Fatalf("runtime selection bytes\n got: %q\nwant: %q", got, doctorSection(oracle, "Codex runtime selection", "Current doctor process proxy env (presence only)"))
	}
	if got := strings.Join(FormatDoctorAgentRoles(CollectDoctorAgentRoles(codexHome)), "\n"); got != doctorSection(oracle, "Codex agent role files", "OAuth reliability") {
		t.Fatalf("agent role bytes\n got: %q\nwant: %q", got, doctorSection(oracle, "Codex agent role files", "OAuth reliability"))
	}
}

func TestDoctorProbe3PureFormatContracts(t *testing.T) {
	if got := strings.Join(FormatDoctorServiceMemory(DoctorServiceMemoryReport{Status: "unreachable", Error: "fetch failed"}, "1.2.3"), "\n"); got != "  --     doctor process Bun 1.2.3 (this is NOT the service process)\n  --     proxy not reachable (not running?) [fetch failed]" {
		t.Fatalf("memory fallback = %q", got)
	}
	if got := strings.Join(FormatDoctorProjectConfigs(nil), "\n"); got != "Project Codex configs\n  ok     no project-local provider bypass detected" {
		t.Fatalf("project fallback = %q", got)
	}
	if got := strings.Join(FormatDoctorCatalogState(DoctorCatalogState{State: "fresh"}), "\n"); got != "  [OK] Codex app-server model catalog is current with the on-disk catalog." {
		t.Fatalf("catalog = %q", got)
	}
}

func TestDoctorServiceMemoryFormatterMatchesTypeScriptOracle(t *testing.T) {
	repo := typeScriptOracleRepo(t)
	script := "import { formatServiceMemoryLines } from \"./src/cli/doctor\";\n" +
		"const input = JSON.parse(process.env.OCX_MEMORY_INPUT);\n" +
		"process.stdout.write(JSON.stringify(formatServiceMemoryLines(input)));"
	input := map[string]any{
		"status": "ok",
		"data": map[string]any{
			"pid": 42, "bunVersion": "1.3.14", "platform": "linux",
			"rss": 5 * 1024 * 1024 * 1024, "heapUsed": 100 * 1024 * 1024,
			"external": 0, "arrayBuffers": 0, "streamMode": "auto",
			"eagerRelay": nil, "jscHeap": nil, "watchdog": nil,
		},
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bun", "-e", script)
	cmd.Dir, cmd.Env = repo, append(os.Environ(), "OCX_MEMORY_INPUT="+string(encoded))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("TypeScript service-memory oracle: %v: %s", err, out)
	}
	var want []string
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatalf("decode service-memory oracle: %v: %s", err, out)
	}
	got := FormatDoctorServiceMemory(DoctorServiceMemoryReport{Status: "ok", Data: DoctorServiceMemoryData{
		PID: 42, BunVersion: "1.3.14", Platform: "linux", RSS: 5 * 1024 * 1024 * 1024,
		HeapUsed: 100 * 1024 * 1024, StreamMode: "auto",
	}}, "oracle")
	// Bun.version belongs to the oracle process, so compare all output that is
	// determined by the shared endpoint payload verbatim.
	got[0] = want[0]
	if gotText, wantText := strings.Join(got, "\n"), strings.Join(want, "\n"); gotText != wantText {
		t.Fatalf("service memory bytes\n got: %q\nwant: %q", gotText, wantText)
	}
}

func TestDoctorProjectProfileFixtureMatchesTypeScriptOracle(t *testing.T) {
	home := t.TempDir()
	codexHome, project := filepath.Join(home, "codex"), filepath.Join(home, "project")
	if err := os.MkdirAll(filepath.Join(project, ".codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("model_provider = \"opencodex\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture := "profile = \"review\"\nmodel_provider = \"openai\"\n\n[profiles.review]\nmodel_provider = \"fixture\"\n\n[model_providers.fixture]\n"
	if err := os.WriteFile(filepath.Join(project, ".codex", "config.toml"), []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	repo := typeScriptOracleRepo(t)
	script := "import { collectProjectCodexConfigWarnings, formatProjectCodexConfigWarningsForDoctor } from './src/codex/project-config-warnings'; process.stdout.write(JSON.stringify(formatProjectCodexConfigWarningsForDoctor(collectProjectCodexConfigWarnings({cwd: process.env.OCX_PROJECT, codexConfigPath: process.env.OCX_CODEX_CONFIG}))));"
	cmd := exec.Command("bun", "-e", script)
	cmd.Dir = repo
	cmd.Env = append(os.Environ(), "OCX_PROJECT="+project, "OCX_CODEX_CONFIG="+filepath.Join(codexHome, "config.toml"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("TypeScript project oracle: %v: %s", err, out)
	}
	var want []string
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	got := FormatDoctorProjectConfigs(CollectDoctorProjectConfigsWithGlobal(codexHome, project))[1:]
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("project profile bytes\n got: %q\nwant: %q", got, want)
	}
}

func TestDoctorHistoryManifestFixtureMatchesTypeScriptDoctor(t *testing.T) {
	home := t.TempDir()
	codexHome := filepath.Join(home, "codex")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	state, rollout := filepath.Join(codexHome, "state_5.sqlite"), filepath.Join(home, "rollout.jsonl")
	rolloutText := `{"type":"session_meta","payload":{"id":"thread-1","model_provider":"opencodex","source":"cli"}}` + "\n"
	if err := os.WriteFile(rollout, []byte(rolloutText), 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", state)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, source TEXT, has_user_event INTEGER, first_user_message TEXT)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO threads VALUES (?, ?, 'opencodex', 'cli', 1, '')", "thread-1", rollout); err != nil {
		t.Fatal(err)
	}
	db.Close()
	manifest := fmt.Sprintf(`{"version":2,"stateDbPath":%q,"entries":{"thread-1":{"id":"thread-1","rolloutPath":%q,"modelProvider":"openai","source":"cli","hasUserEvent":1}}}`, state, rollout)
	backup := DoctorHistoryBackupPath(state, home)
	if err := os.WriteFile(backup, []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	oracle, code := runTypeScriptDoctor(t, home, codexHome)
	if code != 0 {
		t.Fatalf("TypeScript doctor exit %d: %s", code, oracle)
	}
	want := "  --     1 backup manifest entry pending exact metadata restore"
	if !strings.Contains(oracle, want) {
		t.Fatalf("TypeScript history line missing: %s", oracle)
	}
	got := strings.Join(FormatDoctorHistoryPending(CollectDoctorHistoryPending(state, backup)), "\n")
	if got != want {
		t.Fatalf("history bytes got %q want %q", got, want)
	}
}

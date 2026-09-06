package ocxcli

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
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
	t.Helper()
	repo := typeScriptOracleRepo(t)
	cmd := exec.Command("bun", "src/cli/index.ts", "doctor")
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

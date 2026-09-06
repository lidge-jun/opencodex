package ocxcli

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// DoctorPathRow is one filesystem location reported by ocx doctor.
type DoctorPathRow struct {
	Label  string
	Path   string
	Exists bool
}

// CollectDoctorPaths mirrors collectPaths in src/cli/doctor.ts. It is
// side-effect free so it can be adopted when the command ownership switches.
func CollectDoctorPaths() []DoctorPathRow {
	codexHome := doctorCodexHome()
	opencodexHome, err := config.Dir()
	if err != nil {
		opencodexHome = ""
	}
	configPath := filepath.Join(opencodexHome, "config.json")
	return []DoctorPathRow{
		{Label: "CODEX_HOME", Path: codexHome, Exists: doctorPathExists(codexHome)},
		{Label: "CODEX_HOME/auth.json", Path: filepath.Join(codexHome, "auth.json"), Exists: doctorPathExists(filepath.Join(codexHome, "auth.json"))},
		{Label: "OPENCODEX_HOME", Path: opencodexHome, Exists: doctorPathExists(opencodexHome)},
		{Label: "OPENCODEX_HOME/config.json", Path: configPath, Exists: doctorPathExists(configPath)},
	}
}

func doctorPathExists(path string) bool { _, err := os.Stat(path); return path != "" && err == nil }

func doctorCodexHome() string {
	if raw := strings.TrimSpace(os.Getenv("CODEX_HOME")); raw != "" {
		return filepath.Clean(doctorExpandUserPath(raw))
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".codex"
	}
	return filepath.Join(home, ".codex")
}

func doctorExpandUserPath(raw string) string {
	if raw != "~" && !strings.HasPrefix(raw, "~/") && !strings.HasPrefix(raw, "~\\") {
		return raw
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return raw
	}
	if raw == "~" {
		return home
	}
	return filepath.Join(home, raw[2:])
}

// DoctorFilesystem is the longest mount match for a path.
type DoctorFilesystem struct {
	Type, Mount         string
	IsDrvfs, IsMntDrive bool
}

// DetectDoctorFilesystem mirrors detectFsType. Empty mount content means
// TypeScript's null mount source, producing n/a rather than unknown.
func DetectDoctorFilesystem(path, mountsContent string) DoctorFilesystem {
	isMntDrive := doctorMntDrive(path)
	if mountsContent == "" {
		return DoctorFilesystem{Type: "n/a", IsMntDrive: isMntDrive}
	}
	bestMount, bestType := "", ""
	for _, line := range strings.Split(mountsContent, "\n") {
		parts := strings.Fields(line)
		if len(parts) < 3 {
			continue
		}
		mount, fsType := parts[1], parts[2]
		if path == mount || strings.HasPrefix(path, strings.TrimSuffix(mount, "/")+"/") || mount == "/" {
			if len(mount) > len(bestMount) {
				bestMount, bestType = mount, fsType
			}
		}
	}
	if bestType == "" {
		bestType = "unknown"
	}
	return DoctorFilesystem{Type: bestType, Mount: bestMount, IsDrvfs: bestType == "drvfs" || bestType == "9p", IsMntDrive: isMntDrive}
}

func doctorMntDrive(path string) bool {
	if !strings.HasPrefix(strings.ToLower(path), "/mnt/") || len(path) < 6 {
		return false
	}
	drive := path[5]
	return ((drive >= 'a' && drive <= 'z') || (drive >= 'A' && drive <= 'Z')) && (len(path) == 6 || path[6] == '/')
}

func ReadDoctorMounts() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	content, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return ""
	}
	return string(content)
}

// FormatDoctorPaths has the same report text as the Paths loop in runDoctor.
func FormatDoctorPaths(rows []DoctorPathRow, mounts string) []string {
	lines := []string{"Paths"}
	for _, row := range rows {
		fs := DetectDoctorFilesystem(row.Path, mounts)
		flags := []string{}
		if fs.Type != "n/a" {
			flags = append(flags, "fs="+fs.Type)
		}
		if fs.IsDrvfs || fs.IsMntDrive {
			flags = append(flags, "WSL /mnt drive")
		}
		state := "--  "
		if row.Exists {
			state = "ok  "
		}
		line := "  " + state + row.Label + ": " + row.Path
		if len(flags) > 0 {
			line += "  (" + strings.Join(flags, ", ") + ")"
		}
		lines = append(lines, line)
	}
	return lines
}

var doctorProxyEnvKeys = []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}

// DoctorProxyEnvRow omits values because proxy URLs may embed credentials.
type DoctorProxyEnvRow struct {
	Key     string
	Present bool
}

// CollectDoctorProxyEnv mirrors collectProxyEnv/proxyEnvPresent.
func CollectDoctorProxyEnv(env map[string]string) []DoctorProxyEnvRow {
	rows := make([]DoctorProxyEnvRow, 0, len(doctorProxyEnvKeys))
	for _, key := range doctorProxyEnvKeys {
		present := strings.TrimSpace(env[key]) != "" || strings.TrimSpace(env[strings.ToLower(key)]) != ""
		rows = append(rows, DoctorProxyEnvRow{Key: key, Present: present})
	}
	return rows
}

func doctorProcessEnv() map[string]string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		if key, value, ok := strings.Cut(entry, "="); ok {
			env[key] = value
		}
	}
	return env
}
func CollectCurrentDoctorProxyEnv() []DoctorProxyEnvRow {
	return CollectDoctorProxyEnv(doctorProcessEnv())
}

// ParseDoctorProcessEnvironment parses Linux /proc/<pid>/environ content.
func ParseDoctorProcessEnvironment(content string) map[string]string {
	env := map[string]string{}
	for _, entry := range strings.Split(content, "\x00") {
		if key, value, ok := strings.Cut(entry, "="); ok && key != "" {
			env[key] = value
		}
	}
	return env
}

type DoctorRunningProxyEnv struct {
	Status string
	PID    int
	Reason string
	Rows   []DoctorProxyEnvRow
}

// CollectDoctorRunningProxyEnv mirrors the Linux/local part of
// collectRunningProxyEnv. The reader seam makes unavailable process access
// explicit and avoids emitting any raw environment value.
func CollectDoctorRunningProxyEnv(pid int, procReader func(int) (string, error)) DoctorRunningProxyEnv {
	empty := CollectDoctorProxyEnv(map[string]string{})
	if pid == 0 {
		return DoctorRunningProxyEnv{Status: "not_running", Rows: empty}
	}
	if runtime.GOOS != "linux" && procReader == nil {
		return DoctorRunningProxyEnv{Status: "unavailable", PID: pid, Reason: "process env inspection is only supported on Linux", Rows: empty}
	}
	if procReader == nil {
		procReader = func(value int) (string, error) {
			content, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(value), "environ"))
			return string(content), err
		}
	}
	content, err := procReader(pid)
	if err != nil {
		return DoctorRunningProxyEnv{Status: "unavailable", PID: pid, Reason: "could not read process environment", Rows: empty}
	}
	return DoctorRunningProxyEnv{Status: "ok", PID: pid, Rows: CollectDoctorProxyEnv(ParseDoctorProcessEnvironment(content))}
}

func FormatDoctorCurrentProxyEnv(rows []DoctorProxyEnvRow) []string {
	lines := []string{"Current doctor process proxy env (presence only)"}
	for _, row := range rows {
		state := "unset   "
		if row.Present {
			state = "set    "
		}
		lines = append(lines, "  "+state+row.Key)
	}
	return lines
}

func FormatDoctorRunningProxyEnv(report DoctorRunningProxyEnv) []string {
	lines := []string{"Running proxy process proxy env (presence only)"}
	if report.Status == "not_running" {
		return append(lines, "  --     no running ocx proxy process found")
	}
	if report.Status == "unavailable" {
		return append(lines, "  --     pid "+strconv.Itoa(report.PID)+": "+report.Reason)
	}
	lines = append(lines, "  ok     pid "+strconv.Itoa(report.PID))
	for _, row := range report.Rows {
		state := "unset   "
		if row.Present {
			state = "set    "
		}
		lines = append(lines, "  "+state+row.Key)
	}
	return lines
}

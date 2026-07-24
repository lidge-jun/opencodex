package codex

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// HomeOptions makes platform detection deterministic for callers and tests.
type HomeOptions struct {
	Env         map[string]string
	GOOS        string
	HomeDir     string
	Release     string
	ProcVersion string
	WSLConf     string
	Exists      func(string) bool
	ReadDir     func(string) ([]os.DirEntry, error)
}

func envValue(options HomeOptions, key string) string {
	if options.Env != nil {
		return options.Env[key]
	}
	return os.Getenv(key)
}

func pathExists(path string, options HomeOptions) bool {
	if options.Exists != nil {
		return options.Exists(path)
	}
	_, err := os.Stat(path)
	return err == nil
}

func IsWSLRuntime(options HomeOptions) bool {
	goos := options.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	if goos != "linux" {
		return false
	}
	if envValue(options, "WSL_DISTRO_NAME") != "" || envValue(options, "WSL_INTEROP") != "" {
		return true
	}
	return strings.Contains(strings.ToLower(options.Release+"\n"+options.ProcVersion), "microsoft")
}

func WSLAutomountRoot(options HomeOptions) string {
	root := "/mnt"
	section := ""
	for _, raw := range strings.Split(options.WSLConf, "\n") {
		line := strings.TrimSpace(strings.SplitN(strings.SplitN(raw, "#", 2)[0], ";", 2)[0])
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.ToLower(strings.TrimSpace(line[1 : len(line)-1]))
			continue
		}
		if section != "automount" {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 && strings.EqualFold(strings.TrimSpace(parts[0]), "root") {
			value := strings.Trim(strings.TrimSpace(parts[1]), `"'`)
			if strings.HasPrefix(value, "/") {
				value = strings.TrimRight(value, "/")
				if value == "" {
					value = "/"
				}
				root = value
			}
		}
	}
	return root
}

func ListWSLWindowsCodexHomes(options HomeOptions) []string {
	if !IsWSLRuntime(options) {
		return nil
	}
	root := WSLAutomountRoot(options)
	users := filepath.ToSlash(filepath.Join(root, "c", "Users"))
	readDir := options.ReadDir
	if readDir == nil {
		readDir = os.ReadDir
	}
	entries, err := readDir(users)
	if err != nil {
		return nil
	}
	var homes []string
	for _, entry := range entries {
		name := entry.Name()
		if name == "Default" || name == "Default User" || name == "Public" || name == "All Users" {
			continue
		}
		home := filepath.ToSlash(filepath.Join(users, name, ".codex"))
		if pathExists(filepath.ToSlash(filepath.Join(home, "config.toml")), options) {
			homes = append(homes, home)
		}
	}
	return homes
}

// ResolveCodexHome returns the effective Codex home, honoring CODEX_HOME first.
func ResolveCodexHome(options HomeOptions) string {
	if override := strings.TrimSpace(envValue(options, "CODEX_HOME")); override != "" {
		return expandHome(override, options)
	}
	goos := options.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	if goos == "windows" {
		profile := envValue(options, "USERPROFILE")
		if profile == "" {
			profile = options.HomeDir
		}
		candidates := []string{filepath.Join(profile, ".codex")}
		if appData := envValue(options, "APPDATA"); appData != "" {
			candidates = append(candidates, filepath.Join(appData, "Codex"), filepath.Join(appData, "OpenAI", "Codex"))
		}
		for _, candidate := range candidates {
			if pathExists(filepath.Join(candidate, "config.toml"), options) {
				return filepath.Clean(candidate)
			}
		}
		return filepath.Clean(candidates[0])
	}
	home := options.HomeDir
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	native := filepath.Join(home, ".codex")
	if IsWSLRuntime(options) && !pathExists(filepath.Join(native, "config.toml"), options) {
		windowsHomes := ListWSLWindowsCodexHomes(options)
		if len(windowsHomes) == 1 {
			return windowsHomes[0]
		}
	}
	return filepath.Clean(native)
}

func expandHome(path string, options HomeOptions) string {
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home := options.HomeDir
		if home == "" {
			home, _ = os.UserHomeDir()
		}
		path = filepath.Join(home, strings.TrimLeft(path[1:], `/\`))
	}
	absolute, err := filepath.Abs(path)
	if err == nil {
		return absolute
	}
	return filepath.Clean(path)
}

//go:build darwin

package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

const (
	systemEnvBegin = "# >>> opencodex system env >>>"
	systemEnvEnd   = "# <<< opencodex system env <<<"
)

type SystemEnvConfig struct {
	HomeDir  string
	ProxyURL string
	Values   map[string]string
	Shell    string
}

type systemEnvTracking struct {
	Values  map[string]string `json:"values"`
	Profile string            `json:"profile"`
}

func InstallSystemEnv(ctx context.Context, config SystemEnvConfig) error {
	values, err := normalizeSystemEnv(config)
	if err != nil {
		return err
	}
	profile := shellProfile(config.HomeDir, config.Shell)
	envPath := filepath.Join(config.HomeDir, ".opencodex", "system-env.sh")
	trackingPath := filepath.Join(config.HomeDir, ".opencodex", "system-env.json")
	profileSnapshot, err := snapshotFile(profile)
	if err != nil {
		return err
	}
	envSnapshot, err := snapshotFile(envPath)
	if err != nil {
		return err
	}
	trackingSnapshot, err := snapshotFile(trackingPath)
	if err != nil {
		return err
	}
	previousTracking, err := readSystemEnvTracking(trackingPath)
	if err != nil {
		return err
	}
	ownedValues := make(map[string]string, len(values))
	newValues := make(map[string]string, len(values))
	rollback := func() {
		_ = revertLaunchctlValues(ctx, newValues)
		_ = profileSnapshot.restore(profile)
		_ = envSnapshot.restore(envPath)
		_ = trackingSnapshot.restore(trackingPath)
	}
	for _, name := range sortedEnvironmentKeys(values) {
		current, getErr := launchctlGetenv(ctx, name)
		if getErr != nil {
			rollback()
			return getErr
		}
		if current != "" && current != values[name] {
			rollback()
			return fmt.Errorf("refusing to overwrite user launch environment variable %s", name)
		}
		if current == values[name] {
			if previousTracking.Values[name] == current {
				ownedValues[name] = current
			}
			continue
		}
		if err := exec.CommandContext(ctx, "launchctl", "setenv", name, values[name]).Run(); err != nil {
			rollback()
			return fmt.Errorf("launchctl setenv %s: %w", name, err)
		}
		ownedValues[name] = values[name]
		newValues[name] = values[name]
	}
	if err := writeSystemEnvFile(envPath, values); err != nil {
		rollback()
		return err
	}
	if err := installShellHook(profile); err != nil {
		rollback()
		return err
	}
	tracking := systemEnvTracking{Values: ownedValues, Profile: profile}
	if err := writeJSONFile(trackingPath, tracking); err != nil {
		rollback()
		return err
	}
	return nil
}

type fileSnapshot struct {
	exists bool
	data   []byte
	mode   os.FileMode
}

func snapshotFile(path string) (fileSnapshot, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return fileSnapshot{}, nil
	}
	if err != nil {
		return fileSnapshot{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return fileSnapshot{}, err
	}
	return fileSnapshot{exists: true, data: data, mode: info.Mode().Perm()}, nil
}

func (snapshot fileSnapshot) restore(path string) error {
	if !snapshot.exists {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, snapshot.data, snapshot.mode)
}

func readSystemEnvTracking(path string) (systemEnvTracking, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return systemEnvTracking{Values: map[string]string{}}, nil
	}
	if err != nil {
		return systemEnvTracking{}, err
	}
	var tracking systemEnvTracking
	if err := json.Unmarshal(data, &tracking); err != nil {
		return systemEnvTracking{}, fmt.Errorf("decode system environment tracking: %w", err)
	}
	if tracking.Values == nil {
		tracking.Values = map[string]string{}
	}
	return tracking, nil
}

func UninstallSystemEnv(ctx context.Context, homeDir string) error {
	trackingPath := filepath.Join(homeDir, ".opencodex", "system-env.json")
	data, err := os.ReadFile(trackingPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var tracking systemEnvTracking
	if err := json.Unmarshal(data, &tracking); err != nil {
		return fmt.Errorf("decode system environment tracking: %w", err)
	}
	var revertErr error
	for _, name := range sortedEnvironmentKeys(tracking.Values) {
		current, getErr := launchctlGetenv(ctx, name)
		if getErr != nil {
			revertErr = errors.Join(revertErr, getErr)
			continue
		}
		if current == tracking.Values[name] {
			if err := exec.CommandContext(ctx, "launchctl", "unsetenv", name).Run(); err != nil {
				revertErr = errors.Join(revertErr, fmt.Errorf("launchctl unsetenv %s: %w", name, err))
			}
		}
	}
	if revertErr != nil {
		return revertErr
	}
	if tracking.Profile != "" {
		if err := uninstallShellHook(tracking.Profile); err != nil {
			return err
		}
	}
	for _, path := range []string{filepath.Join(homeDir, ".opencodex", "system-env.sh"), trackingPath} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func normalizeSystemEnv(config SystemEnvConfig) (map[string]string, error) {
	if strings.TrimSpace(config.HomeDir) == "" || strings.TrimSpace(config.ProxyURL) == "" {
		return nil, fmt.Errorf("home directory and proxy URL are required")
	}
	values := map[string]string{
		"OPENCODEX_PROXY_URL": config.ProxyURL,
		"OPENAI_BASE_URL":     strings.TrimRight(config.ProxyURL, "/") + "/v1",
		"ANTHROPIC_BASE_URL":  strings.TrimRight(config.ProxyURL, "/"),
	}
	for name, value := range config.Values {
		if !validEnvironmentName(name) {
			return nil, fmt.Errorf("invalid environment variable name %q", name)
		}
		values[name] = value
	}
	return values, nil
}

func shellProfile(homeDir, shell string) string {
	if strings.Contains(filepath.Base(shell), "bash") {
		return filepath.Join(homeDir, ".bash_profile")
	}
	return filepath.Join(homeDir, ".zshrc")
}

func installShellHook(profile string) error {
	content, err := os.ReadFile(profile)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	cleaned := removeManagedShellBlock(string(content))
	block := systemEnvBegin + "\n" + `[ -f "$HOME/.opencodex/system-env.sh" ] && . "$HOME/.opencodex/system-env.sh"` + "\n" + systemEnvEnd
	updated := strings.TrimRight(cleaned, "\n")
	if updated != "" {
		updated += "\n\n"
	}
	updated += block + "\n"
	return os.WriteFile(profile, []byte(updated), 0o644)
}

func uninstallShellHook(profile string) error {
	content, err := os.ReadFile(profile)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	cleaned := removeManagedShellBlock(string(content))
	return os.WriteFile(profile, []byte(cleaned), 0o644)
}

func removeManagedShellBlock(content string) string {
	for {
		start := strings.Index(content, systemEnvBegin)
		if start < 0 {
			break
		}
		endRelative := strings.Index(content[start:], systemEnvEnd)
		if endRelative < 0 {
			break
		}
		end := start + endRelative + len(systemEnvEnd)
		if end < len(content) && content[end] == '\n' {
			end++
		}
		if start > 0 && content[start-1] == '\n' {
			start--
		}
		content = content[:start] + content[end:]
	}
	return content
}

func writeSystemEnvFile(path string, values map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	var builder strings.Builder
	builder.WriteString("# Generated by opencodex; do not edit.\n")
	for _, name := range sortedEnvironmentKeys(values) {
		builder.WriteString("export " + name + "=" + shellSingleQuote(values[name]) + "\n")
	}
	return os.WriteFile(path, []byte(builder.String()), 0o600)
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func validEnvironmentName(name string) bool {
	if name == "" || !((name[0] >= 'A' && name[0] <= 'Z') || (name[0] >= 'a' && name[0] <= 'z') || name[0] == '_') {
		return false
	}
	for index := 1; index < len(name); index++ {
		character := name[index]
		if !((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '_') {
			return false
		}
	}
	return true
}

func sortedEnvironmentKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func launchctlGetenv(ctx context.Context, name string) (string, error) {
	output, err := exec.CommandContext(ctx, "launchctl", "getenv", name).Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", nil
		}
		return "", fmt.Errorf("launchctl getenv %s: %w", name, err)
	}
	return strings.TrimSpace(string(output)), nil
}

func revertLaunchctlValues(ctx context.Context, values map[string]string) error {
	var result error
	for _, name := range sortedEnvironmentKeys(values) {
		if err := exec.CommandContext(ctx, "launchctl", "unsetenv", name).Run(); err != nil {
			result = errors.Join(result, err)
		}
	}
	return result
}

func writeJSONFile(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o600)
}

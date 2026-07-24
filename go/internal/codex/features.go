package codex

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
)

// FeatureSettings is the subset of Codex feature configuration OpenCodex owns.
type FeatureSettings struct {
	MultiAgentV2         bool
	MaxConcurrentThreads *int
	LegacyMaxThreads     *int
}

var (
	tableHeaderPattern = regexp.MustCompile(`^\s*\[([^]]+)]\s*(?:#.*)?$`)
	integerPattern     = regexp.MustCompile(`^\s*([A-Za-z0-9_.-]+)\s*=\s*(\d+)\s*(#.*)?$`)
)

// ReadFeatureSettings parses config.toml and returns the effective multi-agent settings.
func ReadFeatureSettings(configPath string) (FeatureSettings, error) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return FeatureSettings{}, err
	}
	var document map[string]any
	if err := toml.Unmarshal(data, &document); err != nil {
		return FeatureSettings{}, fmt.Errorf("parse Codex config: %w", err)
	}
	settings := FeatureSettings{}
	if features, ok := asTable(document["features"]); ok {
		switch value := features["multi_agent_v2"].(type) {
		case bool:
			settings.MultiAgentV2 = value
		case map[string]any:
			settings.MultiAgentV2, _ = value["enabled"].(bool)
			settings.MaxConcurrentThreads = positiveInteger(value["max_concurrent_threads_per_session"])
		}
	}
	if agents, ok := asTable(document["agents"]); ok {
		settings.LegacyMaxThreads = positiveInteger(agents["max_threads"])
	}
	return settings, nil
}

func asTable(value any) (map[string]any, bool) {
	table, ok := value.(map[string]any)
	return table, ok
}

func positiveInteger(value any) *int {
	var number int64
	switch value := value.(type) {
	case int64:
		number = value
	case int:
		number = int64(value)
	default:
		return nil
	}
	if number < 1 || int64(int(number)) != number {
		return nil
	}
	result := int(number)
	return &result
}

func IsMultiAgentV2Enabled(configPath string) bool {
	settings, err := ReadFeatureSettings(configPath)
	return err == nil && settings.MultiAgentV2
}

func HasAgentsMaxThreads(configPath string) bool {
	settings, err := ReadFeatureSettings(configPath)
	return err == nil && settings.LegacyMaxThreads != nil
}

func GetAgentsMaxThreads(configPath string) (int, bool, error) {
	settings, err := ReadFeatureSettings(configPath)
	if err != nil || settings.LegacyMaxThreads == nil {
		return 0, false, err
	}
	return *settings.LegacyMaxThreads, true, nil
}

func GetMaxConcurrentThreads(configPath string) (int, bool, error) {
	settings, err := ReadFeatureSettings(configPath)
	if err != nil || settings.MaxConcurrentThreads == nil {
		return 0, false, err
	}
	return *settings.MaxConcurrentThreads, true, nil
}

// ToggleFeature changes a boolean feature while preserving unrelated formatting and comments.
func ToggleFeature(configPath, name string, enabled bool) (bool, error) {
	if !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(name) {
		return false, errors.New("invalid feature name")
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return false, err
	}
	if err := validateTOML(data); err != nil {
		return false, err
	}
	content, eol := normalizeEOL(string(data))
	lines := strings.Split(content, "\n")
	if name == "multi_agent_v2" {
		start, end := tableBounds(lines, "features.multi_agent_v2")
		if start >= 0 {
			value := strconv.FormatBool(enabled)
			pattern := regexp.MustCompile(`^(\s*)enabled\s*=\s*(true|false)(\s*#.*)?$`)
			for index := start + 1; index < end; index++ {
				match := pattern.FindStringSubmatch(lines[index])
				if match == nil {
					continue
				}
				if match[2] == value {
					return false, nil
				}
				lines[index] = match[1] + "enabled = " + value + match[3]
				return true, atomicWriteFile(configPath, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
			}
			lines = append(lines[:start+1], append([]string{"enabled = " + value}, lines[start+1:]...)...)
			return true, atomicWriteFile(configPath, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
		}
	}
	start, end := tableBounds(lines, "features")
	value := strconv.FormatBool(enabled)
	keyPattern := regexp.MustCompile(`^(\s*)` + regexp.QuoteMeta(name) + `\s*=\s*(true|false)(\s*#.*)?$`)
	inlinePattern := regexp.MustCompile(`^(\s*)` + regexp.QuoteMeta(name) + `\s*=\s*\{([^}]*)\}(\s*#.*)?$`)
	if start >= 0 {
		for index := start + 1; index < end; index++ {
			match := keyPattern.FindStringSubmatch(lines[index])
			if match != nil {
				if match[2] == value {
					return false, nil
				}
				lines[index] = match[1] + name + " = " + value + match[3]
				return true, atomicWriteFile(configPath, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
			}
			inline := inlinePattern.FindStringSubmatch(lines[index])
			if inline == nil {
				continue
			}
			enabledPattern := regexp.MustCompile(`\benabled\s*=\s*(true|false)`)
			if current := enabledPattern.FindStringSubmatch(inline[2]); current != nil && current[1] == value {
				return false, nil
			}
			body := inline[2]
			if enabledPattern.MatchString(body) {
				body = enabledPattern.ReplaceAllString(body, "enabled = "+value)
			} else {
				body = "enabled = " + value + ", " + strings.TrimSpace(body)
			}
			lines[index] = inline[1] + name + " = { " + strings.TrimSpace(body) + " }" + inline[3]
			return true, atomicWriteFile(configPath, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
		}
		lines = append(lines[:end], append([]string{name + " = " + value}, lines[end:]...)...)
	} else {
		if len(lines) > 0 && lines[len(lines)-1] != "" {
			lines = append(lines, "")
		}
		lines = append(lines, "[features]", name+" = "+value)
	}
	return true, atomicWriteFile(configPath, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
}

// SetMaxConcurrentThreads persists the v2 nested thread limit.
func SetMaxConcurrentThreads(configPath string, value int) (bool, error) {
	if value < 1 {
		return false, errors.New("max_concurrent_threads_per_session must be >= 1")
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return false, err
	}
	if err := validateTOML(data); err != nil {
		return false, err
	}
	content, eol := normalizeEOL(string(data))
	lines := strings.Split(content, "\n")
	start, end := tableBounds(lines, "features.multi_agent_v2")
	if start < 0 {
		featuresStart, featuresEnd := tableBounds(lines, "features")
		if featuresStart >= 0 {
			booleanPattern := regexp.MustCompile(`^(\s*)multi_agent_v2\s*=\s*(true|false)(\s*#.*)?$`)
			inlinePattern := regexp.MustCompile(`^(\s*)multi_agent_v2\s*=\s*\{([^}]*)\}(\s*#.*)?$`)
			threadPattern := regexp.MustCompile(`\bmax_concurrent_threads_per_session\s*=\s*\d+`)
			for index := featuresStart + 1; index < featuresEnd; index++ {
				if match := booleanPattern.FindStringSubmatch(lines[index]); match != nil {
					lines[index] = fmt.Sprintf("%smulti_agent_v2 = { enabled = %s, max_concurrent_threads_per_session = %d }%s", match[1], match[2], value, match[3])
					return true, atomicWriteFile(configPath, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
				}
				if match := inlinePattern.FindStringSubmatch(lines[index]); match != nil {
					body := strings.TrimSpace(match[2])
					if threadPattern.MatchString(body) {
						updated := threadPattern.ReplaceAllString(body, fmt.Sprintf("max_concurrent_threads_per_session = %d", value))
						if updated == body {
							return false, nil
						}
						body = updated
					} else {
						if body != "" {
							body += ", "
						}
						body += fmt.Sprintf("max_concurrent_threads_per_session = %d", value)
					}
					lines[index] = match[1] + "multi_agent_v2 = { " + body + " }" + match[3]
					return true, atomicWriteFile(configPath, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
				}
			}
		}
		if len(lines) > 0 && lines[len(lines)-1] != "" {
			lines = append(lines, "")
		}
		lines = append(lines, "[features.multi_agent_v2]", "enabled = true", fmt.Sprintf("max_concurrent_threads_per_session = %d", value))
		return true, atomicWriteFile(configPath, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
	}
	for index := start + 1; index < end; index++ {
		match := integerPattern.FindStringSubmatch(lines[index])
		if match == nil || match[1] != "max_concurrent_threads_per_session" {
			continue
		}
		if match[2] == strconv.Itoa(value) {
			return false, nil
		}
		lines[index] = strings.Repeat(" ", leadingWhitespace(lines[index])) + fmt.Sprintf("max_concurrent_threads_per_session = %d", value)
		if match[3] != "" {
			lines[index] += " " + match[3]
		}
		return true, atomicWriteFile(configPath, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
	}
	lines = append(lines[:start+1], append([]string{fmt.Sprintf("max_concurrent_threads_per_session = %d", value)}, lines[start+1:]...)...)
	return true, atomicWriteFile(configPath, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
}

// SetMultiAgentV2 migrates the active thread limit between v1 and v2 keys.
func SetMultiAgentV2(configPath string, enabled bool, threadLimit int) error {
	if threadLimit < 1 {
		return errors.New("thread limit must be >= 1")
	}
	original, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	if _, err = ToggleFeature(configPath, "multi_agent_v2", enabled); err != nil {
		return err
	}
	if enabled {
		_, err = SetMaxConcurrentThreads(configPath, threadLimit)
		if err == nil {
			err = removeTableKey(configPath, "agents", "max_threads")
		}
	} else {
		err = setTableInteger(configPath, "agents", "max_threads", threadLimit)
		if err == nil {
			err = removeMultiAgentThreadLimit(configPath)
		}
	}
	if err != nil {
		_ = atomicWriteFile(configPath, original, 0o600)
	}
	return err
}

func removeTableKey(path, table, key string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	content, eol := normalizeEOL(string(data))
	lines := strings.Split(content, "\n")
	start, end := tableBounds(lines, table)
	if start < 0 {
		return nil
	}
	pattern := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(key) + `\s*=`)
	for index := start + 1; index < end; index++ {
		if pattern.MatchString(lines[index]) {
			lines = append(lines[:index], lines[index+1:]...)
			return atomicWriteFile(path, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
		}
	}
	return nil
}

func removeMultiAgentThreadLimit(path string) error {
	if err := removeTableKey(path, "features.multi_agent_v2", "max_concurrent_threads_per_session"); err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	content, eol := normalizeEOL(string(data))
	lines := strings.Split(content, "\n")
	start, end := tableBounds(lines, "features")
	if start < 0 {
		return nil
	}
	inline := regexp.MustCompile(`^(\s*)multi_agent_v2\s*=\s*\{([^}]*)\}(\s*#.*)?$`)
	thread := regexp.MustCompile(`(?:^|,)\s*max_concurrent_threads_per_session\s*=\s*\d+\s*(?:,|$)`)
	for index := start + 1; index < end; index++ {
		match := inline.FindStringSubmatch(lines[index])
		if match == nil || !thread.MatchString(match[2]) {
			continue
		}
		body := strings.Trim(strings.TrimSpace(thread.ReplaceAllString(match[2], ",")), ", ")
		lines[index] = match[1] + "multi_agent_v2 = { " + body + " }" + match[3]
		return atomicWriteFile(path, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
	}
	return nil
}

func setTableInteger(path, table, key string, value int) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	content, eol := normalizeEOL(string(data))
	lines := strings.Split(content, "\n")
	start, end := tableBounds(lines, table)
	if start < 0 {
		if len(lines) > 0 && lines[len(lines)-1] != "" {
			lines = append(lines, "")
		}
		lines = append(lines, "["+table+"]", fmt.Sprintf("%s = %d", key, value))
	} else {
		for index := start + 1; index < end; index++ {
			match := integerPattern.FindStringSubmatch(lines[index])
			if match != nil && match[1] == key {
				lines[index] = fmt.Sprintf("%s = %d", key, value)
				return atomicWriteFile(path, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
			}
		}
		lines = append(lines[:start+1], append([]string{fmt.Sprintf("%s = %d", key, value)}, lines[start+1:]...)...)
	}
	return atomicWriteFile(path, []byte(applyEOL(strings.Join(lines, "\n"), eol)), 0o600)
}

func validateTOML(data []byte) error {
	var value map[string]any
	if err := toml.Unmarshal(data, &value); err != nil {
		return fmt.Errorf("parse Codex config: %w", err)
	}
	return nil
}

func tableBounds(lines []string, name string) (int, int) {
	start := -1
	for index, line := range lines {
		match := tableHeaderPattern.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		if start >= 0 {
			return start, index
		}
		if strings.TrimSpace(match[1]) == name {
			start = index
		}
	}
	return start, len(lines)
}

func leadingWhitespace(value string) int { return len(value) - len(strings.TrimLeft(value, " \t")) }

func normalizeEOL(content string) (string, string) {
	crlf := strings.Count(content, "\r\n")
	bareLF := strings.Count(content, "\n") - crlf
	eol := "\n"
	if crlf > 0 && crlf >= bareLF {
		eol = "\r\n"
	}
	return strings.ReplaceAll(content, "\r\n", "\n"), eol
}

func applyEOL(content, eol string) string {
	if eol == "\r\n" {
		return strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\n", "\r\n")
	}
	return strings.ReplaceAll(content, "\r\n", "\n")
}

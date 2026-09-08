package ocxcli

// v2_command.go — `ocx v2 status`, the Go-owned read surface of the v2 family
// (issue #56, slice v2a). The write verbs (on/off/mode/threads/keep-native-v1/
// mode-hint) keep the TypeScript owner behind the features.ts config-editing
// engine until v2b; OwnershipFor gates them out before this file runs.
//
// Oracle boundary (ADR-0009): the TypeScript reader prefers a full
// Bun.TOML.parse and falls back to the line scanners mirrored here. The Go side
// has no TOML parser, so it implements only the line scanners. The T1 parity
// rows therefore cover config.toml shapes where the two readers agree —
// dedicated `[features.multi_agent_v2]` tables, `[features]` boolean, dotted
// (multi_agent_v2.enabled) and inline forms, single-line basic/literal strings
// including `#` inside the value and `\U` escapes, and `[agents]` scalars with
// underscore digit separators. Documents only a full TOML parse can read
// correctly (quoted headers, values spanning lines inside a table, multiline
// strings, arrays) stay on the TypeScript-owned side until v2b.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// ---------------------------------------------------------------------------
// Codex config.toml location (mirror of src/codex/features.ts activeCodexConfigPath)
// ---------------------------------------------------------------------------

// codexConfigTomlPath resolves CODEX_HOME (env or ~/.codex) to its config.toml.
// Deliberately tolerant: unlike codexHomeFromEnv it does not require the
// directory to exist — every status reader treats a missing file as "unset".
func codexConfigTomlPath() string {
	raw := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if raw == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return filepath.Join(".codex", "config.toml")
		}
		return filepath.Join(home, ".codex", "config.toml")
	}
	if raw == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return raw
		}
		return filepath.Join(home, "config.toml")
	}
	if strings.HasPrefix(raw, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			raw = filepath.Join(home, raw[2:])
		}
	}
	return filepath.Join(raw, "config.toml")
}

func readCodexConfigToml() (string, bool) {
	content, err := os.ReadFile(codexConfigTomlPath())
	if err != nil {
		return "", false
	}
	return string(content), true
}

// ---------------------------------------------------------------------------
// Line-based TOML scanners (mirror of src/codex/features.ts tomlTableBody,
// tomlBoolInBody, and the readers that consume them)
// ---------------------------------------------------------------------------

// tomlTableBody returns the body lines of `[header]` up to the next table
// header, mirroring the TypeScript scanner: line-based and string-unaware, so
// it ends the table at the first line starting with `[` even inside a
// multi-line value. QuoteMeta escapes the header literally (the TS regexp
// leaves `.` unescaped; a config containing a header-shaped `[featuresX…]`
// line is outside the oracle boundary either way).
var tableHeaderRe = regexp.MustCompile(`^\s*\[([^\]]+)\]\s*(?:#.*)?$`)

func tomlTableBody(content, header string) (string, bool) {
	lines := strings.Split(content, "\n")
	start := -1
	for i, line := range lines {
		m := tableHeaderRe.FindStringSubmatch(line)
		if m != nil && m[1] == header {
			start = i
			break
		}
	}
	if start == -1 {
		return "", false
	}
	var body []string
	for _, line := range lines[start+1:] {
		if nextHeaderRe.MatchString(line) {
			break
		}
		body = append(body, line)
	}
	return strings.Join(body, "\n"), true
}

var nextHeaderRe = regexp.MustCompile(`^\s*\[`)

// tomlBoolInBody matches a whole-line `key = true|false` (trailing comment
// allowed), exactly like the TypeScript tomlBoolInBody.
func tomlBoolInBody(body, key string) (bool, bool) {
	re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(key) + `\s*=\s*(true|false)\s*(?:#.*)?$`)
	m := re.FindStringSubmatch(body)
	if m == nil {
		return false, false
	}
	return m[1] == "true", true
}

// tomlIntInBody matches a whole-line `key = <digits>` (underscores allowed,
// as in upstream 1_000) and returns the value.
func tomlIntInBody(body, key string) (int64, bool) {
	re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(key) + `\s*=\s*(-?[\d_]+)\s*(?:#.*)?$`)
	m := re.FindStringSubmatch(body)
	if m == nil {
		return 0, false
	}
	return parseInt(strings.ReplaceAll(m[1], "_", ""))
}

// tomlIntInBodyNoUnderscore mirrors the TS line scanners that stayed on plain
// `\d+` (getMaxConcurrentThreads) — underscore separators read as unset there.
func tomlIntInBodyNoUnderscore(body, key string) (int64, bool) {
	re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(key) + `\s*=\s*(\d+)\s*(?:#.*)?$`)
	m := re.FindStringSubmatch(body)
	if m == nil {
		return 0, false
	}
	return parseInt(m[1])
}

// tomlIntInBodySigned matches a whole-line `key = <signed digits>` with no
// underscore separators — the shape of the features.ts scanners that never
// went parse-first (getAgentsMaxDepth, which admits negatives but not `_`).
func tomlIntInBodySigned(body, key string) (int64, bool) {
	re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(key) + `\s*=\s*(-?\d+)\s*(?:#.*)?$`)
	m := re.FindStringSubmatch(body)
	if m == nil {
		return 0, false
	}
	return parseInt(m[1])
}

func parseInt(text string) (int64, bool) {
	var value int64
	_, err := fmt.Sscanf(text, "%d", &value)
	if err != nil {
		return 0, false
	}
	return value, true
}

// codexV2Sections captures where a multi_agent_v2 feature configuration can
// live, resolved once instead of re-locating the tables in every key lookup:
// the dedicated `[features.multi_agent_v2]` table body, the whole `[features]`
// body, and the content of an inline `multi_agent_v2 = { … }` entry under
// `[features]`. A missing table is distinct from an empty one.
type codexV2Sections struct {
	dedicated    string
	hasDedicated bool
	features     string
	inline       string // content inside multi_agent_v2 = { … } under [features]
}

func readCodexV2Sections(content string, ok bool) codexV2Sections {
	var s codexV2Sections
	if !ok {
		return s
	}
	s.dedicated, s.hasDedicated = tomlTableBody(content, "features.multi_agent_v2")
	features, hasFeatures := tomlTableBody(content, "features")
	if !hasFeatures {
		return s
	}
	s.features = features
	if m := regexp.MustCompile(`(?m)^\s*multi_agent_v2\s*=\s*\{([^}]*)\}`).FindStringSubmatch(features); m != nil {
		s.inline = m[1]
	}
	return s
}

// codexMultiAgentV2Enabled reports whether config.toml enables the
// multi_agent_v2 feature. Mirrors multiAgentV2EnabledFromConfigText's fallback
// path (the Bun.TOML.parse preference has no Go equivalent): dedicated
// `[features.multi_agent_v2]` table with `enabled`, then `[features]` boolean
// or inline-table forms. Missing file/key -> false.
func codexMultiAgentV2Enabled(content string, ok bool) bool {
	s := readCodexV2Sections(content, ok)
	if s.hasDedicated {
		enabled, ok := tomlBoolInBody(s.dedicated, "enabled")
		if ok {
			return enabled
		}
		return false
	}
	if s.features != "" {
		if enabled, ok := tomlBoolInBody(s.features, "multi_agent_v2"); ok {
			return enabled
		}
		// Dotted form: `[features] multi_agent_v2.enabled = true` parses to the
		// same nested value; the line scanners treat it as a sub-table line.
		dotted := regexp.MustCompile(`(?m)^\s*multi_agent_v2\.enabled\s*=\s*(true|false)\s*(?:#.*)?$`)
		if dm := dotted.FindStringSubmatch(s.features); dm != nil {
			return dm[1] == "true"
		}
		if s.inline != "" {
			enabled := regexp.MustCompile(`enabled\s*=\s*(true|false)`)
			if em := enabled.FindStringSubmatch(s.inline); em != nil {
				return em[1] == "true"
			}
		}
	}
	return false
}

// agentsMaxThreads / agentsEnabled / agentsMaxDepth read the legacy `[agents]`
// table (mirrors of getAgentsMaxThreads / getAgentsEnabled / getAgentsMaxDepth).
// maxDepth is bounded to the upstream i32 range and negative values are valid.

func codexAgentsBody(content string, ok bool) (string, bool) {
	if !ok {
		return "", false
	}
	return tomlTableBody(content, "agents")
}

func codexHasAgentsMaxThreads(content string, ok bool) bool {
	body, ok := codexAgentsBody(content, ok)
	if !ok {
		return false
	}
	re := regexp.MustCompile(`(?m)^\s*max_threads\s*=`)
	return re.MatchString(body)
}

func codexAgentsMaxThreads(content string, ok bool) (int64, bool) {
	body, bodyOK := codexAgentsBody(content, ok)
	if !bodyOK {
		return 0, false
	}
	value, found := tomlIntInBody(body, "max_threads")
	if !found || value < 1 {
		return 0, false
	}
	return value, true
}

// codexAgentsEnabled returns nil when unset (upstream default true applies);
// false is distinct from nil.
func codexAgentsEnabled(content string, ok bool) (enabled bool, set bool) {
	body, bodyOK := codexAgentsBody(content, ok)
	if !bodyOK {
		return false, false
	}
	return tomlBoolInBody(body, "enabled")
}

func codexAgentsMaxDepth(content string, ok bool) (int64, bool) {
	body, bodyOK := codexAgentsBody(content, ok)
	if !bodyOK {
		return 0, false
	}
	// getAgentsMaxDepth in features.ts is scanner-only (plain `-?\d+`, no
	// parse-first refactor like getAgentsMaxThreads), so underscore digit
	// separators read as unset there — mirrored here.
	value, found := tomlIntInBodySigned(body, "max_depth")
	if !found || value < -2147483648 || value > 2147483647 {
		return 0, false
	}
	return value, true
}

// codexMaxConcurrentThreads reads `features.multi_agent_v2.max_concurrent_
// threads_per_session` from either the dedicated or inline-table form. The TS
// reader for THIS key is still line-scanner-only (features.ts
// getMaxConcurrentThreads, unlike the `[agents]` readers, never went through
// the parse-first refactor), so it cannot see underscore digit separators —
// the Go side mirrors that shape: `max_concurrent_threads_per_session =
// 3_000` reads as unset on both sides.
func codexMaxConcurrentThreads(content string, ok bool) (int64, bool) {
	s := readCodexV2Sections(content, ok)
	if s.hasDedicated {
		if value, found := tomlIntInBodyNoUnderscore(s.dedicated, "max_concurrent_threads_per_session"); found && value >= 1 {
			return value, true
		}
		return 0, false
	}
	if s.inline != "" {
		entry := regexp.MustCompile(`(?:^|,)\s*max_concurrent_threads_per_session\s*=\s*(\d+)\s*(?:,|$)`)
		if em := entry.FindStringSubmatch(s.inline); em != nil {
			if value, err := parseInt(em[1]); err {
				return value, value >= 1
			}
		}
	}
	return 0, false
}

// Thread-limit translation across the root-agent slot (mirror of features.ts
// v1ChildLimitToV2TotalLimit / v2TotalLimitToV1ChildLimit): upstream counts the
// root agent inside the V2 total but not inside the legacy `[agents]` limit.
const maxTranslatableV1ChildLimit = 1_000_000
const maxTranslatableV2TotalLimit = 1_000_001

func codexLogicalMaxThreads(content string, ok bool) (int64, bool) {
	if codexMultiAgentV2Enabled(content, ok) {
		if v2, found := codexMaxConcurrentThreads(content, ok); found {
			return v2, true
		}
		legacy, found := codexAgentsMaxThreads(content, ok)
		if !found {
			return 0, false
		}
		if legacy >= 1 && legacy <= maxTranslatableV1ChildLimit {
			return legacy + 1, true
		}
		return legacy, true
	}
	legacy, found := codexAgentsMaxThreads(content, ok)
	if found {
		return legacy, true
	}
	v2, found := codexMaxConcurrentThreads(content, ok)
	if !found {
		return 0, false
	}
	if v2 >= 1 && v2 <= maxTranslatableV2TotalLimit {
		if v2 <= 1 {
			return 1, true
		}
		return v2 - 1, true
	}
	return v2, true
}

// codexV2StringField reads a single-line string field under
// features.multi_agent_v2 (dedicated table or inline `[features]` form).
// Supports basic ("…") and literal ('…') strings with quote-aware token
// scanning: a `#` inside a string is data, not a comment, and basic strings
// may escape their quote. Multiline and quoted-key shapes are outside the v2a
// oracle boundary and read as unset.
func codexV2StringField(key, content string, ok bool) (string, bool) {
	if !ok {
		return "", false
	}
	readEntry := func(body string) (string, bool) {
		// Locate `key =` (whole line in a table body, or a comma-separated
		// entry inside an inline table) and slice the value token with a
		// quote-aware scanner; decodeTomlStringToken then rejects anything
		// that is not a supported single-line string form.
		re := regexp.MustCompile(`(?m)(?:^|,\s*)` + regexp.QuoteMeta(key) + `\s*=\s*`)
		loc := re.FindStringIndex(body)
		if loc == nil {
			return "", false
		}
		token, found := scanTomlValueToken(body[loc[1]:])
		if !found {
			return "", false
		}
		return decodeTomlStringToken(token)
	}
	s := readCodexV2Sections(content, ok)
	if s.hasDedicated {
		return readEntry(s.dedicated)
	}
	if s.inline != "" {
		return readEntry(s.inline)
	}
	return "", false
}

// scanTomlValueToken slices a single-line TOML value token from text, which
// starts immediately after the `=` of an assignment. Basic strings scan to
// their closing quote honouring backslash escapes, literal strings to their
// closing quote honouring `”` doubling; a `#` or end of line/entry after the
// closing quote is left to the caller. Anything else (bare scalars) is
// reported as not-found — no string field can legally hold one.
func scanTomlValueToken(text string) (string, bool) {
	text = strings.TrimLeft(text, " \t")
	if text == "" {
		return "", false
	}
	switch text[0] {
	case '\'':
		// Multiline literal (`'''…'''`) is outside the v2a oracle boundary;
		// scanning it as single-line would misread the doubled quote.
		if strings.HasPrefix(text, "'''") {
			return "", false
		}
		// Mirror the TS scanner (scanTomlValueEnd): a literal string ends at
		// the FIRST following single quote — `''` is not folded into an
		// escaped apostrophe by the reader, so `'it''s here'` reads as `it`.
		if close := strings.IndexByte(text[1:], '\''); close >= 0 {
			return text[:close+2], true
		}
		return "", false
	case '"':
		// Multiline basic (`"""…"""`) is outside the v2a oracle boundary.
		if strings.HasPrefix(text, "\"\"\"") {
			return "", false
		}
		// Basic string: honour backslash escapes while hunting the close.
		for i := 1; i < len(text); i++ {
			if text[i] == '\\' {
				i++
				continue
			}
			if text[i] == '"' {
				return text[:i+1], true
			}
		}
		return "", false
	default:
		return "", false
	}
}

// decodeTomlStringToken decodes a basic or literal TOML single-line string.
func decodeTomlStringToken(token string) (string, bool) {
	if len(token) < 2 {
		return "", false
	}
	// Literal single-line string: no escapes; the TS scanner ends the token
	// at the first following quote, so the body carries no doubled quotes.
	if token[0] == '\'' && token[len(token)-1] == '\'' {
		return token[1 : len(token)-1], true
	}
	if token[0] == '"' && token[len(token)-1] == '"' {
		body := token[1 : len(token)-1]
		var out strings.Builder
		for i := 0; i < len(body); i++ {
			if body[i] != '\\' {
				out.WriteByte(body[i])
				continue
			}
			i++
			if i >= len(body) {
				return "", false
			}
			switch body[i] {
			case 'n':
				out.WriteByte('\n')
			case 't':
				out.WriteByte('\t')
			case 'r':
				out.WriteByte('\r')
			case 'b':
				out.WriteByte('\b')
			case 'f':
				out.WriteByte('\f')
			case '"':
				out.WriteByte('"')
			case '\\':
				out.WriteByte('\\')
			case 'u':
				if i+4 >= len(body) {
					return "", false
				}
				var r rune
				if _, err := fmt.Sscanf(body[i+1:i+5], "%04x", &r); err != nil {
					return "", false
				}
				out.WriteRune(r)
				i += 4
			case 'U':
				if i+8 >= len(body) {
					return "", false
				}
				var r rune
				if _, err := fmt.Sscanf(body[i+1:i+9], "%08x", &r); err != nil {
					return "", false
				}
				out.WriteRune(r)
				i += 8
			default:
				return "", false
			}
		}
		return out.String(), true
	}
	return "", false
}

// ---------------------------------------------------------------------------
// OpenCodex config.json reads (ports of v2.ts loadConfig projections)
// ---------------------------------------------------------------------------

// opencodexConfigStringField reads a top-level string key from the opencodex
// config via the order-preserving loader, so unknown keys survive.
func opencodexConfigStringField(key string) (string, bool) {
	cfg, err := config.LoadOrdered()
	if err != nil || cfg == nil {
		return "", false
	}
	value := cfg.Find(key)
	if value == nil {
		return "", false
	}
	return value.StringValue()
}

// opencodexConfigBoolField reads a top-level boolean key from the raw config
// document (the ordered loader keeps string nodes readable but exposes no bool
// accessor); absent or non-boolean -> false. Reuses the BOM-aware raw reader
// shared with the client-state surface rather than parsing the file afresh.
func opencodexConfigBoolField(key string) bool {
	doc, ok := readRawTopLevelConfig()
	if !ok {
		return false
	}
	value, ok := doc[key].(bool)
	return ok && value
}

// ---------------------------------------------------------------------------
// `ocx v2 status`
// ---------------------------------------------------------------------------

func runV2Status(args []string, deps Deps) int {
	content, ok := readCodexConfigToml()
	v2Enabled := codexMultiAgentV2Enabled(content, ok)

	// multi_agent_v2 feature line.
	if v2Enabled {
		fmt.Fprintln(deps.Stdout, "multi_agent_v2: ON — global V2 override active")
	} else {
		fmt.Fprintln(deps.Stdout, "multi_agent_v2: OFF — model catalog pins and defaults decide the surface")
	}

	// multi_agent_mode + keep_native_chatgpt_on_v1 come from the opencodex
	// config.json (routing-level pins the Go config schema does not own).
	mode, modeSet := opencodexConfigStringField("multiAgentMode")
	if !modeSet {
		mode = "default"
	}
	keepNativeV1 := opencodexConfigBoolField("keepNativeChatGptOnV1")

	switch mode {
	case "v1":
		fmt.Fprintln(deps.Stdout, "multi_agent_mode: v1 — ALL models forced to v1 surface (upstream pins overridden)")
	case "v2":
		if keepNativeV1 {
			fmt.Fprintln(deps.Stdout, "multi_agent_mode: v2 hybrid — ChatGPT-native models use v1; routed models use v2")
		} else {
			fmt.Fprintln(deps.Stdout, "multi_agent_mode: v2 — ALL models forced to v2 surface (upstream pins overridden)")
		}
	default:
		fmt.Fprintln(deps.Stdout, "multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)")
	}

	if keepNativeV1 {
		if mode == "v2" && v2Enabled {
			fmt.Fprintln(deps.Stdout, "keep_native_chatgpt_on_v1: CONFLICT — global multi_agent_v2 overrides the native v1 catalog pin; run 'ocx v2 keep-native-v1 on' to reconcile")
		} else {
			fmt.Fprintln(deps.Stdout, "keep_native_chatgpt_on_v1: ON — global V2 override is off; ChatGPT-native rows use v1 and routed rows use v2 when mode is v2")
		}
	} else {
		fmt.Fprintln(deps.Stdout, "keep_native_chatgpt_on_v1: OFF")
	}

	if threads, found := codexLogicalMaxThreads(content, ok); found {
		fmt.Fprintf(deps.Stdout, "max_threads: %d\n", threads)
	} else {
		fmt.Fprintln(deps.Stdout, "max_threads: (unset — codex default)")
	}

	if enabled, set := codexAgentsEnabled(content, ok); set {
		fmt.Fprintf(deps.Stdout, "agents.enabled: %t\n", enabled)
	} else {
		fmt.Fprintln(deps.Stdout, "agents.enabled: (unset — upstream default true)")
	}

	if depth, found := codexAgentsMaxDepth(content, ok); found {
		if v2Enabled {
			fmt.Fprintf(deps.Stdout, "agents.max_depth: %d (V1-only — ignored while multi_agent_v2 is enabled)\n", depth)
		} else {
			fmt.Fprintf(deps.Stdout, "agents.max_depth: %d\n", depth)
		}
	} else {
		if v2Enabled {
			fmt.Fprintln(deps.Stdout, "agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)")
		} else {
			fmt.Fprintln(deps.Stdout, "agents.max_depth: (unset — upstream default 1)")
		}
	}

	if instructions, found := codexV2StringField("subagent_developer_instructions", content, ok); found {
		if instructions == "" {
			fmt.Fprintln(deps.Stdout, `subagent_developer_instructions: "" (clears inherited instructions)`)
		} else {
			encoded, err := config.JSONStringifyString(instructions)
			if err == nil {
				fmt.Fprintf(deps.Stdout, "subagent_developer_instructions: %s\n", encoded)
			} else {
				fmt.Fprintf(deps.Stdout, "subagent_developer_instructions: %q\n", instructions)
			}
		}
	} else {
		fmt.Fprintln(deps.Stdout, "subagent_developer_instructions: (unset — children inherit)")
	}

	if hint, found := codexV2StringField("multi_agent_mode_hint_text", content, ok); found {
		encoded, err := config.JSONStringifyString(hint)
		if err == nil {
			fmt.Fprintf(deps.Stdout, "multi_agent_mode_hint_text: %s\n", encoded)
		} else {
			fmt.Fprintf(deps.Stdout, "multi_agent_mode_hint_text: %q\n", hint)
		}
	} else {
		fmt.Fprintln(deps.Stdout, "multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)")
	}

	if v2Enabled && codexHasAgentsMaxThreads(content, ok) {
		fmt.Fprintln(deps.Stdout, "WARNING: [agents] max_threads is set — codex refuses to start while multi_agent_v2 is enabled. Remove it from config.toml (concurrency lives in features.multi_agent_v2.max_concurrent_threads_per_session).")
	}
	return ExitOK
}

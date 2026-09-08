package ocxcli

// v2_edit.go — scalar write primitives for the `ocx v2` write surface (issue
// #56, slice v2b). Byte mirror of the format-preserving config.toml editor in
// src/codex/features.ts (setMaxConcurrentThreads / editAgentsMaxThreads /
// editScalarInTable and their string-aware scanners). Every write preserves the
// original EOL style and trailing comments. The upstream `codex features`
// CLI owns the enabled-flag flip; this file owns what ocx writes directly.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ---------------------------------------------------------------------------
// EOL / comment helpers (mirrors of dominantEol / applyEol /
// mergeTrailingComments)
// ---------------------------------------------------------------------------

func dominantEol(content string) string {
	crlf := strings.Count(content, "\r\n")
	if crlf == 0 {
		return "\n"
	}
	bareLf := strings.Count(content, "\n") - crlf
	if crlf >= bareLf {
		return "\r\n"
	}
	return "\n"
}

func applyEol(content, eol string) string {
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	if eol == "\n" {
		return normalized
	}
	return strings.ReplaceAll(normalized, "\n", "\r\n")
}

// mergeTrailingComments joins an existing trailing comment with a migration
// comment: identical text collapses, an already-present migrated text is not
// duplicated, otherwise the migrated comment (leading `#` stripped) is
// appended after "; ".
func mergeTrailingComments(existing, migrated string) string {
	if existing == "" {
		return migrated
	}
	if migrated == "" || strings.TrimSpace(existing) == strings.TrimSpace(migrated) {
		return existing
	}
	stripHash := regexp.MustCompile(`^\s*#\s*`)
	migratedText := stripHash.ReplaceAllString(migrated, "")
	existingParts := strings.Split(stripHash.ReplaceAllString(existing, ""), ";")
	for _, part := range existingParts {
		if strings.TrimSpace(part) == strings.TrimSpace(migratedText) {
			return existing
		}
	}
	return existing + "; " + migratedText
}

// splitCodexLines mirrors `content.split(/\r?\n/)`: the regex drops a \r, a
// trailing newline leaves a final empty element, empty content yields [""].
func splitCodexLines(content string) []string {
	return regexp.MustCompile(`\r?\n`).Split(content, -1)
}

// readCodexConfigTextAt reads configPath (empty = active CODEX_HOME) like
// readConfigText.
func readCodexConfigTextAt(configPath string) (string, bool) {
	path := configPath
	if path == "" {
		path = codexConfigTomlPath()
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(content), true
}

// ---------------------------------------------------------------------------
// Atomic text write (features.ts atomicWriteFile shape; config.toml carries no
// secrets, so the windows-secret memo is not needed)
// ---------------------------------------------------------------------------

func atomicWriteTextFile(path, content string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".config-toml-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.WriteString(content); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, path)
}

// ---------------------------------------------------------------------------
// String-aware value scanners (mirrors of scanTomlValueEnd / findInlineTableEnd
// / findTomlAssignment / findInlineEntry / isMultilineTomlString /
// hasInlineMultilineTomlString)
// ---------------------------------------------------------------------------

// scanTomlValueEnd returns the exclusive end index of the TOML value starting
// at or after start in text. String-aware: basic strings honour backslash
// escapes, literal strings do not; inline tables and arrays nest.
func scanTomlValueEnd(text string, start int) int {
	i := start
	for i < len(text) && (text[i] == ' ' || text[i] == '\t') {
		i++
	}
	if i >= len(text) {
		return len(text)
	}
	switch text[i] {
	case '"':
		if i+2 < len(text) && text[i+1] == '"' && text[i+2] == '"' {
			i += 3
			for i < len(text) {
				if text[i] == '\\' {
					i += 2
					continue
				}
				if text[i] == '"' && i+2 < len(text) && text[i+1] == '"' && text[i+2] == '"' {
					end := i + 3
					for end < len(text) && text[end] == '"' && end < i+5 {
						end++
					}
					return end
				}
				i++
			}
			return len(text)
		}
		i++
		for i < len(text) {
			if text[i] == '\\' {
				i += 2
				continue
			}
			if text[i] == '"' {
				return i + 1
			}
			i++
		}
		return len(text)
	case '\'':
		if i+2 < len(text) && text[i+1] == '\'' && text[i+2] == '\'' {
			i += 3
			for i < len(text) {
				if text[i] == '\'' && i+2 < len(text) && text[i+1] == '\'' && text[i+2] == '\'' {
					end := i + 3
					for end < len(text) && text[end] == '\'' && end < i+5 {
						end++
					}
					return end
				}
				i++
			}
			return len(text)
		}
		if close := strings.IndexByte(text[i+1:], '\''); close >= 0 {
			return i + 1 + close + 1
		}
		return len(text)
	case '{':
		if close := findInlineTableEnd(text, i); close >= 0 {
			return close + 1
		}
		return len(text)
	case '[':
		depth := 0
		for i < len(text) {
			c := text[i]
			if c == '"' || c == '\'' {
				i = scanTomlValueEnd(text, i)
				continue
			}
			if c == '[' {
				depth++
			} else if c == ']' {
				depth--
				if depth == 0 {
					return i + 1
				}
			}
			i++
		}
		return len(text)
	default:
		for i < len(text) {
			c := text[i]
			if c == ' ' || c == '\t' || c == ',' || c == '}' || c == ']' || c == '#' {
				break
			}
			i++
		}
		return i
	}
}

// findInlineTableEnd returns the index of the `}` matching the `{` at openIdx,
// string-aware, or -1.
func findInlineTableEnd(text string, openIdx int) int {
	depth := 0
	i := openIdx
	for i < len(text) {
		c := text[i]
		if c == '"' || c == '\'' {
			i = scanTomlValueEnd(text, i)
			continue
		}
		if c == '{' {
			depth++
		} else if c == '}' {
			depth--
			if depth == 0 {
				return i
			}
		}
		i++
	}
	return -1
}

type tomlInlineEntry struct {
	keyStart   int
	valueStart int
	valueEnd   int
}

type inlineDigitsEntry struct {
	keyStart int // start of the bare key text within the inline body
	valStart int // first digit of the value
	valEnd   int // exclusive end of the digits
}

func isBareTomlKeyByte(c byte) bool {
	return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-'
}

// findInlineDigitsEntry locates `key = <digits>` inside an inline-table body.
// Like the TS `(?:^|,)\s*key\s*=\s*(\d+)\s*(?=,|$)`, the digits must be
// followed by a comma or the body end; a non-numeric value for key is skipped
// and a trailing non-comma is treated as not-an-entry.
func findInlineDigitsEntry(body, key string) *inlineDigitsEntry {
	i := 0
	for i < len(body) {
		for i < len(body) && (body[i] == ' ' || body[i] == '\t' || body[i] == ',') {
			i++
		}
		keyStart := i
		for i < len(body) && isBareTomlKeyByte(body[i]) {
			i++
		}
		keyText := body[keyStart:i]
		for i < len(body) && (body[i] == ' ' || body[i] == '\t') {
			i++
		}
		if keyText != key || i >= len(body) || body[i] != '=' {
			for i < len(body) && body[i] != ',' {
				i++
			}
			continue
		}
		i++
		for i < len(body) && (body[i] == ' ' || body[i] == '\t') {
			i++
		}
		valStart := i
		for i < len(body) && body[i] >= '0' && body[i] <= '9' {
			i++
		}
		if valStart == i {
			for i < len(body) && body[i] != ',' {
				i++
			}
			continue
		}
		// TS lookahead: the digits must be followed by a comma or body end.
		j := i
		for j < len(body) && (body[j] == ' ' || body[j] == '\t') {
			j++
		}
		if j < len(body) && body[j] != ',' {
			for i < len(body) && body[i] != ',' {
				i++
			}
			continue
		}
		return &inlineDigitsEntry{keyStart: keyStart, valStart: valStart, valEnd: i}
	}
	return nil
}

var bareTomlKeyRe = regexp.MustCompile(`^[A-Za-z0-9_-]+`)

// findTomlAssignment locates a top-level `key = value` assignment in text
// while skipping complete (possibly multiline) values.
func findTomlAssignment(text, key string) *tomlInlineEntry {
	lineStart := 0
	for lineStart < len(text) {
		i := lineStart
		for i < len(text) && (text[i] == ' ' || text[i] == '\t') {
			i++
		}
		keyStart := i
		var keyText string
		if i < len(text) && (text[i] == '"' || text[i] == '\'') {
			keyEnd := scanTomlValueEnd(text, i)
			if decoded, ok := decodeTomlStringToken(text[i:keyEnd]); ok {
				keyText = decoded
			}
			i = keyEnd
		} else if m := bareTomlKeyRe.FindString(text[i:]); m != "" {
			keyText = m
			i += len(m)
		}
		for i < len(text) && (text[i] == ' ' || text[i] == '\t') {
			i++
		}
		if keyText != "" && i < len(text) && text[i] == '=' {
			valueStart := i + 1
			valueEnd := scanTomlValueEnd(text, valueStart)
			if keyText == key {
				return &tomlInlineEntry{keyStart: keyStart, valueStart: valueStart, valueEnd: valueEnd}
			}
			lineStart = nextCodexLine(text, valueEnd)
			continue
		}
		lineStart = nextCodexLine(text, lineStart)
	}
	return nil
}

// nextCodexLine returns the index just past the next newline at or after pos,
// or len(text).
func nextCodexLine(text string, pos int) int {
	if rel := strings.IndexByte(text[pos:], '\n'); rel >= 0 {
		return pos + rel + 1
	}
	return len(text)
}

// findInlineEntry locates `key = value` inside an inline-table body spanning
// [bodyStart, bodyEnd), string-aware on keys and values, or nil.
func findInlineEntry(text string, bodyStart, bodyEnd int, key string) *tomlInlineEntry {
	i := bodyStart
	for i < bodyEnd {
		for i < bodyEnd && (text[i] == ' ' || text[i] == '\t' || text[i] == ',') {
			i++
		}
		if i >= bodyEnd {
			break
		}
		entryStart := i
		var keyText string
		if text[i] == '"' || text[i] == '\'' {
			keyEnd := scanTomlValueEnd(text, i)
			if decoded, ok := decodeTomlStringToken(text[i:keyEnd]); ok {
				keyText = decoded
			}
			i = keyEnd
		} else {
			m := bareTomlKeyRe.FindString(text[i:bodyEnd])
			if m == "" {
				break
			}
			keyText = m
			i += len(m)
		}
		for i < bodyEnd && (text[i] == ' ' || text[i] == '\t') {
			i++
		}
		if i >= bodyEnd || text[i] != '=' {
			i = entryStart + 1
			continue
		}
		i++
		for i < bodyEnd && (text[i] == ' ' || text[i] == '\t') {
			i++
		}
		valueStart := i
		valueEnd := scanTomlValueEnd(text, valueStart)
		if valueEnd > bodyEnd {
			valueEnd = bodyEnd
		}
		if keyText == key {
			return &tomlInlineEntry{keyStart: entryStart, valueStart: valueStart, valueEnd: valueEnd}
		}
		i = valueEnd
	}
	return nil
}

func isMultilineTomlString(text string, valueStart int) bool {
	start := valueStart
	for start < len(text) && (text[start] == ' ' || text[start] == '\t') {
		start++
	}
	return strings.HasPrefix(text[start:], `"""`) || strings.HasPrefix(text[start:], `'''`)
}

func hasInlineMultilineTomlString(text string, assignment *tomlInlineEntry, key string) bool {
	openIdx := assignment.valueStart
	for openIdx < len(text) && (text[openIdx] == ' ' || text[openIdx] == '\t') {
		openIdx++
	}
	if openIdx >= len(text) || text[openIdx] != '{' {
		return false
	}
	closeIdx := findInlineTableEnd(text, openIdx)
	if closeIdx == -1 {
		return false
	}
	entry := findInlineEntry(text, openIdx+1, closeIdx, key)
	return entry != nil && isMultilineTomlString(text, entry.valueStart)
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

// encodeTomlBasicString mirrors encodeTomlBasicString: single-line basic-string
// encoding, character by character (control bytes below 0x20 and 0x7f become
// \uXXXX).
func encodeTomlBasicString(value string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '\\':
			out.WriteString(`\\`)
		case '"':
			out.WriteString(`\"`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		default:
			if r < 0x20 || r == 0x7f {
				fmt.Fprintf(&out, `\u%04x`, r)
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
	return out.String()
}

// ---------------------------------------------------------------------------
// Scalar table editor (editScalarInTable mirror)
// ---------------------------------------------------------------------------

// editScalarInTable sets or removes one scalar key inside a top-level TOML
// table, preserving every other line byte-for-byte including the existing
// value's trailing comment. encoded is the serialized RHS; remove=true deletes
// the key. Returns the new content; returning the input unchanged means no-op.
func editScalarInTable(content, table, key, encoded string, remove bool) string {
	eol := dominantEol(content)
	lines := splitCodexLines(content)
	headerRe := regexp.MustCompile(`^\s*\[` + regexp.QuoteMeta(table) + `\]\s*(?:#.*)?$`)
	headerIdx := -1
	for i, line := range lines {
		if headerRe.MatchString(line) {
			headerIdx = i
			break
		}
	}
	if headerIdx == -1 {
		if remove {
			return content
		}
		if lines[len(lines)-1] != "" {
			lines = append(lines, "")
		}
		lines = append(lines, "["+table+"]", key+" = "+encoded)
		return applyEol(strings.Join(lines, "\n"), eol)
	}
	end := len(lines)
	for i := headerIdx + 1; i < len(lines); i++ {
		if nextHeaderRe.MatchString(lines[i]) {
			end = i
			break
		}
	}
	for i := headerIdx + 1; i < end; i++ {
		entry := findTomlAssignment(lines[i], key)
		if entry == nil {
			continue
		}
		line := lines[i]
		trailing := line[entry.valueEnd:]
		if remove {
			lines = append(lines[:i], lines[i+1:]...)
			return applyEol(strings.Join(lines, "\n"), eol)
		}
		if strings.TrimSpace(line[entry.valueStart:entry.valueEnd]) == encoded {
			return content
		}
		lines[i] = line[:entry.keyStart] + key + " = " + encoded + trailing
		return applyEol(strings.Join(lines, "\n"), eol)
	}
	if remove {
		return content
	}
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:headerIdx+1]...)
	out = append(out, key+" = "+encoded)
	out = append(out, lines[headerIdx+1:]...)
	return applyEol(strings.Join(out, "\n"), eol)
}

// ---------------------------------------------------------------------------
// Numeric editors (setMaxConcurrentThreads / editAgentsMaxThreads /
// removeMaxConcurrentThreads / ensureDisabledV2Config mirrors)
// ---------------------------------------------------------------------------

type codexEditResult struct {
	ok      bool
	changed bool
	err     string
}

func codexEditError(errText string) codexEditResult {
	return codexEditResult{err: errText}
}

var featuresHeaderRe = regexp.MustCompile(`^\s*\[features\]\s*(?:#.*)?$`)
var agentsHeaderRe = regexp.MustCompile(`^\s*\[agents\]\s*(?:#.*)?$`)
var v2HeaderRe = regexp.MustCompile(`^\s*\[features\.multi_agent_v2\]\s*(?:#.*)?$`)
var v2BoolLineRe = regexp.MustCompile(`^(\s*)multi_agent_v2\s*=\s*(true|false)(\s*#.*)?$`)
var v2InlineLineRe = regexp.MustCompile(`^(\s*)multi_agent_v2\s*=\s*\{([^}]*)\}(\s*#.*)?$`)
var v2ThreadLineRe = regexp.MustCompile(`^(\s*)max_concurrent_threads_per_session\s*=\s*(\d+)(\s*#.*)?$`)
var agentsThreadLineRe = regexp.MustCompile(`^(\s*)max_threads\s*=\s*(\d+)(\s*#.*)?$`)

func findTableHeader(lines []string, headerRe *regexp.Regexp) int {
	for i, line := range lines {
		if headerRe.MatchString(line) {
			return i
		}
	}
	return -1
}

func tableBodyEnd(lines []string, headerIdx int) int {
	end := len(lines)
	for i := headerIdx + 1; i < len(lines); i++ {
		if nextHeaderRe.MatchString(lines[i]) {
			return i
		}
	}
	return end
}

// setCodexMaxConcurrentThreads mirrors setMaxConcurrentThreads: writes
// features.multi_agent_v2.max_concurrent_threads_per_session in whichever
// supported shape exists — dedicated table, [features] inline table, or
// [features] boolean upgraded in place.
func setCodexMaxConcurrentThreads(value int64, configPath, migratedComment string) codexEditResult {
	if value < 1 {
		return codexEditError("max_concurrent_threads_per_session must be an integer >= 1")
	}
	path := configPath
	if path == "" {
		path = codexConfigTomlPath()
	}
	content, ok := readCodexConfigTextAt(path)
	if !ok {
		return codexEditError(fmt.Sprintf("config.toml not readable at %s", path))
	}
	eol := dominantEol(content)
	lines := splitCodexLines(content)
	write := func() codexEditResult {
		if err := atomicWriteTextFile(path, applyEol(strings.Join(lines, "\n"), eol)); err != nil {
			return codexEditError(err.Error())
		}
		return codexEditResult{ok: true, changed: true}
	}
	valueText := fmt.Sprint(value)

	headerIdx := findTableHeader(lines, v2HeaderRe)
	if headerIdx == -1 {
		featuresHeader := findTableHeader(lines, featuresHeaderRe)
		if featuresHeader == -1 {
			return codexEditError("multi_agent_v2 feature config not found — enable v2 first (ocx v2 on)")
		}
		featuresEnd := tableBodyEnd(lines, featuresHeader)
		for i := featuresHeader + 1; i < featuresEnd; i++ {
			if m := v2BoolLineRe.FindStringSubmatch(lines[i]); m != nil {
				lines[i] = m[1] + "multi_agent_v2 = { enabled = " + m[2] +
					", max_concurrent_threads_per_session = " + valueText + " }" +
					mergeTrailingComments(m[3], migratedComment)
				return write()
			}
			inline := v2InlineLineRe.FindStringSubmatch(lines[i])
			if inline == nil {
				continue
			}
			body := inline[2]
			entry := findInlineDigitsEntry(body, "max_concurrent_threads_per_session")
			if entry != nil {
				if body[entry.valStart:entry.valEnd] == valueText && (migratedComment == "" || migratedComment == inline[3]) {
					return codexEditResult{ok: true}
				}
				// Mirror the TS replacement `$1 max_concurrent_threads_per_session
				// = value`: the separator (start-of-body or the last comma) is
				// kept, followed by exactly one space and the rewritten key; the
				// digit tail (and any spaces up to the next comma/end) is kept.
				head := body[:entry.keyStart]
				tail := strings.TrimLeft(body[entry.valEnd:], " \t")
				var rebuilt string
				if comma := strings.LastIndexByte(head, ','); comma >= 0 {
					rebuilt = head[:comma] + ", max_concurrent_threads_per_session = " + valueText + tail
				} else {
					rebuilt = "max_concurrent_threads_per_session = " + valueText + tail
				}
				body = strings.TrimSpace(rebuilt)
			} else {
				trimmed := strings.TrimSpace(body)
				if trimmed != "" {
					trimmed += ", "
				}
				body = trimmed + "max_concurrent_threads_per_session = " + valueText
			}
			lines[i] = inline[1] + "multi_agent_v2 = { " + strings.TrimSpace(body) + " }" +
				mergeTrailingComments(inline[3], migratedComment)
			return write()
		}
		return codexEditError("multi_agent_v2 feature config not found — enable v2 first (ocx v2 on)")
	}

	end := tableBodyEnd(lines, headerIdx)
	for i := headerIdx + 1; i < end; i++ {
		m := v2ThreadLineRe.FindStringSubmatch(lines[i])
		if m == nil {
			continue
		}
		if m[2] == valueText && (migratedComment == "" || migratedComment == m[3]) {
			return codexEditResult{ok: true}
		}
		lines[i] = m[1] + "max_concurrent_threads_per_session = " + valueText +
			mergeTrailingComments(m[3], migratedComment)
		return write()
	}
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:headerIdx+1]...)
	out = append(out, "max_concurrent_threads_per_session = "+valueText+migratedComment)
	out = append(out, lines[headerIdx+1:]...)
	lines = out
	return write()
}

// editCodexAgentsMaxThreads mirrors editAgentsMaxThreads: writes or removes
// [agents] max_threads, creating the table when absent.
func editCodexAgentsMaxThreads(value int64, remove bool, configPath, migratedComment string) codexEditResult {
	path := configPath
	if path == "" {
		path = codexConfigTomlPath()
	}
	content, ok := readCodexConfigTextAt(path)
	if !ok {
		return codexEditError(fmt.Sprintf("config.toml not readable at %s", path))
	}
	eol := dominantEol(content)
	lines := splitCodexLines(content)
	write := func() codexEditResult {
		if err := atomicWriteTextFile(path, applyEol(strings.Join(lines, "\n"), eol)); err != nil {
			return codexEditError(err.Error())
		}
		return codexEditResult{ok: true, changed: true}
	}
	valueText := fmt.Sprint(value)

	headerIdx := findTableHeader(lines, agentsHeaderRe)
	if headerIdx == -1 {
		if remove {
			return codexEditResult{ok: true}
		}
		if lines[len(lines)-1] != "" {
			lines = append(lines, "")
		}
		lines = append(lines, "[agents]", "max_threads = "+valueText+migratedComment)
		return write()
	}
	end := tableBodyEnd(lines, headerIdx)
	for i := headerIdx + 1; i < end; i++ {
		m := agentsThreadLineRe.FindStringSubmatch(lines[i])
		if m == nil {
			continue
		}
		if remove {
			lines = append(lines[:i], lines[i+1:]...)
		} else if m[2] == valueText && (migratedComment == "" || migratedComment == m[3]) {
			return codexEditResult{ok: true}
		} else {
			lines[i] = m[1] + "max_threads = " + valueText + mergeTrailingComments(m[3], migratedComment)
		}
		return write()
	}
	if remove {
		return codexEditResult{ok: true}
	}
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:headerIdx+1]...)
	out = append(out, "max_threads = "+valueText+migratedComment)
	out = append(out, lines[headerIdx+1:]...)
	lines = out
	return write()
}

// removeCodexMaxConcurrentThreads mirrors removeMaxConcurrentThreads: deletes
// max_concurrent_threads_per_session from the dedicated table or the [features]
// inline form.
func removeCodexMaxConcurrentThreads(configPath string) codexEditResult {
	path := configPath
	if path == "" {
		path = codexConfigTomlPath()
	}
	content, ok := readCodexConfigTextAt(path)
	if !ok {
		return codexEditError(fmt.Sprintf("config.toml not readable at %s", path))
	}
	eol := dominantEol(content)
	lines := splitCodexLines(content)
	write := func() codexEditResult {
		if err := atomicWriteTextFile(path, applyEol(strings.Join(lines, "\n"), eol)); err != nil {
			return codexEditError(err.Error())
		}
		return codexEditResult{ok: true, changed: true}
	}

	headerIdx := findTableHeader(lines, v2HeaderRe)
	if headerIdx != -1 {
		end := tableBodyEnd(lines, headerIdx)
		for i := headerIdx + 1; i < end; i++ {
			if regexp.MustCompile(`^\s*max_concurrent_threads_per_session\s*=`).MatchString(lines[i]) {
				lines = append(lines[:i], lines[i+1:]...)
				return write()
			}
		}
	}
	featuresHeader := findTableHeader(lines, featuresHeaderRe)
	if featuresHeader == -1 {
		return codexEditResult{ok: true}
	}
	featuresEnd := tableBodyEnd(lines, featuresHeader)
	for i := featuresHeader + 1; i < featuresEnd; i++ {
		inline := v2InlineLineRe.FindStringSubmatch(lines[i])
		if inline == nil {
			continue
		}
		entry := findInlineDigitsEntry(inline[2], "max_concurrent_threads_per_session")
		if entry == nil {
			continue
		}
		body := inline[2]
		head := body[:entry.keyStart]
		rest := body[entry.valEnd:]
		if strings.TrimSpace(head) == "" {
			// Key begins the body: drop the leading whitespace, the key and a
			// trailing `, ` if present (TS first replacement).
			rest = strings.TrimLeft(rest, " \t")
			rest = strings.TrimPrefix(rest, ",")
			rest = strings.TrimLeft(rest, " \t")
			body = rest
		} else {
			// Key is mid-body: drop from the preceding comma (TS second
			// replacement keeps the spaces before the comma).
			comma := strings.LastIndexByte(head, ',')
			if comma < 0 {
				continue
			}
			body = head[:comma] + strings.TrimLeft(rest, " \t")
		}
		lines[i] = inline[1] + "multi_agent_v2 = { " + strings.TrimSpace(body) + " }" + inline[3]
		return write()
	}
	return codexEditResult{ok: true}
}

// ensureCodexDisabledV2Config mirrors ensureDisabledV2Config: with existing v2
// feature config, delegate to setCodexMaxConcurrentThreads; otherwise append a
// fresh dedicated table carrying enabled = false plus the optional thread
// limit.
func ensureCodexDisabledV2Config(value int64, hasValue bool, configPath, migratedComment string) codexEditResult {
	path := configPath
	if path == "" {
		path = codexConfigTomlPath()
	}
	content, ok := readCodexConfigTextAt(path)
	if !ok {
		return codexEditError(fmt.Sprintf("config.toml not readable at %s", path))
	}
	dedicatedBody, hasDedicated := tomlTableBody(content, "features.multi_agent_v2")
	hasV2Line := regexp.MustCompile(`(?m)^\s*multi_agent_v2\s*=`).MatchString(content)
	if hasDedicated || hasV2Line {
		if !hasValue {
			return codexEditResult{ok: true}
		}
		return setCodexMaxConcurrentThreads(value, path, migratedComment)
	}
	_ = dedicatedBody
	eol := dominantEol(content)
	suffix := ""
	if !strings.HasSuffix(content, "\n") && content != "" {
		suffix = eol
	}
	table := "[features.multi_agent_v2]" + eol + "enabled = false"
	if hasValue {
		table += eol + "max_concurrent_threads_per_session = " + fmt.Sprint(value) + migratedComment
	}
	table += eol
	separator := ""
	if content != "" && !strings.HasSuffix(content, eol+eol) {
		separator = eol
	}
	if err := atomicWriteTextFile(path, content+suffix+separator+table); err != nil {
		return codexEditError(err.Error())
	}
	return codexEditResult{ok: true, changed: true}
}

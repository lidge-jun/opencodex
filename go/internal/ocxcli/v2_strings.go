package ocxcli

// v2_strings.go — managed string-field writer for the v2 config surface (issue
// #56, slice v2b). Byte mirror of src/codex/features.ts setV2StringField: the
// `mode-hint` verb persists features.multi_agent_v2.multi_agent_mode_hint_text
// and `subagent_developer_instructions` is the sibling key with identical
// mechanics. Handles the dedicated table, the inline table (string-aware
// braces so a `}` inside a value cannot corrupt the document), and the bare
// boolean form; a value with no existing v2 config creates the dedicated table.

import (
	"fmt"
	"regexp"
	"strings"
)

var managedStringV2DottedRe = regexp.MustCompile(`(?m)^\s*["']?multi_agent_v2["']?\s*\.`)
var managedStringV2QuotedHeaderRe = regexp.MustCompile(`(?m)^\s*\[\s*["']multi_agent_v2["']\s*\]`)

// setCodexV2StringField mirrors setV2StringField.
func setCodexV2StringField(key string, value *string, configPath string) codexEditResult {
	path := configPath
	if path == "" {
		path = codexConfigTomlPath()
	}
	content, ok := readCodexConfigTextAt(path)
	if !ok {
		return codexEditError(fmt.Sprintf("config.toml not readable at %s", path))
	}
	var encoded string
	var hasValue = value != nil
	if hasValue {
		encoded = encodeTomlBasicString(*value)
	}

	dedicatedStringBody := tomlTableBodyForStringFields(content, "features.multi_agent_v2")
	hasDedicated := dedicatedStringBody != ""
	if !hasDedicated {
		// A parsed V2 object without a supported source form came from
		// dotted/quoted path segments; fail closed without changing bytes.
		if managedStringV2DottedRe.MatchString(content) || managedStringV2QuotedHeaderRe.MatchString(content) {
			return codexEditError("dotted or quoted multi_agent_v2 config is not supported for managed string fields")
		}
	}
	featuresBody := tomlTableBodyForStringFields(content, "features")
	var featuresV2Entry *tomlInlineEntry
	if featuresBody != "" {
		featuresV2Entry = findTomlAssignment(featuresBody, "multi_agent_v2")
	}

	if hasDedicated {
		// The dedicated table exists: guard multiline values (the single-line
		// editor cannot rewrite or remove them) then scalar-edit the key.
		dedicatedEntry := findTomlAssignment(dedicatedStringBody, key)
		if dedicatedEntry != nil && isMultilineTomlString(dedicatedStringBody, dedicatedEntry.valueStart) {
			return codexEditError(fmt.Sprintf("multi-line TOML string for %s is not editable; convert it to a single-line string first", key))
		}
		legacyBody, _ := tomlTableBody(content, "features.multi_agent_v2")
		if dedicatedEntry != nil && legacyBody != "" && findTomlAssignment(legacyBody, key) == nil {
			return codexEditError(fmt.Sprintf("cannot edit %s after a header-shaped multiline value safely", key))
		}
		var next string
		if hasValue {
			next = editScalarInTable(content, "features.multi_agent_v2", key, encoded, false)
		} else {
			next = editScalarInTable(content, "features.multi_agent_v2", key, "", true)
		}
		if next == content {
			return codexEditResult{ok: true}
		}
		if err := atomicWriteTextFile(path, next); err != nil {
			return codexEditError(err.Error())
		}
		return codexEditResult{ok: true, changed: true}
	}

	if featuresV2Entry != nil && hasInlineMultilineTomlString(featuresBody, featuresV2Entry, key) {
		return codexEditError(fmt.Sprintf("multi-line TOML string for %s is not editable; convert it to a single-line string first", key))
	}

	eol := dominantEol(content)
	lines := splitCodexLines(content)
	featuresHeader := findTableHeader(lines, featuresHeaderRe)
	if featuresHeader != -1 {
		featuresEnd := tableBodyEnd(lines, featuresHeader)
		for i := featuresHeader + 1; i < featuresEnd; i++ {
			line := lines[i]
			if inlineMatch := v2InlineOpenRe.FindStringSubmatchIndex(line); inlineMatch != nil {
				openIdx := inlineMatch[1] - 1
				closeIdx := findInlineTableEnd(line, openIdx)
				if closeIdx == -1 {
					return codexEditError("malformed multi_agent_v2 inline table")
				}
				entry := findInlineEntry(line, openIdx+1, closeIdx, key)
				if !hasValue {
					if entry == nil {
						return codexEditResult{ok: true}
					}
					start := entry.keyStart
					stop := entry.valueEnd
					j := stop
					for j < closeIdx && line[j] == ' ' {
						j++
					}
					if j < closeIdx && line[j] == ',' {
						stop = j + 1
						for stop < closeIdx && line[stop] == ' ' {
							stop++
						}
					} else {
						k := start
						for k > openIdx+1 && line[k-1] == ' ' {
							k--
						}
						if k > openIdx+1 && line[k-1] == ',' {
							start = k - 1
						}
					}
					lines[i] = line[:start] + line[stop:]
				} else {
					if entry != nil {
						if strings.TrimSpace(line[entry.valueStart:entry.valueEnd]) == encoded {
							return codexEditResult{ok: true}
						}
						lines[i] = line[:entry.valueStart] + encoded + line[entry.valueEnd:]
					} else {
						insertPos := closeIdx
						for insertPos > openIdx+1 && line[insertPos-1] == ' ' {
							insertPos--
						}
						hasEntries := len(strings.TrimSpace(line[openIdx+1 : insertPos])) > 0
						var insertion string
						if hasEntries {
							insertion = ", " + key + " = " + encoded + " "
						} else {
							insertion = " " + key + " = " + encoded + " "
						}
						lines[i] = line[:insertPos] + insertion + line[closeIdx:]
					}
				}
				if err := atomicWriteTextFile(path, applyEol(strings.Join(lines, "\n"), eol)); err != nil {
					return codexEditError(err.Error())
				}
				return codexEditResult{ok: true, changed: true}
			}
			if boolMatch := v2BoolLineRe.FindStringSubmatch(line); boolMatch != nil {
				if !hasValue {
					return codexEditResult{ok: true}
				}
				lines[i] = boolMatch[1] + "multi_agent_v2 = { enabled = " + boolMatch[2] + ", " + key + " = " + encoded + " }" + boolMatch[3]
				if err := atomicWriteTextFile(path, applyEol(strings.Join(lines, "\n"), eol)); err != nil {
					return codexEditError(err.Error())
				}
				return codexEditResult{ok: true, changed: true}
			}
		}
		if featuresV2Entry != nil {
			return codexEditError("multi_agent_v2 inside a multiline [features] table is not editable safely")
		}
	}

	if !hasValue {
		return codexEditResult{ok: true}
	}
	suffix := ""
	if !strings.HasSuffix(content, "\n") && content != "" {
		suffix = eol
	}
	separator := ""
	if content != "" && !strings.HasSuffix(content, eol+eol) {
		separator = eol
	}
	tableText := "[features.multi_agent_v2]" + eol + key + " = " + encoded + eol
	if err := atomicWriteTextFile(path, content+suffix+separator+tableText); err != nil {
		return codexEditError(err.Error())
	}
	return codexEditResult{ok: true, changed: true}
}

var v2InlineOpenRe = regexp.MustCompile(`^(\s*)multi_agent_v2\s*=\s*\{`)

// tomlTableBodyForStringFields mirrors the string-fields table scanner: it
// skips complete (possibly multiline) values before recognizing the next
// header, so bracket-shaped prose inside a string cannot truncate the table.
func tomlTableBodyForStringFields(content, header string) string {
	headerRe := regexp.MustCompile(`(?m)^\s*\[` + regexp.QuoteMeta(header) + `\]\s*(?:#.*)?$`)
	match := headerRe.FindStringIndex(content)
	if match == nil {
		return ""
	}
	bodyStartRel := strings.IndexByte(content[match[1]:], '\n')
	if bodyStartRel == -1 {
		return ""
	}
	bodyStart := match[1] + bodyStartRel + 1
	lineStart := bodyStart
	for lineStart < len(content) {
		cursor := lineStart
		for cursor < len(content) && (content[cursor] == ' ' || content[cursor] == '\t') {
			cursor++
		}
		if cursor < len(content) && content[cursor] == '[' {
			return content[bodyStart:lineStart]
		}
		lineEndRel := strings.IndexByte(content[cursor:], '\n')
		boundedEnd := len(content)
		lineEnd := len(content)
		if lineEndRel >= 0 {
			boundedEnd = cursor + lineEndRel
			lineEnd = boundedEnd + 1
		}
		keyEnd := cursor
		if keyEnd < boundedEnd && (content[keyEnd] == '"' || content[keyEnd] == '\'') {
			keyEnd = scanTomlValueEnd(content, keyEnd)
		} else {
			keyRe := regexp.MustCompile(`^[A-Za-z0-9_.-]+`)
			if m := keyRe.FindStringIndex(content[keyEnd:boundedEnd]); m != nil {
				keyEnd += m[1]
			}
		}
		for keyEnd < boundedEnd && (content[keyEnd] == ' ' || content[keyEnd] == '\t') {
			keyEnd++
		}
		if keyEnd < boundedEnd && content[keyEnd] == '=' {
			valueEnd := scanTomlValueEnd(content, keyEnd+1)
			nextLineRel := strings.IndexByte(content[valueEnd:], '\n')
			if nextLineRel == -1 {
				lineStart = len(content)
			} else {
				lineStart = valueEnd + nextLineRel + 1
			}
		} else {
			lineStart = lineEnd
		}
	}
	return content[bodyStart:]
}

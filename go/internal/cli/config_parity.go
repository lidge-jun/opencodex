package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

const configUsage = `Usage:
  ocx config [show] [--json] [--source]
  ocx config get <dot.path> [--json]
  ocx config set <dot.path> <json-or-string> [--json]
  ocx config unset <dot.path> [--json]
  ocx config validate [path|-] [--json]
  ocx config export <path|->
  ocx config import <path|-> --yes [--json]`

// configDocument is the config as a generic tree, which is what a dot path
// walks. The typed struct cannot represent an arbitrary path.
type configDocument map[string]any

// readConfigDocument loads the config file as a generic tree plus its
// diagnostics, mirroring readConfigDiagnostics: the config plus where it came
// from and, when the file could not be used, why.
type configDiagnostics struct {
	document configDocument
	source   string
	failure  string
	warnings []string
	// order is the key sequence the document should print in. A Go map has
	// none, and the oracle prints the order it parsed.
	order documentOrder
}

func readConfigDiagnostics() (configDiagnostics, error) {
	path, err := configPath()
	if err != nil {
		return configDiagnostics{}, err
	}
	fallback := func(reason string) configDiagnostics {
		// The oracle discards an unusable file and hands back defaults, so
		// show/get/export never surface its contents. That matters beyond
		// tidiness: exporting an unvalidated file would copy whatever
		// credentials it holds into a new location.
		return configDiagnostics{document: defaultConfigDocument(), source: "fallback", failure: reason, order: defaultDocumentOrder}
	}
	raw, readErr := os.ReadFile(path)
	if readErr != nil {
		if os.IsNotExist(readErr) {
			return configDiagnostics{document: defaultConfigDocument(), source: "default", order: defaultDocumentOrder}, nil
		}
		return configDiagnostics{}, readErr
	}
	// A BOM is stripped the way the oracle does before parsing.
	trimmed := strings.TrimPrefix(string(raw), "\ufeff")
	var decoded any
	if json.Unmarshal([]byte(trimmed), &decoded) != nil {
		return fallback("invalid_json"), nil
	}
	record, isObject := decoded.(map[string]any)
	if !isObject {
		return fallback("invalid_json"), nil
	}
	// Degrade before validating: the oracle's schema drops these fields rather
	// than rejecting, so a single bad optional value must not send an
	// otherwise-good file to fallback.
	warnings := degradeInvalidFields(configDocument(record))
	normalized, normalizeErr := normalizeConfigDocument(configDocument(record))
	if normalizeErr != nil {
		return fallback(normalizeErr.Error()), nil
	}
	// The order comes from the SOURCE bytes, not the normalized map, so a
	// user's own field sequence survives a round trip through show.
	return configDiagnostics{document: normalized, source: "file", warnings: warnings, order: orderOfDocument([]byte(trimmed))}, nil
}

// readConfigDocument is the common case: the effective config and its origin.
func readConfigDocument() (configDocument, string, error) {
	diagnostics, err := readConfigDiagnostics()
	if err != nil {
		return nil, "", err
	}
	return diagnostics.document, diagnostics.source, nil
}

// validateConfigDocument runs the same validation a write would, without
// persisting, so `set` and `import` can refuse an invalid candidate.
func validateConfigDocument(document configDocument) error {
	// Structural rules the typed decode cannot express. A missing `providers`
	// unmarshals to a nil map and a dangling `defaultProvider` decodes fine,
	// so without these an import would write `"providers": null` that the
	// oracle rejects outright.
	providersValue, hasProviders := document["providers"]
	if !hasProviders || providersValue == nil {
		return usageError("", "schema_invalid: providers: Invalid input: expected record, received undefined")
	}
	providers, isObject := providersValue.(map[string]any)
	if !isObject {
		return usageError("", "schema_invalid: providers: Invalid input: expected record")
	}
	if selected, present := document["defaultProvider"]; present {
		name, isString := selected.(string)
		if !isString {
			return usageError("", "schema_invalid: defaultProvider: expected string")
		}
		// No exemption for "openai": the oracle rejects it too when it is
		// absent from providers.
		if _, known := providers[name]; !known {
			return usageError("", "schema_invalid: defaultProvider: defaultProvider must exist in providers")
		}
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return err
	}
	// Decode ONTO the defaults, not onto a zero value. The oracle's schema
	// supplies a hostname when the document omits one, so validating a
	// zero-valued struct rejected ordinary TypeScript-written configs with
	// "hostname: must not be blank" -- a config the TS CLI calls valid.
	candidate := config.FreshInstall()
	candidate.Providers = nil
	candidate.Combos = nil
	if err := json.Unmarshal(encoded, &candidate); err != nil {
		return usageError("", "%s", err.Error())
	}
	return candidate.Validate()
}

// normalizeConfigDocument validates and returns the document with schema
// defaults MATERIALIZED, the way the oracle's validateConfigCandidate hands
// back a normalized config rather than the raw input.
//
// Without this, a file that legitimately omits `port` validates but then
// `config get port` reports the path as missing, even though the oracle
// resolves it to 10100.
//
// Defaults are layered UNDER the document rather than over it, so a key the
// user actually wrote always wins, and unknown members survive untouched.
func normalizeConfigDocument(document configDocument) (configDocument, error) {
	if err := validateConfigDocument(document); err != nil {
		return nil, err
	}
	base := map[string]any(defaultConfigDocument())
	for key, value := range document {
		base[key] = value
	}
	return configDocument(base), nil
}

// saveConfigDocument writes the VALIDATED GENERIC document, not a typed
// round-trip of it.
//
// Marshalling through config.Config loses any unknown member of a known
// nested object: the root and provider structs carry passthrough fields, but
// something like visionSidecar does not, so `config set port 13000` would
// silently delete visionSidecar.futureNested. Editing one key must never
// discard a setting the user wrote.
//
// The write mirrors config.Save's durability: private temp file in the same
// directory, fsync, atomic rename.
func saveConfigDocument(document configDocument) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := validateConfigDocument(document); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(map[string]any(document), "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	temp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary config: %w", err)
	}
	tempPath := temp.Name()
	committed := false
	defer func() {
		_ = temp.Close()
		if !committed {
			_ = os.Remove(tempPath)
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		return fmt.Errorf("protect temporary config: %w", err)
	}
	if _, err := temp.Write(encoded); err != nil {
		return fmt.Errorf("write temporary config: %w", err)
	}
	if err := temp.Sync(); err != nil {
		return fmt.Errorf("sync temporary config: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close temporary config: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	committed = true
	return nil
}

// readConfigInput reads a candidate from a file or, for "-", from stdin.
func readConfigInput(source string, stdin io.Reader) (configDocument, error) {
	var raw []byte
	var err error
	if source == "-" {
		if stdin == nil {
			stdin = os.Stdin
		}
		raw, err = io.ReadAll(stdin)
	} else {
		raw, err = os.ReadFile(source)
	}
	if err != nil {
		return nil, err
	}
	var decoded any
	if json.Unmarshal([]byte(strings.TrimPrefix(string(raw), "\ufeff")), &decoded) != nil {
		return nil, usageError("", "invalid JSON in %s", source)
	}
	record, isObject := decoded.(map[string]any)
	if !isObject {
		return nil, usageError("", "invalid JSON in %s", source)
	}
	return configDocument(record), nil
}

// runConfigParity implements the oracle's config surface. The legacy
// fixed-key form stays reachable through runConfig for compatibility.
func runConfigParity(ctx context.Context, args []string, streams IO) error {
	rest := append([]string{}, args...)
	action := "show"
	if len(rest) > 0 {
		action = strings.ToLower(rest[0])
		rest = rest[1:]
	}
	wantsJSON := takeFlag(&rest, "--json")

	switch action {
	case "show":
		source := takeFlag(&rest, "--source")
		if err := rejectArgs(rest, configUsage, false); err != nil {
			return err
		}
		diagnostics, err := readConfigDiagnostics()
		if err != nil {
			return err
		}
		redacted, _ := redactConfigValue(map[string]any(diagnostics.document), "").(map[string]any)
		if !source {
			// show always prints JSON: the oracle passes true for wantsJson.
			// It goes through the ordered marshaller so the printed sequence is
			// the file's, not Go's map iteration order.
			encoded, marshalErr := marshalDocumentInOrder(configDocument(redacted), diagnostics.order)
			if marshalErr != nil {
				return marshalErr
			}
			_, writeErr := fmt.Fprintln(streams.Out, string(encoded))
			return writeErr
		}
		// `error` is present either way, null on success, so a consumer can
		// read one shape rather than test for the key.
		var failure any
		if diagnostics.failure != "" {
			failure = diagnostics.failure
		}
		return printData(streams, map[string]any{
			"config":   redacted,
			"source":   diagnostics.source,
			"error":    failure,
			"warnings": warningList(diagnostics.warnings),
		}, true, nil)

	case "get":
		if len(rest) == 0 {
			return usageError(configUsage, "config path is required")
		}
		path := rest[0]
		rest = rest[1:]
		if err := rejectArgs(rest, configUsage, false); err != nil {
			return err
		}
		document, _, err := readConfigDocument()
		if err != nil {
			return err
		}
		value, err := getConfigPath(map[string]any(document), path)
		if err != nil {
			return err
		}
		segments, err := configPathSegments(path)
		if err != nil {
			return err
		}
		value = redactConfigValue(value, segments[len(segments)-1])
		if wantsJSON {
			return printData(streams, value, true, nil)
		}
		text, err := formatConfigValue(value)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(streams.Out, text)
		return err

	case "set", "unset":
		if len(rest) == 0 {
			return usageError(configUsage, "config path and value are required")
		}
		path := rest[0]
		rest = rest[1:]
		var parsed any
		if action == "set" {
			if len(rest) == 0 {
				return usageError(configUsage, "config path and value are required")
			}
			parsed = parseConfigValue(rest[0])
			rest = rest[1:]
		}
		if err := rejectArgs(rest, configUsage, false); err != nil {
			return err
		}
		document, _, err := readConfigDocument()
		if err != nil {
			return err
		}
		if err := setConfigPath(map[string]any(document), path, parsed, action == "unset"); err != nil {
			return err
		}
		if err := validateConfigDocument(document); err != nil {
			return err
		}
		if err := saveConfigDocument(document); err != nil {
			return err
		}
		var saved any
		if action == "set" {
			if value, getErr := getConfigPath(map[string]any(document), path); getErr == nil {
				segments, _ := configPathSegments(path)
				saved = redactConfigValue(value, segments[len(segments)-1])
			}
		}
		verb := "Set"
		if action == "unset" {
			verb = "Unset"
		}
		return printData(streams, map[string]any{"ok": true, "path": path, "value": saved},
			wantsJSON, []string{fmt.Sprintf("%s %s.", verb, path)})

	case "validate":
		source := ""
		if len(rest) > 0 {
			source = rest[0]
			rest = rest[1:]
		}
		if err := rejectArgs(rest, configUsage, false); err != nil {
			return err
		}
		document := configDocument{}
		if source != "" {
			loaded, err := readConfigInput(source, streams.In)
			if err != nil {
				return err
			}
			document = loaded
		} else {
			loaded, _, err := readConfigDocument()
			if err != nil {
				return err
			}
			document = loaded
		}
		if err := validateConfigDocument(document); err != nil {
			// Invalid config is a reported result, not a crash: the oracle
			// prints the reason and exits 1.
			if printErr := printData(streams, map[string]any{"ok": false, "error": err.Error()},
				wantsJSON, []string{"Config is invalid: " + err.Error()}); printErr != nil {
				return printErr
			}
			return errSilentFailure
		}
		reported := source
		if reported == "" {
			reported, _ = configPath()
		}
		return printData(streams, map[string]any{"ok": true, "source": reported},
			wantsJSON, []string{"Config is valid."})

	case "export":
		if len(rest) == 0 {
			return usageError(configUsage, "export path is required")
		}
		target := rest[0]
		rest = rest[1:]
		if err := rejectArgs(rest, configUsage, false); err != nil {
			return err
		}
		document, _, err := readConfigDocument()
		if err != nil {
			return err
		}
		// Export is a BACKUP, so it is deliberately not redacted -- a masked
		// copy could not be imported back. It is written 0600 for that reason.
		encoded, err := json.MarshalIndent(map[string]any(document), "", "  ")
		if err != nil {
			return err
		}
		encoded = append(encoded, '\n')
		if target == "-" {
			_, err = streams.Out.Write(encoded)
			return err
		}
		// WriteFile's mode applies only when it CREATES the file, so exporting
		// over an existing world-readable path would leave credentials
		// readable. Chmod unconditionally.
		if err := os.WriteFile(target, encoded, 0o600); err != nil {
			return err
		}
		if err := os.Chmod(target, 0o600); err != nil {
			return fmt.Errorf("protect exported config: %w", err)
		}
		_, err = fmt.Fprintf(streams.Out, "Exported config to %s.\n", target)
		return err

	case "import":
		if len(rest) == 0 {
			return usageError(configUsage, "import path is required")
		}
		source := rest[0]
		rest = rest[1:]
		yes := takeFlag(&rest, "--yes")
		if !yes {
			return usageError(configUsage, "import requires --yes")
		}
		if err := rejectArgs(rest, configUsage, false); err != nil {
			return err
		}
		document, err := readConfigInput(source, streams.In)
		if err != nil {
			return err
		}
		if err := validateConfigDocument(document); err != nil {
			return err
		}
		if err := saveConfigDocument(document); err != nil {
			return err
		}
		return printData(streams, map[string]any{"ok": true, "source": source}, wantsJSON,
			[]string{fmt.Sprintf("Imported config from %s. Restart or run ocx sync if needed.", source)})
	}
	return usageError(configUsage, "unknown config command %s", action)
}

// errSilentFailure marks a failure the command has ALREADY reported, so Run
// exits non-zero without printing a second "Error:" line over the top of it.
var errSilentFailure = errors.New("reported failure")

// defaultConfigDocument is the generic form of the built-in default config.
//
// The oracle answers an absent or unusable config with getDefaultConfig()
// rather than an empty object, so `validate` succeeds on a fresh home and
// `get providers.openai.adapter` resolves before the user has written anything.
func defaultConfigDocument() configDocument {
	// Built from FreshInstall, then reconciled with the oracle's
	// getDefaultConfig() SHAPE.
	//
	// The two are not the same document. Go's struct marshals hostname, debug
	// and log that the oracle omits, and the oracle carries websockets:false
	// that Go's zero value drops. Serving or persisting the Go shape would
	// write a config the TypeScript CLI did not produce, so the extras are
	// removed and the missing key restored.
	defaults := config.FreshInstall()
	encoded, err := json.Marshal(defaults)
	if err != nil {
		return configDocument{}
	}
	var document map[string]any
	if json.Unmarshal(encoded, &document) != nil {
		return configDocument{}
	}
	for _, goOnly := range []string{"hostname", "debug", "log", "streamMode"} {
		delete(document, goOnly)
	}
	if _, present := document["websockets"]; !present {
		document["websockets"] = false
	}
	return configDocument(document)
}

// degradableFields are the schema entries the oracle declares with
// `.catch(undefined)`: an invalid value is DROPPED with a warning rather than
// rejecting the whole file, so one hand-edited typo cannot hide every provider
// and account the user has configured.
var degradableFields = map[string]string{
	"injectionModel":            "a string",
	"injectionEffort":           "a string",
	"streamMode":                "a string",
	"syncCodexSubagentDefaults": "a boolean",
}

// degradeInvalidFields removes malformed optional fields and reports what it
// dropped, in the oracle's wording.
func degradeInvalidFields(document configDocument) []string {
	warnings := []string{}
	for _, field := range []string{"injectionModel", "injectionEffort", "streamMode", "syncCodexSubagentDefaults"} {
		value, present := document[field]
		if !present || value == nil {
			continue
		}
		expected := degradableFields[field]
		valid := false
		switch typed := value.(type) {
		case string:
			valid = expected == "a string"
			if field == "streamMode" && valid {
				valid = typed == "auto" || typed == "legacy-tee" || typed == "eager-relay"
			}
		case bool:
			valid = expected == "a boolean"
		}
		if !valid {
			delete(document, field)
			warnings = append(warnings, field+" ignored: expected "+expected)
		}
	}
	return warnings
}

// warningList renders warnings as a JSON array, empty rather than null when
// there are none.
func warningList(warnings []string) []any {
	out := make([]any, 0, len(warnings))
	for _, warning := range warnings {
		out = append(out, warning)
	}
	return out
}

// documentOrder is the ordered form of a whole config document.
//
// A Go map has no key order and JSON.stringify preserves the one it parsed, so
// `config show` printed alphabetically where the oracle prints file order. The
// order is tracked beside the document rather than inside it, because every
// dot-path walk in this file relies on plain map lookup.
type documentOrder struct {
	value orderedValue
	ok    bool
}

// orderOfDocument records the key sequence, at every depth, from the source
// bytes.
func orderOfDocument(raw []byte) documentOrder {
	value, err := decodeOrdered(raw)
	if err != nil || value.kind != 'o' {
		return documentOrder{}
	}
	return documentOrder{value: value, ok: true}
}

// defaultDocumentOrder is the oracle's getDefaultConfig() literal order, used
// when there is no file to read an order from.
var defaultDocumentOrder = orderOfDocument([]byte(`{
  "port": 0,
  "openaiProviderTierVersion": 0,
  "providers": {"openai": {"adapter": "", "baseUrl": "", "authMode": "", "codexAccountMode": ""}},
  "defaultProvider": "",
  "subagentModels": [],
  "multiAgentGuidanceEnabled": false,
  "websockets": false,
  "codexAutoStart": false,
  "codexShimAutoRestore": false
}`))

// marshalDocumentInOrder renders the document following the recorded key order
// at each level, appending any key the order does not mention in sorted order
// so the output stays deterministic.
func marshalDocumentInOrder(document configDocument, order documentOrder) ([]byte, error) {
	var reference *orderedValue
	if order.ok {
		reference = &order.value
	}
	compact, err := orderedJSONBytes(map[string]any(document), reference)
	if err != nil {
		return nil, err
	}
	var indented bytes.Buffer
	if err := json.Indent(&indented, compact, "", "  "); err != nil {
		return nil, err
	}
	return indented.Bytes(), nil
}

// orderedJSONBytes serializes value, taking key order from reference when the
// two line up and falling back to sorted keys when they do not.
func orderedJSONBytes(value any, reference *orderedValue) ([]byte, error) {
	record, isObject := value.(map[string]any)
	if !isObject {
		if items, isArray := value.([]any); isArray {
			out := []byte{'['}
			for index, item := range items {
				if index > 0 {
					out = append(out, ',')
				}
				var childReference *orderedValue
				if reference != nil && reference.kind == 'a' && index < len(reference.values) {
					childReference = &reference.values[index]
				}
				encoded, err := orderedJSONBytes(item, childReference)
				if err != nil {
					return nil, err
				}
				out = append(out, encoded...)
			}
			return append(out, ']'), nil
		}
		return json.Marshal(jsSafe(value))
	}

	keys := make([]string, 0, len(record))
	seen := make(map[string]struct{}, len(record))
	if reference != nil && reference.kind == 'o' {
		for _, key := range reference.keys {
			if _, present := record[key]; present {
				keys = append(keys, key)
				seen[key] = struct{}{}
			}
		}
	}
	remaining := make([]string, 0, len(record))
	for key := range record {
		if _, already := seen[key]; !already {
			remaining = append(remaining, key)
		}
	}
	sort.Strings(remaining)
	keys = append(keys, remaining...)

	out := []byte{'{'}
	for index, key := range keys {
		if index > 0 {
			out = append(out, ',')
		}
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		var childReference *orderedValue
		if reference != nil && reference.kind == 'o' {
			for position, candidate := range reference.keys {
				if candidate == key {
					childReference = &reference.values[position]
					break
				}
			}
		}
		encodedValue, err := orderedJSONBytes(record[key], childReference)
		if err != nil {
			return nil, err
		}
		out = append(out, encodedKey...)
		out = append(out, ':')
		out = append(out, encodedValue...)
	}
	return append(out, '}'), nil
}

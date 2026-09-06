// Package configschema ports the config.json boundary shared by the TypeScript
// config command. It intentionally keeps JSON object order: config show and
// config export expose the Zod schema's default-injection order.
package configschema

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

const (
	defaultPort                   = int64(10100)
	defaultUsageMaxReadBytes      = int64(64 * 1024 * 1024)
	defaultAppOwnedMemoryBudgetMB = int64(256)
	maxAppOwnedMemoryBudgetMB     = int64(4096)
)

// Normalized is a config document whose object order has been projected onto
// TypeScript's configSchema order. Unknown fields remain present after known
// schema fields, matching Zod's passthrough object result.
type Normalized struct{ root *value }

func NormalizeJSON(raw []byte) (*Normalized, error) {
	v, err := parse(raw)
	if err != nil {
		return nil, err
	}
	if v.kind != objectKind {
		return nil, errors.New("config must be a JSON object")
	}
	return &Normalized{root: normalizeLoad(v)}, nil
}

// ValidateCandidateJSON implements the strict write boundary. Loading can
// degrade selected optional fields; writes never silently accept an invalid
// config candidate. Error wording follows Zod 4 as used in src/config.ts.
func ValidateCandidateJSON(raw []byte) (*Normalized, error) {
	v, err := parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if v.kind != objectKind {
		return nil, errors.New("schema_invalid: Invalid input: expected object, received array")
	}
	if err := validateTop(v); err != nil {
		return nil, err
	}
	return &Normalized{root: normalizeLoad(v)}, nil
}

func (n *Normalized) CompactJSON() ([]byte, error) {
	if n == nil || n.root == nil {
		return nil, errors.New("nil normalized config")
	}
	return n.root.compact(), nil
}

func (n *Normalized) IndentedJSON() ([]byte, error) {
	compact, err := n.CompactJSON()
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err := json.Indent(&out, compact, "", "  "); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

type valueKind uint8

const (
	nullKind valueKind = iota
	boolKind
	numberKind
	stringKind
	arrayKind
	objectKind
)

type member struct {
	key   string
	value *value
}
type value struct {
	kind   valueKind
	b      bool
	number json.Number
	text   string
	array  []*value
	object []member
}

func parse(raw []byte) (*value, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	v, err := decodeValue(d)
	if err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		if err == nil {
			return nil, errors.New("multiple JSON values")
		}
		return nil, err
	}
	return v, nil
}
func decodeValue(d *json.Decoder) (*value, error) {
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	return decodeToken(d, t)
}
func decodeToken(d *json.Decoder, token json.Token) (*value, error) {
	switch x := token.(type) {
	case nil:
		return &value{kind: nullKind}, nil
	case bool:
		return &value{kind: boolKind, b: x}, nil
	case string:
		return &value{kind: stringKind, text: x}, nil
	case json.Number:
		return &value{kind: numberKind, number: x}, nil
	case json.Delim:
		switch x {
		case '{':
			v := &value{kind: objectKind}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return nil, err
				}
				s, ok := key.(string)
				if !ok {
					return nil, errors.New("object key is not a string")
				}
				child, err := decodeValue(d)
				if err != nil {
					return nil, err
				}
				v.set(s, child)
			}
			_, err := d.Token()
			return v, err
		case '[':
			v := &value{kind: arrayKind}
			for d.More() {
				child, err := decodeValue(d)
				if err != nil {
					return nil, err
				}
				v.array = append(v.array, child)
			}
			_, err := d.Token()
			return v, err
		}
	}
	return nil, errors.New("unsupported JSON token")
}
func (v *value) find(key string) *value {
	if v == nil || v.kind != objectKind {
		return nil
	}
	for _, m := range v.object {
		if m.key == key {
			return m.value
		}
	}
	return nil
}
func (v *value) set(key string, x *value) {
	for i := range v.object {
		if v.object[i].key == key {
			v.object[i].value = x
			return
		}
	}
	v.object = append(v.object, member{key, x})
}
func (v *value) has(key string) bool { return v.find(key) != nil }
func number(n int64) *value {
	return &value{kind: numberKind, number: json.Number(strconv.FormatInt(n, 10))}
}
func stringValue(s string) *value { return &value{kind: stringKind, text: s} }

var schemaOrder = []string{"port", "runtimeRole", "hub", "remoteGui", "client", "managementUsageMaxReadBytes", "upstreamHostCircuitThreshold", "maxUpstreamBodyBytes", "appOwnedMemoryBudgetMb", "hostname", "unauthenticatedLoopbackListener", "providers", "defaultProvider", "defaultModelAliases", "cursorEffortRows", "configRebaseProvenance", "emptyCompletionRetry", "oauthOpenBrowser", "openaiProviderTierVersion", "googleAntigravityStaticCatalogVersion", "clientIntegrations", "providerContextCaps", "contextCapValue", "multiAgentGuidanceEnabled", "agentTaskRecovery", "injectionModel", "injectionEffort", "syncCodexSubagentDefaults", "subagentModelFallbackByModel", "codexShimAutoRestore", "codexDesktopAuthless", "pausedCodexAccountIds", "codexAccountNamespaces", "codexAccountPriorities", "activeCodexAccountPinned", "codexAccountPickerEnabled", "showCodexSparkQuota", "resetCreditAutoRedeem", "grokExcludedModels", "streamMode", "blockedModelRedirects", "experimentalRealtimeWsBaseUrl", "apiKeys"}

func normalizeLoad(in *value) *value {
	out := &value{kind: objectKind}
	known := map[string]bool{}
	for _, key := range schemaOrder {
		known[key] = true
		x := in.find(key)
		switch key {
		case "port":
			if x == nil || !validIntRange(x, 0, 65535) {
				out.set(key, number(defaultPort))
			} else {
				out.set(key, x)
			}
		case "managementUsageMaxReadBytes":
			if x == nil || !validIntRange(x, 1, math.MaxInt64) {
				out.set(key, number(defaultUsageMaxReadBytes))
			} else {
				out.set(key, x)
			}
		case "appOwnedMemoryBudgetMb":
			if x == nil || !validIntRange(x, 64, maxAppOwnedMemoryBudgetMB) {
				out.set(key, number(defaultAppOwnedMemoryBudgetMB))
			} else {
				out.set(key, x)
			}
		case "defaultProvider":
			if x == nil {
				out.set(key, stringValue("openai"))
			} else {
				out.set(key, x)
			}
		case "hostname":
			if x != nil && x.kind == stringKind && strings.TrimSpace(x.text) != "" {
				out.set(key, x)
			}
		case "upstreamHostCircuitThreshold", "maxUpstreamBodyBytes":
			if x != nil && validIntRange(x, 0, math.MaxInt64) {
				out.set(key, x)
			}
		case "providers":
			if x != nil && x.kind == objectKind {
				out.set(key, normalizeProviders(x))
			} else if x != nil {
				out.set(key, x)
			}
		default:
			if x != nil {
				out.set(key, x)
			}
		}
	}
	for _, m := range in.object {
		if !known[m.key] {
			out.set(m.key, m.value)
		}
	}
	return out
}
func normalizeProviders(in *value) *value {
	out := &value{kind: objectKind}
	for _, m := range in.object {
		if m.value.kind != objectKind {
			out.set(m.key, m.value)
			continue
		}
		p := &value{kind: objectKind}
		if x := m.value.find("adapter"); x != nil {
			p.set("adapter", x)
		}
		if x := m.value.find("baseUrl"); x != nil {
			p.set("baseUrl", x)
		}
		for _, field := range m.value.object {
			if field.key != "adapter" && field.key != "baseUrl" {
				p.set(field.key, field.value)
			}
		}
		out.set(m.key, p)
	}
	return out
}
func validIntRange(v *value, min, max int64) bool {
	if v == nil || v.kind != numberKind {
		return false
	}
	n, err := strconv.ParseInt(v.number.String(), 10, 64)
	return err == nil && n >= min && n <= max
}

func validateTop(v *value) error {
	if port := v.find("port"); port != nil {
		if port.kind != numberKind {
			return errors.New("schema_invalid: port: Invalid input: expected number, received string")
		}
		n, err := strconv.ParseInt(port.number.String(), 10, 64)
		if err != nil {
			return errors.New("schema_invalid: port: Invalid input: expected int, received number")
		}
		if n < 0 {
			return errors.New("schema_invalid: port: Too small: expected number to be >=0")
		}
		if n > 65535 {
			return errors.New("schema_invalid: port: Too big: expected number to be <=65535")
		}
	}
	providers := v.find("providers")
	if providers == nil {
		return errors.New("schema_invalid: providers: Invalid input: expected record, received undefined")
	}
	if providers.kind != objectKind {
		return fmt.Errorf("schema_invalid: providers: Invalid input: expected record, received %s", zodType(providers))
	}
	for _, p := range providers.object {
		if p.value.kind != objectKind {
			return fmt.Errorf("schema_invalid: providers.%s: Invalid input: expected object, received %s", p.key, zodType(p.value))
		}
		if x := p.value.find("adapter"); x == nil {
			return fmt.Errorf("schema_invalid: providers.%s.adapter: Invalid input: expected string, received undefined", p.key)
		} else if x.kind != stringKind {
			return fmt.Errorf("schema_invalid: providers.%s.adapter: Invalid input: expected string, received %s", p.key, zodType(x))
		} else if x.text == "" {
			return fmt.Errorf("schema_invalid: providers.%s.adapter: Too small: expected string to have >=1 characters", p.key)
		}
		if x := p.value.find("baseUrl"); x == nil {
			return fmt.Errorf("schema_invalid: providers.%s.baseUrl: Invalid input: expected string, received undefined", p.key)
		} else if x.kind != stringKind {
			return fmt.Errorf("schema_invalid: providers.%s.baseUrl: Invalid input: expected string, received %s", p.key, zodType(x))
		} else if x.text == "" {
			return fmt.Errorf("schema_invalid: providers.%s.baseUrl: Too small: expected string to have >=1 characters", p.key)
		}
	}
	if d := v.find("defaultProvider"); d != nil {
		if d.kind != stringKind {
			return fmt.Errorf("schema_invalid: defaultProvider: Invalid input: expected string, received %s", zodType(d))
		}
		if d.text == "" {
			return errors.New("schema_invalid: defaultProvider: Too small: expected string to have >=1 characters")
		}
	}
	return nil
}
func zodType(v *value) string {
	if v == nil {
		return "undefined"
	}
	switch v.kind {
	case nullKind:
		return "null"
	case boolKind:
		return "boolean"
	case numberKind:
		return "number"
	case stringKind:
		return "string"
	case arrayKind:
		return "array"
	default:
		return "object"
	}
}
func (v *value) compact() []byte { var b bytes.Buffer; v.write(&b); return b.Bytes() }
func (v *value) write(b *bytes.Buffer) {
	switch v.kind {
	case nullKind:
		b.WriteString("null")
	case boolKind:
		if v.b {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case numberKind:
		b.WriteString(v.number.String())
	case stringKind:
		raw, _ := json.Marshal(v.text)
		b.Write(raw)
	case arrayKind:
		b.WriteByte('[')
		for i, x := range v.array {
			if i > 0 {
				b.WriteByte(',')
			}
			x.write(b)
		}
		b.WriteByte(']')
	case objectKind:
		b.WriteByte('{')
		for i, m := range v.object {
			if i > 0 {
				b.WriteByte(',')
			}
			raw, _ := json.Marshal(m.key)
			b.Write(raw)
			b.WriteByte(':')
			m.value.write(b)
		}
		b.WriteByte('}')
	}
}

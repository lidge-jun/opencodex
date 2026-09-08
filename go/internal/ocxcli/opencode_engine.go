package ocxcli

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// opencode_command.go ports src/cli/opencode.ts cmdOpencode: ensure the proxy
// is live, fetch the model catalog from the management API, inject the
// opencodex V1/V2 provider blocks through OpenCode's inline runtime layer
// (OPENCODE_CONFIG_CONTENT), and spawn `opencode` with the admission key in
// the child environment only.
//
// The provider-block serializer and the /api/models→block pipeline are shared
// with `ocx export` (export_models.go + export_build.go): TS feeds both
// surfaces through the same opencodeProviderBlocks serializer, and the launch
// path differs only by skipping the export normalize (sort) step and resolving
// its base URL from the live proxy. Reuse is verified byte-for-byte against
// the TS engine in the opencode golden tests.

const opencodeConfigContentEnv = "OPENCODE_CONFIG_CONTENT"

// opencodeInstallHint is the cmdOpencode ENOENT hint (also printed for the
// win32 9009 command-not-found exit, mirroring opencodeNotFoundHint).
const opencodeInstallHint = "❌ `opencode` CLI not found. Install it first: npm install -g opencode-ai"

// opencodeDefaultProxyPort mirrors the cmdOpencode pin default.
const opencodeDefaultProxyPort = 10100

// ─────────────────────────────────────────────────────────────────────────────
// Admission key (opencodeApiKey in opencode.ts): env token → service token file
// → configured apiKeys[0].key → "ocx". Never serialized into the runtime
// config; only the child environment carries the real value.

func opencodeAPIKey(cfg *jsonwire.Value) string {
	if token := strings.TrimSpace(os.Getenv("OPENCODEX_API_AUTH_TOKEN")); token != "" {
		return token
	}
	tokenPath := strings.TrimSpace(os.Getenv("OCX_API_TOKEN_FILE"))
	if tokenPath == "" {
		if dir, err := config.Dir(); err == nil {
			tokenPath = filepath.Join(dir, "service-api-token")
		}
	}
	if tokenPath != "" {
		if raw, err := os.ReadFile(tokenPath); err == nil {
			if token := strings.TrimSpace(string(raw)); token != "" {
				return token
			}
		}
	}
	if cfg != nil {
		if keys := cfg.Find("apiKeys"); keys != nil && keys.Kind() == jsonwire.Array {
			if first := keys.Elements(); len(first) > 0 {
				if entry := first[0]; entry.Kind() == jsonwire.Object {
					if key := entry.Find("key"); key != nil && key.Kind() == jsonwire.String {
						if trimmed := strings.TrimSpace(key.String()); trimmed != "" {
							return trimmed
						}
					}
				}
			}
		}
	}
	return "ocx"
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime config merge (mergeOpencodeRuntimeConfig + serialize in opencode.ts).

// opencodeMergeContent merges inherited OPENCODE_CONFIG_CONTENT with the two
// blocks this launcher owns: only `provider.opencodex` (V1) and
// `providers.opencodex` (V2) are replaced; every other key survives with its
// position and value. When no inline layer is present the minimal runtime
// object is emitted. The returned Value is the parsed document mutated in
// place — TS spreads parsed into a new object, and for the launcher's purposes
// (serialize and pass on) the shapes are identical, including key order.
func opencodeMergeContent(inherited string, blocks exportProviderBlocks) (*jsonwire.Value, error) {
	buildMinimal := func() *jsonwire.Value {
		doc := jsonwire.ObjectValue()
		doc.Set("$schema", jsonwire.StringValue(exportProviderSchema))
		legacy := jsonwire.ObjectValue()
		legacy.Set(exportProviderID, blocks.v1)
		doc.Set("provider", legacy)
		v2 := jsonwire.ObjectValue()
		v2.Set(exportProviderID, blocks.v2)
		doc.Set("providers", v2)
		return doc
	}
	if strings.TrimSpace(inherited) == "" {
		return buildMinimal(), nil
	}
	parsed, err := jsonwire.Parse([]byte(inherited))
	if err != nil {
		return nil, errors.New("OPENCODE_CONFIG_CONTENT is not valid JSON.")
	}
	if parsed.Kind() != jsonwire.Object {
		return nil, errors.New("OPENCODE_CONFIG_CONTENT must be a JSON object.")
	}
	if provider := parsed.Find("provider"); provider != nil && provider.Kind() != jsonwire.Object {
		return nil, errors.New("OPENCODE_CONFIG_CONTENT provider must be a JSON object when present.")
	}
	if providers := parsed.Find("providers"); providers != nil && providers.Kind() != jsonwire.Object {
		return nil, errors.New("OPENCODE_CONFIG_CONTENT providers must be a JSON object when present.")
	}
	if schema := parsed.Find("$schema"); schema == nil || schema.Kind() != jsonwire.String {
		parsed.Set("$schema", jsonwire.StringValue(exportProviderSchema))
	}
	provider := parsed.Find("provider")
	if provider == nil {
		provider = jsonwire.ObjectValue()
		parsed.Set("provider", provider)
	}
	provider.Set(exportProviderID, blocks.v1)
	providers := parsed.Find("providers")
	if providers == nil {
		providers = jsonwire.ObjectValue()
		parsed.Set("providers", providers)
	}
	providers.Set(exportProviderID, blocks.v2)
	return parsed, nil
}

// opencodeSerializeContent mirrors serializeOpencodeRuntimeConfig:
// JSON.stringify — compact, ECMAScript key order.
func opencodeSerializeContent(value *jsonwire.Value) (string, error) {
	raw, err := value.Encode()
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider-override detection (opencodeProviderOverridePath + helpers in
// opencode.ts): a global or project opencode.json/jsonc that already defines
// `provider.opencodex` / `providers.opencodex` is reported on stderr so the
// user knows the inline runtime layer outranks it for this launch.

// opencodeStripJSONComments mirrors stripJsonComments: `//` and block comments
// are removed outside string literals, escape-aware.
func opencodeStripJSONComments(text string) string {
	var out strings.Builder
	inString := false
	inLine := false
	inBlock := false
	runes := []rune(text)
	for i := 0; i < len(runes); i++ {
		ch := runes[i]
		var next rune
		if i+1 < len(runes) {
			next = runes[i+1]
		}
		if inLine {
			if ch == '\n' {
				inLine = false
				out.WriteRune(ch)
			}
			continue
		}
		if inBlock {
			if ch == '\n' {
				out.WriteRune(ch)
			} else if ch == '*' && next == '/' {
				inBlock = false
				i++
			}
			continue
		}
		if inString {
			out.WriteRune(ch)
			if ch == '\\' {
				if i+1 < len(runes) {
					out.WriteRune(runes[i+1])
					i++
				}
				continue
			}
			if ch == '"' {
				inString = false
			}
			continue
		}
		if ch == '"' {
			inString = true
			out.WriteRune(ch)
			continue
		}
		if ch == '/' && next == '/' {
			inLine = true
			i++
			continue
		}
		if ch == '/' && next == '*' {
			inBlock = true
			i++
			continue
		}
		out.WriteRune(ch)
	}
	return out.String()
}

// opencodeStripTrailingCommas mirrors stripTrailingCommas: drop commas that
// sit directly before `}` or `]`, ignoring string contents.
func opencodeStripTrailingCommas(text string) string {
	var out strings.Builder
	inString := false
	runes := []rune(text)
	for i := 0; i < len(runes); i++ {
		ch := runes[i]
		if inString {
			out.WriteRune(ch)
			if ch == '\\' {
				if i+1 < len(runes) {
					out.WriteRune(runes[i+1])
					i++
				}
				continue
			}
			if ch == '"' {
				inString = false
			}
			continue
		}
		if ch == '"' {
			inString = true
			out.WriteRune(ch)
			continue
		}
		if ch == ',' {
			j := i + 1
			for j < len(runes) && isJSONCWhitespace(runes[j]) {
				j++
			}
			if j < len(runes) && (runes[j] == '}' || runes[j] == ']') {
				continue
			}
		}
		out.WriteRune(ch)
	}
	return out.String()
}

// isJSONCWhitespace mirrors JS /\s/: Unicode whitespace plus line terminators.
func isJSONCWhitespace(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\r', '\v', '\f', 0x00a0, 0x1680,
		0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// opencodeParseJSONC mirrors parseJsonc: strict JSON.parse first; the tolerant
// comment/trailing-comma path only runs when that throws.
func opencodeParseJSONC(text string) (*jsonwire.Value, error) {
	if value, err := jsonwire.Parse([]byte(text)); err == nil {
		return value, nil
	}
	return jsonwire.Parse([]byte(opencodeStripTrailingCommas(opencodeStripJSONComments(text))))
}

// opencodeConfigFileDefinesProvider mirrors configFileDefinesProvider.
func opencodeConfigFileDefinesProvider(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	parsed, err := opencodeParseJSONC(string(raw))
	if err != nil || parsed.Kind() != jsonwire.Object {
		return false
	}
	if legacy := parsed.Find("provider"); legacy != nil && legacy.Kind() == jsonwire.Object {
		if legacy.Find(exportProviderID) != nil {
			return true
		}
	}
	if v2 := parsed.Find("providers"); v2 != nil && v2.Kind() == jsonwire.Object {
		if v2.Find(exportProviderID) != nil {
			return true
		}
	}
	return false
}

// opencodeFindGitRoot mirrors findGitRoot: the nearest ancestor with a .git
// entry (file or directory), or "" when none exists above start.
func opencodeFindGitRoot(start string) string {
	dir := start
	for {
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

var opencodeProjectConfigFilenames = []string{"opencode.json", "opencode.jsonc"}

// opencodeGlobalConfigPath mirrors opencodeGlobalConfigPath: $XDG_CONFIG_HOME
// when set, else <home>/.config, joined with opencode/opencode.json.
func opencodeGlobalConfigPath(xdgConfigHome, home string) string {
	base := strings.TrimSpace(xdgConfigHome)
	if base == "" {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "opencode", "opencode.json")
}

// opencodeProviderOverridePath mirrors opencodeProviderOverridePath: the first
// global or project config (walking upward from cwd, stopping at the git root)
// that defines our provider key in either generation.
func opencodeProviderOverridePath(cwd, xdgConfigHome, home string) string {
	globalPath := opencodeGlobalConfigPath(xdgConfigHome, home)
	if opencodeConfigFileDefinesProvider(globalPath) {
		return globalPath
	}
	gitRoot := opencodeFindGitRoot(cwd)
	dir := cwd
	for {
		for _, name := range opencodeProjectConfigFilenames {
			candidate := filepath.Join(dir, name)
			if opencodeConfigFileDefinesProvider(candidate) {
				return candidate
			}
		}
		if gitRoot != "" && dir == gitRoot {
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog fetch (fetchOpencodeProxyModels in opencode.ts).

// opencodeFetchTimeout mirrors OPENCODE_PROXY_MODELS_TIMEOUT_MS.
const opencodeFetchTimeout = 8 * time.Second

// opencodeFetchCatalog performs the authenticated GET /api/models against the
// live proxy and returns the parsed body when it is an array. The error texts
// are cmdOpencode's; the caller supplies the `❌ Could not fetch …` prefix.
func opencodeFetchCatalog(deps Deps, state RuntimeState, apiKey string) (*jsonwire.Value, error) {
	request, err := http.NewRequest(http.MethodGet, baseURL(state)+"/api/models", nil)
	if err != nil {
		return nil, fmt.Errorf("Management API is unreachable: %s", err)
	}
	request.Header.Set("Accept", "application/json")
	if token := strings.TrimSpace(apiKey); token != "" {
		request.Header.Set("X-OpenCodex-API-Key", token)
	}
	client := deps.HTTPClient
	if client == nil || client.Timeout == 0 {
		client = &http.Client{Timeout: opencodeFetchTimeout}
	}
	response, doErr := client.Do(request)
	if doErr != nil {
		if isHTTPTimeout(doErr) {
			return nil, errors.New("Management API timed out while fetching /api/models.")
		}
		return nil, fmt.Errorf("Management API is unreachable: %s", doErr)
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if readErr != nil {
		return nil, fmt.Errorf("Management API is unreachable: %s", readErr)
	}
	body, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		body = nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message := fmt.Sprintf("Management request failed (%d)", response.StatusCode)
		if body != nil && body.Kind() == jsonwire.Object {
			if errorMember := body.Find("error"); errorMember != nil && errorMember.Kind() == jsonwire.String {
				message = errorMember.String()
			}
		}
		return nil, errors.New(message)
	}
	if body == nil || body.Kind() != jsonwire.Array {
		return nil, errors.New("Management API returned an unexpected /api/models payload.")
	}
	return body, nil
}

// isHTTPTimeout reports whether the error came from a client deadline.
func isHTTPTimeout(err error) bool {
	var netErr interface{ Timeout() bool }
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	return false
}

package ocxcli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// key login is the Go-owned half of `ocx login <provider>` for the openai-chat
// key slice (issue #57). The flow mirrors TypeScript handleKeyLogin in
// src/oauth/login-cli.ts byte-for-byte: collision preflight, dashboard banner +
// open, interactive API-key read, optional {placeholder} baseUrl resolution,
// best-effort validation, merge + persist, then the live-provider reload.

const (
	keyNamespaceCollisionError = "provider name must not collide with a configured Codex account namespace"
	keyValidationElapsed       = "   validating… "
	keyAddedPrefix            = "✅ "
	keyAddedSuffix            = " added. Try: ocx sync"
)

var keyBaseURLPlaceholder = regexp.MustCompile(`\{[^}]*\}`)

// keyValidation tri-states the probe outcome exactly like TS validateApiKey.
type keyValidation int

const (
	keyValid keyValidation = iota
	keyInvalid
	keyUnknown
)

// runLogin dispatches the Go-owned key-provider login slice. OwnershipFor has
// already gated this: only a provider name in keyLoginProviders reaches here.
func runLogin(args []string, deps Deps) int {
	if len(args) != 1 {
		// Only reachable if the ownership table and dispatch drift; the bare
		// command and non-key providers delegate to the TS owner.
		fmt.Fprintln(deps.Stderr, "Usage: ocx login <provider>")
		return ExitFailure
	}
	name := args[0]
	def, ok := keyLoginProviders[name]
	if !ok {
		fmt.Fprintln(deps.Stderr, "Usage: ocx login <provider>")
		return ExitFailure
	}

	raw, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	if keyNamespaceCollides(raw["codexAccountNamespaces"], name) {
		fmt.Fprintf(deps.Stderr, "Error: %s.\n", keyNamespaceCollisionError)
		return ExitFailure
	}

	fmt.Fprintf(deps.Stdout, "\n🔑 %s — opening %s so you can create/copy an API key...\n", def.Label, def.DashboardURL)
	deps.OpenURL(def.DashboardURL)

	reader := bufio.NewReader(deps.Stdin)
	key := keyPromptReadLine(reader, fmt.Sprintf("Paste your %s API key: ", def.Label), deps.Stdout)

	// Template URL with placeholders needs resolution before saving.
	baseURL := def.BaseURL
	if keyBaseURLPlaceholder.MatchString(baseURL) {
		resolved := keyPromptReadLine(reader, fmt.Sprintf("Your endpoint URL (%s): ", baseURL), deps.Stdout)
		if resolved == "" {
			fmt.Fprintln(deps.Stderr, "A resolved URL is required — replace the {placeholder} with your actual value.")
			return ExitFailure
		}
		baseURL = resolved
	}
	if key == "" {
		fmt.Fprintln(deps.Stderr, "No key entered.")
		return ExitFailure
	}

	fmt.Fprint(deps.Stdout, keyValidationElapsed)
	valid := keyValidateAPIKey(deps.HTTPClient, def, baseURL, key)
	switch valid {
	case keyValid:
		fmt.Fprintln(deps.Stdout, "valid ✅")
	case keyInvalid:
		fmt.Fprintln(deps.Stdout, "INVALID ❌")
		fmt.Fprintln(deps.Stderr, "Provider rejected the key. Not saved.")
		return ExitFailure
	default:
		fmt.Fprintln(deps.Stdout, "couldn't validate (may still work)")
	}

	provider := keyProviderRow(def, key, baseURL)
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	if keyNamespaceCollides(cfg["codexAccountNamespaces"], name) {
		fmt.Fprintf(deps.Stderr, "Error: %s.\n", keyNamespaceCollisionError)
		return ExitFailure
	}
	if err := keyMergeAndPersist(cfg, name, provider); err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	fmt.Fprintf(deps.Stdout, "%s%s%s\n", keyAddedPrefix, def.Label, keyAddedSuffix)
	keyWarnIfReloadSkipped(deps, keyNotifyRunningProxy(deps, name))
	return ExitOK
}

// keyPromptReadLine writes the readline-style prompt to stdout (node readline
// writes the prompt even when stdin is a pipe) and reads one trimmed line.
func keyPromptReadLine(reader *bufio.Reader, prompt string, stdout io.Writer) string {
	fmt.Fprint(stdout, prompt)
	line, err := reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return ""
	}
	return strings.TrimSpace(line)
}

// keyNamespaceCollides mirrors codexAccountNamespaceProviderCollisionError: any
// configured Codex account namespace that case-insensitively equals the
// provider name blocks the login (provider ids compare case-insensitively at
// namespace admission boundaries).
func keyNamespaceCollides(namespaces any, providerName string) bool {
	obj, ok := namespaces.(map[string]any)
	if !ok || len(obj) == 0 {
		return false
	}
	normalized := strings.ToLower(providerName)
	for namespace := range obj {
		if strings.ToLower(namespace) == normalized {
			return true
		}
	}
	return false
}

// keyValidateAPIKey mirrors the openai-chat branch of TS validateApiKey: probe
// {baseUrl}/models with an Authorization Bearer header, 8s timeout, redirect
// treated as error. 200 -> valid; 401/403 -> invalid; anything else or a
// transport error -> unknown ("couldn't validate (may still work)").
func keyValidateAPIKey(client *http.Client, def keyLoginProvider, baseURL, key string) keyValidation {
	client = keyProbeClient(client)
	probeURL := strings.TrimSuffix(baseURL, "/") + "/models"
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, probeURL, nil)
	if err != nil {
		return keyUnknown
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := client.Do(req)
	if err != nil {
		return keyUnknown
	}
	defer resp.Body.Close()
	// Drain a small body so the connection can be reused; a huge error body is
	// not worth buffering for a probe.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode == http.StatusOK {
		return keyValid
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return keyInvalid
	}
	return keyUnknown
}

// keyProbeClient returns a client with an 8-second probe timeout and redirects
// treated as errors (matching fetch redirect: "error"), reusing a caller-supplied
// transport when one is present so tests can point at an httptest server.
func keyProbeClient(client *http.Client) *http.Client {
	if client != nil {
		out := *client
		out.Timeout = 8 * time.Second
		out.CheckRedirect = func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}
		return &out
	}
	return &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

// keyProviderRow builds the provider row the login persists, mirroring
// providerConfigFromKeyLoginProvider for the minimal keyLoginProvider seed:
// adapter/baseUrl/apiKey/defaultModel. The classification fields are
// deliberately omitted — the Go runtime enriches them from the registry the
// same way the TS runtime does, and the table is not the classification source.
func keyProviderRow(def keyLoginProvider, key, baseURL string) map[string]any {
	row := map[string]any{
		"adapter": def.Adapter,
		"baseUrl": baseURL,
		"apiKey":  key,
	}
	if def.DefaultModel != "" {
		row["defaultModel"] = def.DefaultModel
	}
	return row
}

// keyMergeAndPersist merges the fresh row over the existing providers map entry
// (carrying operator-owned fields the preset cannot know — currently the
// modelCosts overlay) and writes the config, mirroring mergeKeyLoginProviderRow
// + saveConfig in login-cli.ts. Unlike the CLI family's config-writing verbs it
// does NOT require defaultProvider: login saves a provider without promoting it
// to default, exactly like the TypeScript flow.
func keyMergeAndPersist(cfg map[string]any, name string, provider map[string]any) error {
	providers, _ := cfg["providers"].(map[string]any)
	if providers == nil {
		providers = map[string]any{}
		cfg["providers"] = providers
	}
	if old, ok := providers[name].(map[string]any); ok && old["modelCosts"] != nil {
		provider["modelCosts"] = old["modelCosts"]
	}
	providers[name] = provider
	return config.SaveRaw(cfg)
}

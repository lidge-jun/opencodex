package sidecar

// Direct non-streaming provider relay for the data-plane seam (ticket #27,
// devlog 036). When the operator has turned the relay on
// (OPENCODEX_GO_HOTPATH_RELAY, Config.HotPathRelay) and a request qualifies,
// the sidecar replaces the #24 private parent bridge with a direct upstream
// relay for ONE provider class: a key-mode `openai-responses` provider whose
// Responses wire needs no translation. Non-streaming requests can use the
// whole-body repair below; streaming requests qualify only when their selected
// provider needs no stream-time rewrite. Everything else stays on the bridge
// so the TypeScript pipeline remains the oracle.
//
// The relay reproduces what the TS pipeline does for the qualifying subset,
// byte for byte (verified against the TS oracle):
//
//   - outbound: POST <openaiResponsesUrl(baseUrl)>/v1/responses with the seam
//     request body verbatim, content-type application/json, and the provider
//     Authorization when an env/literal apiKey resolves;
//   - response: 2xx JSON bodies get the whole-body field backfill
//     (responses_repair.go) and re-serialisation only when a field changed;
//     non-JSON 2xx and non-empty non-2xx bodies are relayed verbatim with the
//     upstream content-type; a valid upstream Retry-After is preserved and an
//     invalid one dropped.
//
// Deliberately NOT ported (documented seam-period divergence, routing ticket
// #30 territory): pre-stream retry loops, synthetic 429 Retry-After defaults,
// quota/cyber-policy classification, and empty-body error envelopes.

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// HotPathRelayEnv is the independent gate for the direct provider relay. It is
// read by the sidecar process at request time; the TypeScript front door only
// declares the constant (src/server/hot-path-seam.ts) and passes the
// environment through at spawn.
const HotPathRelayEnv = "OPENCODEX_GO_HOTPATH_RELAY"

// Reserved canonical provider names whose routing depends on native OpenAI
// family logic (forward mode, account pools, tiers). Those providers never
// qualify for the #27 relay; the bridge keeps serving them.
var reservedOpenAIFamilyProviders = map[string]bool{
	"openai":        true,
	"openai-multi":  true,
	"openai-apikey": true,
	"chatgpt":       true,
}

// Blocked metadata endpoints mirror the always-denied set in
// src/lib/destination-policy.ts. They are refused even with allowPrivateNetwork.
var blockedMetadataHosts = map[string]bool{
	"instance-data.ec2.internal": true,
	"metadata.azure.internal":    true,
	"metadata.google.internal":   true,
	"169.254.169.254":            true,
	"169.254.170.2":              true,
	"100.100.100.200":            true,
	"fd00:ec2::254":              true,
}

// relay-blocking request headers: their presence means the TS pipeline would
// engage Codex pool / sub-agent / attestation / surface behaviour the relay
// does not reproduce, so the request stays on the bridge.
var relayBlockingRequestHeaders = []string{
	"x-codex-parent-thread-id",
	"x-openai-subagent",
	"x-codex-turn-metadata",
	"x-chatgpt-account-id",
	"chatgpt-account-id",
	"x-oai-attestation",
	"x-opencodex-vision-describe",
	"cookie",
}

// relayPlan is the outcome of the relay-safe predicate: everything the sidecar
// needs to make the direct upstream call for one admitted request.
type relayPlan struct {
	providerName string
	modelID      string
	endpoint     string // full POST target URL
	apiKey       string // resolved bearer secret, "" when the provider has none
	streaming    bool
}

// resolveRelayAPIKey resolves a provider apiKey the way the TS key store does:
// ${NAME} / $NAME read the environment, everything else is the literal value.
// A keychain: reference returns ok=false so the caller keeps the request on the
// bridge (the sidecar has no keychain access).
func resolveRelayAPIKey(raw string) (string, bool) {
	if raw == "" {
		return "", true
	}
	if strings.HasPrefix(raw, "keychain:") {
		return "", false
	}
	if strings.HasPrefix(raw, "${") && strings.HasSuffix(raw, "}") {
		name := raw[2 : len(raw)-1]
		return os.Getenv(name), true
	}
	if strings.HasPrefix(raw, "$") {
		return os.Getenv(raw[1:]), true
	}
	return raw, true
}

// openaiResponsesRelayURL mirrors src/adapters/openai-responses-url.ts:
// strip trailing slashes, a trailing /responses endpoint, and a trailing /v1,
// then append /v1/responses.
func openaiResponsesRelayURL(baseURL string) (string, bool) {
	trimmed := strings.TrimSpace(baseURL)
	parsed, err := url.Parse(trimmed)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.Host == "" {
		return "", false
	}
	path := strings.TrimRight(parsed.Path, "/")
	if rest := strings.TrimRight(path, "/"); strings.HasSuffix(rest, "/responses") {
		path = strings.TrimRight(rest[:len(rest)-len("/responses")], "/")
	}
	if rest := strings.TrimRight(path, "/"); strings.HasSuffix(rest, "/v1") {
		path = strings.TrimRight(rest[:len(rest)-len("/v1")], "/")
	}
	out := *parsed
	out.Path = path + "/v1/responses"
	out.RawPath = ""
	out.RawQuery = ""
	out.Fragment = ""
	return out.String(), true
}

// relayDestinationAllowed is the conservative destination gate for the direct
// relay. Loopback/private/link-local/metadata destinations require the
// operator's allowPrivateNetwork opt-in exactly like the TS policy; metadata
// and unspecified endpoints are always refused. Hostname destinations are
// accepted as-is (the TS sync path only hard-fails literal non-public
// destinations; DNS-resolved rebinding is a recorded residual there too).
func relayDestinationAllowed(endpoint string, allowPrivateNetwork bool) bool {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return false
	}
	host := strings.TrimSuffix(parsed.Hostname(), ".")
	if host == "" {
		return false
	}
	if blockedMetadataHosts[strings.ToLower(host)] {
		return false
	}
	local := host == "localhost" || strings.HasSuffix(host, ".localhost")
	if !local {
		if ip := net.ParseIP(host); ip != nil {
			if ip.IsLoopback() || ip.IsPrivate() {
				local = true
			}
			if ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() {
				// Unspecified, link-local and multicast are always denied, matching
				// the TS classifier's unconditional refusals.
				return false
			}
		}
	}
	if local {
		return allowPrivateNetwork
	}
	return true
}

// relayRefusal names why a request did not qualify for the direct relay. It is
// surfaced in tests so each predicate leg is pinned.
type relayRefusal struct {
	reason string
}

func refuseRelay(format string, args ...any) *relayRefusal {
	return &relayRefusal{reason: fmt.Sprintf(format, args...)}
}

// bodyObjectMember returns a top-level body member, nil when absent.
func bodyMember(root *jsonwire.Value, key string) *jsonwire.Value {
	if root == nil || root.Kind() != jsonwire.Object {
		return nil
	}
	return root.Find(key)
}

// requestQualifiesForRelay evaluates the relay-safe predicate over the config
// file and one admitted request body. Returns a relayPlan when the sidecar can
// serve the request directly, or a refusal naming the failing leg. A nil config
// root (no config file) is a refusal: without the operator's provider data the
// sidecar invents nothing.
func requestQualifiesForRelay(cfg Config, contentType string, headers http.Header, body []byte) (*relayPlan, *relayRefusal) {
	if !cfg.HotPathRelay {
		return nil, refuseRelay("relay disabled")
	}
	if contentType == "" || !strings.Contains(strings.ToLower(contentType), "application/json") {
		return nil, refuseRelay("content-type is not application/json")
	}
	for _, name := range relayBlockingRequestHeaders {
		if headers.Get(name) != "" {
			return nil, refuseRelay("request carries %s", name)
		}
	}
	if strings.EqualFold(headers.Get("x-opencodex-grok"), "1") {
		return nil, refuseRelay("request is a grok-surface request")
	}

	root, parseErr := jsonwire.Parse(body)
	if parseErr != nil || root.Kind() != jsonwire.Object {
		return nil, refuseRelay("body is not a JSON object")
	}
	streaming := false
	if stream := bodyMember(root, "stream"); stream != nil && stream.Kind() == jsonwire.Bool {
		streaming = stream.Bool()
	}
	modelValue := bodyMember(root, "model")
	if modelValue == nil || modelValue.Kind() != jsonwire.String {
		return nil, refuseRelay("model is not a string")
	}
	modelID := modelValue.String()
	if modelID == "" || strings.Contains(modelID, "/") {
		return nil, refuseRelay("model id is empty or namespaced")
	}
	if bodyMember(root, "previous_response_id") != nil {
		return nil, refuseRelay("request carries previous_response_id")
	}
	if refusal := requestBodyRelayRefusal(root); refusal != nil {
		return nil, refusal
	}

	loaded := loadRelayConfigOrdered(cfg.ConfigDir)
	if loaded == nil || loaded.Kind() != jsonwire.Object {
		return nil, refuseRelay("provider config unavailable")
	}
	if refusal := configLevelRelayRefusal(loaded); refusal != nil {
		return nil, refusal
	}

	providers := loaded.Find("providers")
	if providers == nil || providers.Kind() != jsonwire.Object {
		return nil, refuseRelay("no providers configured")
	}
	plan, refusal := resolveRelayRoute(providers, loaded, modelID)
	if refusal != nil {
		return nil, refusal
	}
	plan.modelID = modelID
	if streaming {
		provider := providers.Find(plan.providerName)
		if refusal := streamRelayRefusal(provider, modelID); refusal != nil {
			return nil, refusal
		}
		plan.streaming = true
	}
	return plan, nil
}

// loadRelayConfigOrdered reads the operator config.json into a jsonwire tree,
// resolving the directory exactly like the config echo routes: an explicit dir
// (unit tests) wins, otherwise config.Path() (OPENCODEX_HOME then
// ~/.opencodex). A missing or malformed file yields nil, which the predicate
// treats as a refusal rather than inventing provider data.
func loadRelayConfigOrdered(configDir string) *jsonwire.Value {
	var path string
	var err error
	if configDir != "" {
		path = filepath.Join(configDir, "config.json")
	} else {
		path, err = config.Path()
	}
	if err != nil {
		return nil
	}
	raw, readErr := os.ReadFile(path)
	if readErr != nil {
		return nil
	}
	root, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		return nil
	}
	return root
}

// requestBodyRelayRefusal rejects body features whose outbound bytes the TS
// pipeline would rewrite or whose request-local state it would engage.
func requestBodyRelayRefusal(root *jsonwire.Value) *relayRefusal {
	for _, key := range []string{"_compaction_request", "compaction_trigger"} {
		if bodyMember(root, key) != nil {
			return refuseRelay("request carries %s", key)
		}
	}
	if tools := bodyMember(root, "tools"); tools != nil {
		if tools.Kind() != jsonwire.Array {
			return refuseRelay("tools is not an array")
		}
		for _, tool := range tools.Elements() {
			if tool == nil || tool.Kind() != jsonwire.Object {
				return refuseRelay("tool entry is not an object")
			}
			// Namespaced / hosted tools (web_search, image_generation, MCP
			// custom tools, …) are normalized or refused by the TS pipeline;
			// the relay only claims plain function tools.
			if tool.Find("namespace") != nil {
				return refuseRelay("tool carries a namespace")
			}
			typeName, _ := stringMember(tool, "type")
			if typeName != "function" {
				return refuseRelay("tool type %q is not relay-safe", typeName)
			}
		}
	}
	if input := bodyMember(root, "input"); input != nil {
		if input.Kind() == jsonwire.Array {
			for _, item := range input.Elements() {
				if item == nil || item.Kind() != jsonwire.Object {
					return refuseRelay("input item is not an object")
				}
				if item.Find("encrypted_content") != nil {
					return refuseRelay("input carries encrypted_content")
				}
				typeName, _ := stringMember(item, "type")
				if strings.HasPrefix(typeName, "compaction") || typeName == "custom_tool" || typeName == "reasoning_items" {
					return refuseRelay("input item type %q is not relay-safe", typeName)
				}
			}
		} else if input.Kind() != jsonwire.String {
			return refuseRelay("input is neither a string nor an array")
		}
	}
	return nil
}

// streamRelayRefusal rejects a stream whenever the selected provider would
// make the TypeScript path rewrite client-facing SSE. Empty/false repair
// configuration remains inert and therefore relay-safe. Model-list matches
// mirror the case-insensitive check used by routeUsesContentChannelReasoning.
func streamRelayRefusal(provider *jsonwire.Value, modelID string) *relayRefusal {
	if provider == nil || provider.Kind() != jsonwire.Object {
		return refuseRelay("stream provider config unavailable")
	}
	if repair := provider.Find("responsesItemIdRepair"); responsesItemIDRepairArmed(repair) {
		return refuseRelay("provider enables responsesItemIdRepair")
	}
	if snapshot, ok := boolMember(provider, "responsesSnapshotRepair"); ok && snapshot {
		return refuseRelay("provider enables responsesSnapshotRepair")
	}
	if stateless, ok := boolMember(provider, "statelessResponses"); ok && stateless {
		return refuseRelay("provider enables statelessResponses")
	}
	if modelInProviderList(provider.Find("preserveReasoningContentModels"), modelID) {
		return refuseRelay("provider preserves reasoning content for model %q", modelID)
	}
	return nil
}

func responsesItemIDRepairArmed(repair *jsonwire.Value) bool {
	if repair == nil || repair.Kind() != jsonwire.Object {
		return false
	}
	for _, key := range []string{"repairMissingTerminalIds", "repairInvalidIds"} {
		if enabled, ok := boolMember(repair, key); ok && enabled {
			return true
		}
	}
	for _, key := range []string{"message", "reasoning"} {
		if values := repair.Find(key); values != nil && values.Kind() == jsonwire.Array && len(values.Elements()) > 0 {
			return true
		}
	}
	return false
}

func modelInProviderList(values *jsonwire.Value, modelID string) bool {
	if values == nil || values.Kind() != jsonwire.Array {
		return false
	}
	for _, value := range values.Elements() {
		if value != nil && value.Kind() == jsonwire.String && strings.EqualFold(value.String(), modelID) {
			return true
		}
	}
	return false
}

// configLevelRelayRefusal rejects config shapes whose routing logic the relay
// does not reproduce: combos, routing profiles, shadow intercept, and blocked
// model redirects. The request stays on the bridge when any is present.
// configLevelRelayRefusal rejects config shapes whose routing logic the relay
// does not reproduce: combos, routing profiles, shadow intercept, and blocked
// model redirects. The request stays on the bridge when any is present.
func configLevelRelayRefusal(loaded *jsonwire.Value) *relayRefusal {
	if combos := loaded.Find("combos"); combos != nil && combos.Kind() == jsonwire.Object && len(combos.Members()) > 0 {
		return refuseRelay("config defines combos")
	}
	if profiles := loaded.Find("routingProfiles"); profiles != nil && profiles.Kind() == jsonwire.Object && len(profiles.Members()) > 0 {
		return refuseRelay("config defines routing profiles")
	}
	if redirects := loaded.Find("blockedModelRedirects"); redirects != nil && redirects.Kind() == jsonwire.Object && len(redirects.Members()) > 0 {
		return refuseRelay("config defines blocked model redirects")
	}
	if shadow := loaded.Find("shadowCallIntercept"); shadow != nil && shadow.Kind() == jsonwire.Object {
		if enabled := shadow.Find("enabled"); enabled != nil && enabled.Kind() == jsonwire.Bool && enabled.Bool() {
			return refuseRelay("config enables shadow call intercept")
		}
	}
	return nil
}

// resolveRelayRoute mirrors the TS routeModelInternal subset the relay claims:
// configured-default-model, configured-model-list, and the default-provider
// fallback, iterating providers in file order. Reserved native OpenAI provider
// names, non-key auth modes, and non-openai-responses adapters never qualify.
func resolveRelayRoute(providers *jsonwire.Value, loaded *jsonwire.Value, modelID string) (*relayPlan, *relayRefusal) {
	active := activeRelayProviders(providers)
	if len(active) == 0 {
		return nil, refuseRelay("no enabled providers")
	}

	// configured-default-model pass.
	for _, entry := range active {
		if entry.provider.Find("defaultModel") == nil {
			continue
		}
		if defaultModel, ok := stringMember(entry.provider, "defaultModel"); ok && defaultModel == modelID {
			return relayPlanForProvider(entry.name, entry.provider)
		}
	}

	// configured-model-list pass (file order, first hit — the TS loop returns
	// on the first active provider whose list matches).
	for _, entry := range active {
		models := entry.provider.Find("models")
		if models == nil || models.Kind() != jsonwire.Array {
			continue
		}
		for _, candidate := range models.Elements() {
			if candidate.Kind() == jsonwire.String && candidate.String() == modelID {
				return relayPlanForProvider(entry.name, entry.provider)
			}
		}
	}

	// default-provider fallback. Refuse the legacy chatgpt/openai-multi ids
	// exactly like routeModelInternal throws for them.
	defaultRaw, ok := stringMember(loaded, "defaultProvider")
	if !ok {
		return nil, refuseRelay("no defaultProvider configured")
	}
	if defaultRaw == "chatgpt" || defaultRaw == "openai-multi" {
		return nil, refuseRelay("default provider %q is not relay-safe", defaultRaw)
	}
	for _, entry := range active {
		if entry.name == defaultRaw {
			return relayPlanForProvider(entry.name, entry.provider)
		}
	}
	return nil, refuseRelay("no provider owns model %q", modelID)
}

type relayProviderEntry struct {
	name     string
	provider *jsonwire.Value
}

func activeRelayProviders(providers *jsonwire.Value) []relayProviderEntry {
	var out []relayProviderEntry
	for _, member := range providers.Members() {
		if member.Value == nil || member.Value.Kind() != jsonwire.Object {
			continue
		}
		if disabled := member.Value.Find("disabled"); disabled != nil && disabled.Kind() == jsonwire.Bool && disabled.Bool() {
			continue
		}
		out = append(out, relayProviderEntry{name: member.Key, provider: member.Value})
	}
	return out
}

func boolMember(obj *jsonwire.Value, key string) (bool, bool) {
	if obj == nil || obj.Kind() != jsonwire.Object {
		return false, false
	}
	member := obj.Find(key)
	if member == nil || member.Kind() != jsonwire.Bool {
		return false, false
	}
	return member.Bool(), true
}

// relayPlanForProvider validates one candidate provider for the relay and
// builds the endpoint. Returns a refusal when the provider row needs TS-only
// machinery (forward/oauth auth, keychain keys, non-responses adapter, custom
// responses path, reserved name, blocked destination).
func relayPlanForProvider(name string, provider *jsonwire.Value) (*relayPlan, *relayRefusal) {
	if reservedOpenAIFamilyProviders[name] {
		return nil, refuseRelay("provider %q is a reserved native OpenAI row", name)
	}
	adapter, ok := stringMember(provider, "adapter")
	if !ok || adapter != "openai-responses" {
		return nil, refuseRelay("provider %q adapter %q is not openai-responses", name, adapter)
	}
	if authMode, ok := stringMember(provider, "authMode"); ok && authMode != "key" {
		return nil, refuseRelay("provider %q authMode %q is not key", name, authMode)
	}
	if provider.Find("responsesPath") != nil {
		return nil, refuseRelay("provider %q configures a custom responsesPath", name)
	}
	if headers := provider.Find("headers"); headers != nil && headers.Kind() == jsonwire.Object && len(headers.Members()) > 0 {
		// The direct relay owns only the canonical generated headers. Provider
		// headers may override or extend adapter output, so keep these rows on
		// the bridge until their exact adapter precedence is ported.
		return nil, refuseRelay("provider %q configures custom headers", name)
	}
	apiKey := ""
	if raw, ok := stringMember(provider, "apiKey"); ok {
		var keyOK bool
		apiKey, keyOK = resolveRelayAPIKey(raw)
		if !keyOK {
			return nil, refuseRelay("provider %q apiKey is a keychain reference", name)
		}
	}
	baseURL, ok := stringMember(provider, "baseUrl")
	if !ok {
		return nil, refuseRelay("provider %q has no baseUrl", name)
	}
	endpoint, ok := openaiResponsesRelayURL(baseURL)
	if !ok {
		return nil, refuseRelay("provider %q baseUrl is unusable", name)
	}
	allowPrivate := false
	if value, present := boolMember(provider, "allowPrivateNetwork"); present {
		allowPrivate = value
	}
	if !relayDestinationAllowed(endpoint, allowPrivate) {
		return nil, refuseRelay("provider %q baseUrl destination is not allowed", name)
	}
	return &relayPlan{providerName: name, endpoint: endpoint, apiKey: apiKey}, nil
}

// directRelayResponseBytes is the bounded upstream body the relay read plus the
// headers it must reproduce.
const (
	// Matches MAX_UPSTREAM_JSON_BODY_BYTES in the TS bounded-JSON read: far
	// above any legitimate non-streaming completion, and the same ceiling the
	// relay applies to a non-2xx body relay.
	maxRelayUpstreamBodyBytes = 32 * 1024 * 1024
)

// relayRetryAfterValidation mirrors validateClientRetryAfterHeader: numeric
// seconds (including the instant "0") and HTTP dates pass; empty/oversized/
// malformed values are dropped.
func relayRetryAfterValid(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || len(trimmed) > 128 {
		return false
	}
	if trimmed == "0" {
		return true
	}
	if seconds, err := strconv.Atoi(trimmed); err == nil && seconds > 0 {
		return true
	}
	if _, err := http.ParseTime(trimmed); err == nil {
		return true
	}
	return false
}

// doDirectRelay performs the upstream call and writes the client response.
// Status, content-type, and body semantics mirror the TS passthrough for the
// claimed subset: 2xx JSON bodies are repaired, everything else is relayed
// verbatim (bounded), and a valid upstream Retry-After survives while an
// invalid one is dropped.
func doDirectRelay(w http.ResponseWriter, r *http.Request, cfg Config, plan *relayPlan, body []byte) {
	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, plan.endpoint, bytes.NewReader(body))
	if err != nil {
		http.Error(w, "provider relay unavailable", http.StatusServiceUnavailable)
		return
	}
	upstreamReq.Header.Set("Content-Type", "application/json")
	if plan.apiKey != "" {
		upstreamReq.Header.Set("Authorization", "Bearer "+plan.apiKey)
	}
	upstreamResp, err := relayUpstreamClient().Do(upstreamReq)
	if err != nil {
		http.Error(w, "provider relay unavailable", http.StatusServiceUnavailable)
		return
	}
	defer upstreamResp.Body.Close()

	if plan.streaming {
		contentType := upstreamResp.Header.Get("Content-Type")
		if contentType != "" {
			w.Header().Set("Content-Type", contentType)
		} else if upstreamResp.StatusCode >= 200 && upstreamResp.StatusCode < 300 {
			// The successful Responses SSE path in TypeScript defaults a
			// missing upstream content type to the event-stream contract.
			contentType = "text/event-stream"
			w.Header().Set("Content-Type", contentType)
		} else {
			w.Header().Set("Content-Type", "application/json")
		}
		if retryAfter := upstreamResp.Header.Get("Retry-After"); relayRetryAfterValid(retryAfter) {
			w.Header().Set("Retry-After", strings.TrimSpace(retryAfter))
		}
		w.WriteHeader(upstreamResp.StatusCode)
		if upstreamResp.StatusCode >= 200 && upstreamResp.StatusCode < 300 && strings.Contains(strings.ToLower(contentType), "text/event-stream") {
			if err := relayResponsesSSEWithFlush(w, upstreamResp.Body); err != nil {
				fmt.Fprintf(os.Stderr, "ocx-sidecar: relay stream write: %v\n", err)
			}
		} else if err := streamCopyWithFlush(w, upstreamResp.Body); err != nil {
			fmt.Fprintf(os.Stderr, "ocx-sidecar: relay stream write: %v\n", err)
		}
		return
	}

	rawBody, readErr := io.ReadAll(io.LimitReader(upstreamResp.Body, maxRelayUpstreamBodyBytes+1))
	if readErr != nil || len(rawBody) > maxRelayUpstreamBodyBytes {
		// Oversized or unreadable body: refuse like the TS bounded read fails
		// closed, without emitting a partial body.
		http.Error(w, `{"error":{"message":"upstream response exceeded the safe body limit","type":"server_error","code":"upstream_server_error"}}`, http.StatusBadGateway)
		w.Header().Set("Content-Type", "application/json")
		return
	}
	contentType := upstreamResp.Header.Get("Content-Type")
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	if retryAfter := upstreamResp.Header.Get("Retry-After"); relayRetryAfterValid(retryAfter) {
		w.Header().Set("Retry-After", strings.TrimSpace(retryAfter))
	}

	out := rawBody
	if upstreamResp.StatusCode >= 200 && upstreamResp.StatusCode < 300 {
		if strings.Contains(strings.ToLower(contentType), "application/json") {
			// RepairResponsesJSONBody returns the original bytes untouched when
			// the backfill changed nothing or the body is not a JSON object, so
			// assigning unconditionally preserves raw-bytes relay parity.
			out, _ = RepairResponsesJSONBody(rawBody)
		}
	}
	w.WriteHeader(upstreamResp.StatusCode)
	if _, err := w.Write(out); err != nil {
		fmt.Fprintf(os.Stderr, "ocx-sidecar: relay write: %v\n", err)
	}
}

// relayResponsesSSEWithFlush feeds upstream transport chunks through the
// Responses field-backfill and terminal boundary, flushing each emitted block.
// It stops reading after the first terminal so a gateway cannot append frames
// after completion and hold the client request open.
func relayResponsesSSEWithFlush(w http.ResponseWriter, src io.Reader) error {
	stream := NewResponsesSSEStream()
	flusher, canFlush := w.(http.Flusher)
	write := func(out []byte) error {
		if len(out) == 0 {
			return nil
		}
		if _, err := w.Write(out); err != nil {
			return err
		}
		if canFlush {
			flusher.Flush()
		}
		return nil
	}
	buf := make([]byte, 32*1024)
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			out, err := stream.Feed(buf[:n])
			if err != nil {
				return err
			}
			if err := write(out); err != nil {
				return err
			}
			if stream.TerminalSeen() {
				tail, err := stream.Finish()
				if err != nil {
					return err
				}
				return write(tail)
			}
		}
		if readErr == io.EOF {
			out, err := stream.Finish()
			if err != nil {
				return err
			}
			if err := write(out); err != nil {
				return err
			}
			return nil
		}
		if readErr != nil {
			partial, err := stream.FinishPartial()
			if err != nil {
				return err
			}
			if err := write(partial); err != nil {
				return err
			}
			if stream.TerminalSeen() {
				if !stream.DoneSeen() {
					return write([]byte("data: [DONE]\n\n"))
				}
				return nil
			}
			// Go read errors have different text from Bun's fetch errors. Keep
			// the documented static TS fallback envelope for byte-stable tails.
			return write([]byte("\n\nevent: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"type\":\"upstream_error\",\"code\":\"upstream_reset\",\"message\":\"Upstream stream terminated unexpectedly\"},\"last_error\":{\"type\":\"upstream_error\",\"code\":\"upstream_reset\",\"message\":\"Upstream stream terminated unexpectedly\"}}}\n\ndata: [DONE]\n\n"))
		}
	}
}

// relayUpstreamClient reaches the configured provider without a system proxy
// (the parent bridge transport contract) and without following redirects, so a
// provider-supplied redirect can never carry the Authorization header to a
// different host.
func relayUpstreamClient() *http.Client {
	return &http.Client{
		Transport: bridgeTransport(),
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// Config helpers used by the relay; jsonwire re-export for tests.

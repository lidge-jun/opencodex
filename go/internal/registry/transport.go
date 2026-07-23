package registry

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const XaiGrokCLIBaseURL = "https://cli-chat-proxy.grok.com/v1"

var copilotEditorHeaders = map[string]string{
	"Copilot-Integration-Id": "vscode-chat",
	"Editor-Version":         "opencodex/0.1.0",
	"Editor-Plugin-Version":  "opencodex/0.1.0",
	"User-Agent":             "opencodex",
	"Accept":                 "application/json",
}

func ResolveProviderTransport(provider Provider, cred *types.AuthContext) (*types.Transport, error) {
	baseURL := provider.BaseURL
	headers := cloneStringMap(provider.StaticHeaders)
	if headers == nil {
		headers = make(map[string]string)
	}
	if cred != nil {
		for name, value := range cred.Headers {
			headers[name] = value
		}
		secret := cred.AccessToken
		if secret == "" {
			secret = cred.APIKey
		}
		if secret != "" {
			if provider.Adapter == "anthropic" && cred.APIKey != "" {
				setHeaderIfAbsent(headers, "x-api-key", secret)
			} else {
				setHeaderIfAbsent(headers, "Authorization", "Bearer "+secret)
			}
		}
	}
	switch provider.ID {
	case "xai":
		if provider.AuthKind == AuthOAuth || cred != nil && cred.Kind == "oauth" {
			baseURL = XaiGrokCLIBaseURL
			setHeaderIfAbsent(headers, "x-grok-client-identifier", "opencodex")
			setHeaderIfAbsent(headers, "x-grok-client-version", "0.2.93")
			setHeaderIfAbsent(headers, "x-xai-token-auth", "xai-grok-cli")
			setHeaderIfAbsent(headers, "x-authenticateresponse", "authenticate-response")
		}
		setHeaderIfAbsent(headers, "User-Agent", "opencodex-grok/0.2.93")
	case "github-copilot":
		if provider.AuthKind == AuthOAuth && !validCopilotURL(baseURL) {
			baseURL = "https://api.githubcopilot.com"
		}
		for name, value := range copilotEditorHeaders {
			setHeaderIfAbsent(headers, name, value)
		}
	}
	if _, err := url.ParseRequestURI(baseURL); err != nil {
		return nil, fmt.Errorf("resolve transport %s: invalid base URL: %w", provider.ID, err)
	}
	return &types.Transport{BaseURL: strings.TrimRight(baseURL, "/"), Headers: headers}, nil
}

func setHeaderIfAbsent(headers map[string]string, name, value string) {
	for existing := range headers {
		if strings.EqualFold(existing, name) {
			return
		}
	}
	headers[name] = value
}

func validCopilotURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "githubcopilot.com" || strings.HasSuffix(host, ".githubcopilot.com")
}

func DeriveXaiConversationID(cacheKey string) string {
	sum := sha256.Sum256([]byte(cacheKey))
	return hex.EncodeToString(sum[:16])
}

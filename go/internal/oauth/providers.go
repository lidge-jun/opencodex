package oauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	chatGPTClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
	chatGPTAuthURL  = "https://auth.openai.com/oauth/authorize"
	chatGPTTokenURL = "https://auth.openai.com/oauth/token"
	chatGPTScope    = "openid profile email offline_access api.connectors.read api.connectors.invoke"

	anthropicClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	anthropicAuthURL  = "https://claude.ai/oauth/authorize"
	anthropicTokenURL = "https://api.anthropic.com/v1/oauth/token"
	anthropicScope    = "org:create_api_key user:profile user:inference"
)

type ChatGPTFlow struct {
	Client     HTTPDoer
	ForceLogin bool
	mu         sync.Mutex
	verifier   string
}

func NewChatGPTFlow(client HTTPDoer) *ChatGPTFlow {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &ChatGPTFlow{Client: client}
}

func (f *ChatGPTFlow) CallbackOptions() CallbackOptions {
	return CallbackOptions{
		PreferredPort:    1455,
		Path:             "/auth/callback",
		CallbackHostname: "localhost",
		BindHostname:     "127.0.0.1",
		RedirectURI:      "http://localhost:1455/auth/callback",
	}
}

func (f *ChatGPTFlow) AuthorizationURL(_ context.Context, state, redirectURI string) (Authorization, error) {
	pkce, err := GeneratePKCE()
	if err != nil {
		return Authorization{}, err
	}
	f.mu.Lock()
	f.verifier = pkce.Verifier
	f.mu.Unlock()
	params := url.Values{
		"response_type":              {"code"},
		"client_id":                  {chatGPTClientID},
		"redirect_uri":               {redirectURI},
		"scope":                      {chatGPTScope},
		"code_challenge":             {pkce.Challenge},
		"code_challenge_method":      {"S256"},
		"state":                      {state},
		"codex_cli_simplified_flow":  {"true"},
		"originator":                 {"opencodex"},
		"id_token_add_organizations": {"true"},
	}
	if f.ForceLogin {
		params.Set("prompt", "login")
	}
	return Authorization{URL: chatGPTAuthURL + "?" + params.Encode(), Instructions: "Complete ChatGPT login in your browser."}, nil
}

func (f *ChatGPTFlow) Exchange(ctx context.Context, code, _ string, redirectURI string) (OAuthCredentials, error) {
	f.mu.Lock()
	verifier := f.verifier
	f.mu.Unlock()
	if verifier == "" {
		return OAuthCredentials{}, errors.New("ChatGPT PKCE verifier not initialized")
	}
	values := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {chatGPTClientID},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"code_verifier": {verifier},
	}
	return f.postToken(ctx, values, "ChatGPT token exchange")
}

func (f *ChatGPTFlow) Refresh(ctx context.Context, refreshToken string) (OAuthCredentials, error) {
	return f.postToken(ctx, url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {chatGPTClientID},
		"refresh_token": {refreshToken},
	}, "ChatGPT refresh")
}

func (f *ChatGPTFlow) postToken(ctx context.Context, values url.Values, operation string) (OAuthCredentials, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, chatGPTTokenURL, strings.NewReader(values.Encode()))
	if err != nil {
		return OAuthCredentials{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := f.Client.Do(req)
	if err != nil {
		return OAuthCredentials{}, fmt.Errorf("%s: %w", operation, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return OAuthCredentials{}, fmt.Errorf("%s response: %w", operation, err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return OAuthCredentials{}, safeOAuthHTTPError(operation, response.StatusCode, body)
	}
	var token tokenResponse
	if err := json.Unmarshal(body, &token); err != nil {
		return OAuthCredentials{}, fmt.Errorf("%s returned invalid JSON: %w", operation, err)
	}
	return token.chatGPTCredentials()
}

type AnthropicFlow struct {
	Client   HTTPDoer
	mu       sync.Mutex
	verifier string
}

func NewAnthropicFlow(client HTTPDoer) *AnthropicFlow {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &AnthropicFlow{Client: client}
}

func (f *AnthropicFlow) CallbackOptions() CallbackOptions {
	return CallbackOptions{PreferredPort: 54545, Path: "/callback", CallbackHostname: "localhost", BindHostname: "127.0.0.1"}
}

func (f *AnthropicFlow) AuthorizationURL(_ context.Context, state, redirectURI string) (Authorization, error) {
	pkce, err := GeneratePKCE()
	if err != nil {
		return Authorization{}, err
	}
	f.mu.Lock()
	f.verifier = pkce.Verifier
	f.mu.Unlock()
	params := url.Values{
		"code":                  {"true"},
		"client_id":             {anthropicClientID},
		"response_type":         {"code"},
		"redirect_uri":          {redirectURI},
		"scope":                 {anthropicScope},
		"code_challenge":        {pkce.Challenge},
		"code_challenge_method": {"S256"},
		"state":                 {state},
	}
	return Authorization{
		URL:          anthropicAuthURL + "?" + params.Encode(),
		Instructions: "Complete Claude login in your browser, then return to opencodex.",
	}, nil
}

func (f *AnthropicFlow) Exchange(ctx context.Context, code, state, redirectURI string) (OAuthCredentials, error) {
	if codePart, statePart, found := strings.Cut(code, "#"); found {
		code = codePart
		if statePart != "" {
			state = statePart
		}
	}
	f.mu.Lock()
	verifier := f.verifier
	f.mu.Unlock()
	if verifier == "" {
		return OAuthCredentials{}, errors.New("Anthropic PKCE verifier not initialized")
	}
	return f.postToken(ctx, map[string]any{
		"grant_type":    "authorization_code",
		"client_id":     anthropicClientID,
		"code":          code,
		"state":         state,
		"redirect_uri":  redirectURI,
		"code_verifier": verifier,
	}, "Anthropic token exchange", "")
}

func (f *AnthropicFlow) Refresh(ctx context.Context, refreshToken string) (OAuthCredentials, error) {
	return f.postToken(ctx, map[string]any{
		"grant_type":    "refresh_token",
		"client_id":     anthropicClientID,
		"refresh_token": refreshToken,
	}, "Anthropic refresh", refreshToken)
}

func (f *AnthropicFlow) postToken(ctx context.Context, payload map[string]any, operation, refreshFallback string) (OAuthCredentials, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return OAuthCredentials{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, anthropicTokenURL, strings.NewReader(string(body)))
	if err != nil {
		return OAuthCredentials{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	response, err := f.Client.Do(req)
	if err != nil {
		return OAuthCredentials{}, fmt.Errorf("%s: %w", operation, err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return OAuthCredentials{}, fmt.Errorf("%s response: %w", operation, err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return OAuthCredentials{}, safeOAuthHTTPError(operation, response.StatusCode, responseBody)
	}
	var token tokenResponse
	if err := json.Unmarshal(responseBody, &token); err != nil {
		return OAuthCredentials{}, fmt.Errorf("%s returned invalid JSON: %w", operation, err)
	}
	if token.RefreshToken == "" {
		token.RefreshToken = refreshFallback
	}
	return token.anthropicCredentials()
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	IDToken      string `json:"id_token"`
	Account      *struct {
		UUID         string `json:"uuid"`
		EmailAddress string `json:"email_address"`
	} `json:"account"`
}

func (t tokenResponse) chatGPTCredentials() (OAuthCredentials, error) {
	if t.AccessToken == "" {
		return OAuthCredentials{}, errors.New("ChatGPT token response has no access token")
	}
	return OAuthCredentials{
		Access:    t.AccessToken,
		Refresh:   t.RefreshToken,
		Expires:   time.Now().Add(time.Duration(defaultExpiresIn(t.ExpiresIn)) * time.Second).UnixMilli(),
		AccountID: extractChatGPTAccountID(t.IDToken, t.AccessToken),
		Email:     strings.ToLower(extractJWTClaim(t.IDToken, t.AccessToken, "email")),
		Source:    SourceOAuth,
	}, nil
}

func (t tokenResponse) anthropicCredentials() (OAuthCredentials, error) {
	if t.AccessToken == "" || t.RefreshToken == "" {
		return OAuthCredentials{}, errors.New("Anthropic token response is missing tokens")
	}
	credential := OAuthCredentials{
		Access:  t.AccessToken,
		Refresh: t.RefreshToken,
		Expires: time.Now().Add(time.Duration(defaultExpiresIn(t.ExpiresIn))*time.Second - 5*time.Minute).UnixMilli(),
		Source:  SourceOAuth,
	}
	if t.Account != nil {
		credential.AccountID = t.Account.UUID
		credential.Email = t.Account.EmailAddress
	}
	return credential, nil
}

func defaultExpiresIn(seconds int64) int64 {
	if seconds <= 0 {
		return 3600
	}
	return seconds
}

func extractChatGPTAccountID(tokens ...string) string {
	for _, token := range tokens {
		claims := decodeJWTClaims(token)
		if value, ok := claims["chatgpt_account_id"].(string); ok {
			return value
		}
		if namespace, ok := claims["https://api.openai.com/auth"].(map[string]any); ok {
			if value, ok := namespace["chatgpt_account_id"].(string); ok {
				return value
			}
		}
		if organizations, ok := claims["organizations"].([]any); ok && len(organizations) > 0 {
			if first, ok := organizations[0].(map[string]any); ok {
				if value, ok := first["id"].(string); ok {
					return value
				}
			}
		}
	}
	return ""
}

func extractJWTClaim(firstToken, secondToken, claim string) string {
	for _, token := range []string{firstToken, secondToken} {
		if value, ok := decodeJWTClaims(token)[claim].(string); ok {
			return value
		}
	}
	return ""
}

func decodeJWTClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var claims map[string]any
	if json.Unmarshal(payload, &claims) != nil {
		return nil
	}
	return claims
}

func safeOAuthHTTPError(operation string, status int, body []byte) error {
	var parsed struct {
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	_ = json.Unmarshal(body, &parsed)
	details := make([]string, 0, 2)
	if parsed.Error != "" {
		details = append(details, parsed.Error)
	}
	if parsed.ErrorDescription != "" {
		details = append(details, parsed.ErrorDescription)
	}
	detail := strings.Join(details, ": ")
	if detail == "" {
		detail = http.StatusText(status)
	}
	return fmt.Errorf("%s failed: HTTP %d %s", operation, status, detail)
}

// APIKeyCredential converts manual key input into a request-time auth config.
func APIKeyCredential(key, headerName, headerPrefix string) (ProviderAuthConfig, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return ProviderAuthConfig{}, errors.New("API key is required")
	}
	if headerName == "" {
		headerName = "Authorization"
	}
	if headerPrefix == "" && strings.EqualFold(headerName, "Authorization") {
		headerPrefix = "Bearer "
	}
	return ProviderAuthConfig{Mode: AuthModeAPIKey, APIKey: key, HeaderName: headerName, HeaderPrefix: headerPrefix}, nil
}

func ProviderFlow(provider string, client HTTPDoer) (OAuthFlow, error) {
	switch provider {
	case "chatgpt":
		return NewChatGPTFlow(client), nil
	case "anthropic":
		return NewAnthropicFlow(client), nil
	case "xai", "google-antigravity", "cursor", "kimi", "github-copilot", "kiro":
		return nil, fmt.Errorf("%w: %s", ErrNotImplemented, provider)
	default:
		return nil, fmt.Errorf("unknown OAuth provider %q", provider)
	}
}

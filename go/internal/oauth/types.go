package oauth

import (
	"context"
	"errors"
	"net/http"
	"time"
)

var (
	ErrNotImplemented     = errors.New("OAuth provider is not implemented")
	ErrLoginRequired      = errors.New("OAuth login required")
	ErrGenerationConflict = errors.New("credential generation changed")
	ErrNoUsableAccount    = errors.New("no usable account credential")
)

type CredentialSource string

const (
	SourceOAuth          CredentialSource = "oauth"
	SourceLocalCLI       CredentialSource = "local-cli"
	SourceCredentialFile CredentialSource = "credential-file"
	SourceEnvironment    CredentialSource = "environment"
	SourceManual         CredentialSource = "manual"
)

// OAuthCredentials is the persisted provider credential shape. Expires is epoch
// milliseconds to remain JSON-compatible with the TypeScript auth store.
type OAuthCredentials struct {
	Refresh    string           `json:"refresh"`
	Access     string           `json:"access"`
	Expires    int64            `json:"expires"`
	Email      string           `json:"email,omitempty"`
	AccountID  string           `json:"accountId,omitempty"`
	Source     CredentialSource `json:"source,omitempty"`
	ProjectID  string           `json:"projectId,omitempty"`
	APIBaseURL string           `json:"apiBaseUrl,omitempty"`
}

func (c OAuthCredentials) Expired(now time.Time, skew time.Duration) bool {
	return c.Expires <= now.Add(skew).UnixMilli()
}

type ProviderAccount struct {
	ID          string           `json:"id"`
	Alias       string           `json:"alias,omitempty"`
	Credential  OAuthCredentials `json:"credential"`
	NeedsReauth bool             `json:"needsReauth,omitempty"`
	AddedAt     int64            `json:"addedAt,omitempty"`
}

type ProviderAccountSet struct {
	ActiveAccountID string            `json:"activeAccountId"`
	Accounts        []ProviderAccount `json:"accounts"`
}

type AuthStore map[string]ProviderAccountSet

type AuthMode string

const (
	AuthModeOAuth   AuthMode = "oauth"
	AuthModeAPIKey  AuthMode = "key"
	AuthModeForward AuthMode = "forward"
)

// ProviderAuthConfig describes request-time authentication without coupling the
// OAuth package to the provider registry.
type ProviderAuthConfig struct {
	Mode         AuthMode
	APIKey       string
	HeaderName   string
	HeaderPrefix string
	UsePool      bool
}

type Authorization struct {
	URL          string
	Instructions string
}

// OAuthFlow is implemented by browser/device provider flows.
type OAuthFlow interface {
	AuthorizationURL(ctx context.Context, state, redirectURI string) (Authorization, error)
	Exchange(ctx context.Context, code, state, redirectURI string) (OAuthCredentials, error)
	Refresh(ctx context.Context, refreshToken string) (OAuthCredentials, error)
}

type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

type RefreshFunc func(ctx context.Context, refreshToken string) (OAuthCredentials, error)

type RefreshResult struct {
	Credential OAuthCredentials
	Generation string
	Refreshed  bool
	Superseded bool
}

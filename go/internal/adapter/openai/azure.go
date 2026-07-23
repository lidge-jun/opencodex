package openai

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const DefaultAzureAPIVersion = "2024-10-21"

type AzureAdapter struct {
	BaseURL    string
	Deployment string
	APIVersion string
	APIKey     string
	Client     *http.Client
	Headers    map[string]string
}

var _ types.Adapter = (*AzureAdapter)(nil)

func (a *AzureAdapter) BuildRequest(ctx context.Context, req *types.NormalizedRequest) (*http.Request, error) {
	if strings.TrimSpace(a.APIKey) == "" {
		return nil, fmt.Errorf("azure-openai requires a non-empty API key")
	}
	base, err := a.deploymentBaseURL(req)
	if err != nil {
		return nil, err
	}
	inner := ChatAdapter{BaseURL: base, Client: a.Client, Headers: a.Headers}
	httpReq, err := inner.BuildRequest(ctx, req)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Del("Authorization")
	httpReq.Header.Set("api-key", a.APIKey)
	query := httpReq.URL.Query()
	version := strings.TrimSpace(a.APIVersion)
	if version == "" {
		version = DefaultAzureAPIVersion
	}
	query.Set("api-version", version)
	httpReq.URL.RawQuery = query.Encode()
	httpReq.Header.Set("api-version", version)
	return httpReq, nil
}

func (a *AzureAdapter) deploymentBaseURL(req *types.NormalizedRequest) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(a.BaseURL), "/")
	if base == "" {
		return "", fmt.Errorf("azure-openai requires a base URL")
	}
	if strings.ContainsAny(base, "{}") {
		return "", fmt.Errorf("azure-openai base URL contains an unresolved placeholder")
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid Azure OpenAI base URL %q", base)
	}
	if strings.Contains(base, "/openai/deployments/") {
		return base, nil
	}
	deployment := strings.TrimSpace(a.Deployment)
	if deployment == "" && req != nil {
		deployment = req.ModelID
	}
	if deployment == "" {
		return "", fmt.Errorf("azure-openai requires a deployment name")
	}
	return base + "/openai/deployments/" + url.PathEscape(deployment), nil
}

func (a *AzureAdapter) ParseStream(ctx context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	return (&ChatAdapter{}).ParseStream(ctx, body)
}

func (a *AzureAdapter) ParseUnary(ctx context.Context, body []byte) ([]types.AdapterEvent, error) {
	return (&ChatAdapter{}).ParseUnary(ctx, body)
}

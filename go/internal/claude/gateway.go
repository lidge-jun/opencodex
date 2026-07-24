package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const gatewayCacheMaxResponseBytes = 4 << 20

type GatewayModelRow struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name,omitempty"`
}

type GatewayModelCache struct {
	BaseURL   string            `json:"baseUrl"`
	FetchedAt int64             `json:"fetchedAt"`
	Models    []GatewayModelRow `json:"models"`
}

func ClaudeConfigDir() (string, error) {
	if custom := os.Getenv("CLAUDE_CONFIG_DIR"); custom != "" {
		return custom, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve Claude config directory: %w", err)
	}
	return filepath.Join(home, ".claude"), nil
}

func WriteGatewayModelCache(baseURL string, models []GatewayModelRow, configDir string, now time.Time) (string, error) {
	parsed, err := url.ParseRequestURI(baseURL)
	if err != nil {
		return "", fmt.Errorf("invalid gateway base URL: %w", err)
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("invalid gateway base URL %q", baseURL)
	}
	usable := make([]GatewayModelRow, 0, len(models))
	for _, model := range models {
		lower := strings.ToLower(model.ID)
		if strings.HasPrefix(lower, "claude") || strings.HasPrefix(lower, "anthropic") {
			usable = append(usable, model)
		}
	}
	payload := GatewayModelCache{BaseURL: strings.TrimRight(baseURL, "/"), FetchedAt: now.UnixMilli(), Models: usable}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode gateway model cache: %w", err)
	}
	path := filepath.Join(configDir, "cache", "gateway-models.json")
	if err := atomicWriteFile(path, data, 0o600); err != nil {
		return "", fmt.Errorf("write gateway model cache: %w", err)
	}
	return path, nil
}

func ReadGatewayModelCache(path string) (GatewayModelCache, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return GatewayModelCache{}, fmt.Errorf("read gateway model cache: %w", err)
	}
	var cache GatewayModelCache
	if err := json.Unmarshal(data, &cache); err != nil {
		return GatewayModelCache{}, fmt.Errorf("decode gateway model cache: %w", err)
	}
	if cache.BaseURL == "" || cache.FetchedAt <= 0 || cache.Models == nil {
		return GatewayModelCache{}, fmt.Errorf("invalid gateway model cache")
	}
	return cache, nil
}

func GatewayModelCacheFresh(path, baseURL string, ttl time.Duration, now time.Time) bool {
	if ttl <= 0 {
		return false
	}
	cache, err := ReadGatewayModelCache(path)
	if err != nil || cache.BaseURL != strings.TrimRight(baseURL, "/") {
		return false
	}
	age := now.Sub(time.UnixMilli(cache.FetchedAt))
	return age >= 0 && age < ttl
}

func RefreshGatewayModelCache(ctx context.Context, client *http.Client, baseURL string, ttl time.Duration, configDir string, now time.Time) (string, bool, error) {
	baseURL = strings.TrimRight(baseURL, "/")
	path := filepath.Join(configDir, "cache", "gateway-models.json")
	if GatewayModelCacheFresh(path, baseURL, ttl, now) {
		return path, false, nil
	}
	if client == nil {
		client = http.DefaultClient
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/models?limit=1000&ids=cli", nil)
	if err != nil {
		return "", false, fmt.Errorf("create gateway model request: %w", err)
	}
	request.Header.Set("anthropic-version", "2023-06-01")
	response, err := client.Do(request)
	if err != nil {
		return "", false, fmt.Errorf("fetch gateway models: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 8<<10))
		return "", false, fmt.Errorf("fetch gateway models: unexpected status %s", response.Status)
	}
	var body struct {
		Data json.RawMessage `json:"data"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, gatewayCacheMaxResponseBytes))
	if err := decoder.Decode(&body); err != nil {
		return "", false, fmt.Errorf("decode gateway models: %w", err)
	}
	var models []GatewayModelRow
	if len(body.Data) == 0 || json.Unmarshal(body.Data, &models) != nil || models == nil {
		return "", false, fmt.Errorf("decode gateway models: data must be an array")
	}
	path, err = WriteGatewayModelCache(baseURL, models, configDir, now)
	if err != nil {
		return "", false, err
	}
	return path, true, nil
}

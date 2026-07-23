package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const maxQuotaResponseBytes = 1 << 20

type QuotaWindow struct {
	Label   string
	Percent float64
	ResetAt time.Time
}
type ProviderQuota struct {
	Provider, Source string
	Windows          []QuotaWindow
	UpdatedAt        time.Time
}

type QuotaEndpoint struct {
	URL, Source string
	Method      string
	Body        string
	Headers     map[string]string
}

type quotaCacheEntry struct {
	quota     ProviderQuota
	fetchedAt time.Time
}

type QuotaFetcher struct {
	Client    *http.Client
	Endpoints map[string]QuotaEndpoint
	TTL       time.Duration
	mu        sync.Mutex
	cache     map[string]quotaCacheEntry
}

func NewQuotaFetcher() *QuotaFetcher {
	client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	return &QuotaFetcher{Client: client, TTL: 5 * time.Minute, cache: make(map[string]quotaCacheEntry), Endpoints: map[string]QuotaEndpoint{
		"xai":       {URL: "https://cli-chat-proxy.grok.com/v1/billing", Source: "xai:grok-billing"},
		"anthropic": {URL: "https://api.anthropic.com/api/oauth/usage", Source: "anthropic:oauth-usage", Headers: map[string]string{"anthropic-beta": "claude-code-20250219,oauth-2025-04-20"}},
		"kimi":      {URL: "https://api.kimi.com/coding/v1/usages", Source: "kimi:usages"},
		"kimi-code": {URL: "https://api.kimi.com/coding/v1/usages", Source: "kimi:usages"},
		"cursor":    {URL: "https://api2.cursor.sh/api/usage/summary", Source: "cursor:usage-summary"},
		"google-antigravity": {
			URL: "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", Source: "google-antigravity:fetchAvailableModels",
			Method: http.MethodPost, Body: "{}", Headers: map[string]string{"Content-Type": "application/json", "User-Agent": "opencodex-quota"},
		},
	}}
}

func (f *QuotaFetcher) Clear(provider string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if provider == "" {
		clear(f.cache)
	} else {
		delete(f.cache, provider)
	}
}

func (f *QuotaFetcher) Fetch(ctx context.Context, provider string, cred *types.AuthContext, force bool) (ProviderQuota, error) {
	f.mu.Lock()
	if cached, ok := f.cache[provider]; ok && !force && time.Since(cached.fetchedAt) < f.TTL {
		f.mu.Unlock()
		return cloneQuota(cached.quota), nil
	}
	f.mu.Unlock()
	endpoint, ok := f.Endpoints[provider]
	if !ok {
		return ProviderQuota{}, fmt.Errorf("quota endpoint unavailable for provider %q", provider)
	}
	method := endpoint.Method
	if method == "" {
		method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint.URL, strings.NewReader(endpoint.Body))
	if err != nil {
		return ProviderQuota{}, err
	}
	req.Header.Set("Accept", "application/json")
	for name, value := range endpoint.Headers {
		req.Header.Set(name, value)
	}
	if cred != nil {
		secret := cred.AccessToken
		if secret == "" {
			secret = cred.APIKey
		}
		if secret != "" {
			req.Header.Set("Authorization", "Bearer "+secret)
		}
		for name, value := range cred.Headers {
			req.Header.Set(name, value)
		}
	}
	response, err := f.Client.Do(req)
	if err != nil {
		return ProviderQuota{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return ProviderQuota{}, fmt.Errorf("quota endpoint returned %s", response.Status)
	}
	var body any
	if err := json.NewDecoder(io.LimitReader(response.Body, maxQuotaResponseBytes)).Decode(&body); err != nil {
		return ProviderQuota{}, fmt.Errorf("decode quota: %w", err)
	}
	windows := parseQuotaWindows(body)
	if len(windows) == 0 {
		return ProviderQuota{}, fmt.Errorf("quota response contains no recognized windows")
	}
	quota := ProviderQuota{Provider: provider, Source: endpoint.Source, Windows: windows, UpdatedAt: time.Now()}
	f.mu.Lock()
	f.cache[provider] = quotaCacheEntry{quota: cloneQuota(quota), fetchedAt: time.Now()}
	f.mu.Unlock()
	return quota, nil
}

func cloneQuota(quota ProviderQuota) ProviderQuota {
	quota.Windows = append([]QuotaWindow(nil), quota.Windows...)
	return quota
}

func parseQuotaWindows(body any) []QuotaWindow {
	root, ok := body.(map[string]any)
	if !ok {
		return nil
	}
	var out []QuotaWindow
	known := []struct {
		keys  []string
		label string
	}{
		{[]string{"five_hour", "fiveHour", "five_hour_percent"}, "5h"},
		{[]string{"seven_day", "weekly", "weekly_percent"}, "Weekly"},
		{[]string{"monthly", "monthly_percent"}, "Monthly"},
	}
	for _, candidate := range known {
		for _, key := range candidate.keys {
			if value, exists := root[key]; exists {
				if window, ok := quotaWindow(candidate.label, value, root); ok {
					out = append(out, window)
					break
				}
			}
		}
	}
	if len(out) == 0 {
		if config, ok := root["config"].(map[string]any); ok {
			limit, lok := nestedNumber(config["monthlyLimit"])
			used, uok := nestedNumber(config["used"])
			if lok && uok && limit > 0 {
				out = append(out, QuotaWindow{Label: "Monthly", Percent: clampPercent(used / limit * 100), ResetAt: parseReset(config["billingPeriodEnd"])})
			}
		}
	}
	if len(out) == 0 {
		walkQuota(root, "Quota", &out, 0)
	}
	return out
}

func quotaWindow(label string, value any, root map[string]any) (QuotaWindow, bool) {
	if number, ok := numberValue(value); ok {
		return QuotaWindow{Label: label, Percent: clampPercent(number), ResetAt: parseReset(root[resetKey(label)])}, true
	}
	record, ok := value.(map[string]any)
	if !ok {
		return QuotaWindow{}, false
	}
	for _, key := range []string{"utilization", "percent", "used_percent", "usage_percentage"} {
		if number, ok := numberValue(record[key]); ok {
			return QuotaWindow{Label: label, Percent: clampPercent(number), ResetAt: firstReset(record)}, true
		}
	}
	used, usedOK := numberValue(record["used"])
	limit, limitOK := numberValue(record["limit"])
	if !usedOK {
		used, usedOK = numberValue(record["includedSpend"])
	}
	if limitOK && limit > 0 {
		if !usedOK {
			if remaining, ok := numberValue(record["remaining"]); ok {
				used, usedOK = limit-remaining, true
			}
		}
		if usedOK {
			return QuotaWindow{Label: label, Percent: clampPercent(used / limit * 100), ResetAt: firstReset(record)}, true
		}
	}
	if remaining, ok := numberValue(record["remainingFraction"]); ok {
		return QuotaWindow{Label: label, Percent: clampPercent((1 - remaining) * 100), ResetAt: firstReset(record)}, true
	}
	return QuotaWindow{}, false
}

func walkQuota(record map[string]any, label string, out *[]QuotaWindow, depth int) {
	if depth > 3 || len(*out) >= 16 {
		return
	}
	for key, value := range record {
		if child, ok := value.(map[string]any); ok {
			if window, found := quotaWindow(strings.ReplaceAll(key, "_", " "), child, child); found {
				*out = append(*out, window)
			} else {
				walkQuota(child, key, out, depth+1)
			}
			continue
		}
		if list, ok := value.([]any); ok {
			for _, item := range list {
				child, ok := item.(map[string]any)
				if !ok {
					continue
				}
				if window, found := quotaWindow(strings.ReplaceAll(key, "_", " "), child, child); found {
					*out = append(*out, window)
				} else {
					walkQuota(child, key, out, depth+1)
				}
				if len(*out) >= 16 {
					return
				}
			}
		}
	}
}

func numberValue(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case json.Number:
		n, err := v.Float64()
		return n, err == nil
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return n, err == nil
	default:
		return 0, false
	}
}

func nestedNumber(value any) (float64, bool) {
	if record, ok := value.(map[string]any); ok {
		return numberValue(record["val"])
	}
	return numberValue(value)
}
func clampPercent(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}
func resetKey(label string) string {
	switch label {
	case "5h":
		return "five_hour_reset_at"
	case "Weekly":
		return "weekly_reset_at"
	default:
		return "monthly_reset_at"
	}
}
func firstReset(record map[string]any) time.Time {
	for _, key := range []string{"resets_at", "reset_at", "resetAt", "billingCycleEnd"} {
		if reset := parseReset(record[key]); !reset.IsZero() {
			return reset
		}
	}
	return time.Time{}
}
func parseReset(value any) time.Time {
	if number, ok := numberValue(value); ok {
		if number < 10_000_000_000 {
			number *= 1000
		}
		return time.UnixMilli(int64(number))
	}
	if text, ok := value.(string); ok {
		if parsed, err := time.Parse(time.RFC3339, text); err == nil {
			return parsed
		}
	}
	return time.Time{}
}

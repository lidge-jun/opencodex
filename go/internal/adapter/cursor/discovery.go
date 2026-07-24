package cursor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const cursorModelsPath = "/agent.v1.AgentService/GetUsableModels"

var staticModelIDs = []string{
	"auto", "auto-cost", "auto-balance", "auto-intelligence",
	"claude-sonnet-5", "claude-4-sonnet", "claude-4-sonnet-1m", "claude-4.5-haiku", "claude-4.5-sonnet", "claude-4.5-opus", "claude-4.6-opus", "claude-4.6-sonnet", "claude-opus-4-7", "claude-opus-4-7-fast", "claude-opus-4-8", "claude-opus-5", "claude-fable-5",
	"composer-1", "composer-2.5", "composer-2.5-fast", "gemini-2.5-flash", "gemini-3-flash", "gemini-3-pro", "gemini-3-pro-image-preview", "gemini-3.1-pro", "gemini-3.5-flash",
	"gpt-5-codex", "gpt-5-fast", "gpt-5-mini", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5", "gpt-5.5-extra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "glm-5.2", "kimi-k2.7-code", "grok-4.5", "grok-4.5-fast",
}

func StaticModels() []types.ModelEntry {
	models := make([]types.ModelEntry, 0, len(staticModelIDs))
	for _, id := range staticModelIDs {
		models = append(models, types.ModelEntry{ID: id, Provider: "cursor", DisplayName: id, ContextWindow: inferContextWindow(id), ReasoningEfforts: effortLadder(id)})
	}
	return models
}

func DiscoverModels(ctx context.Context, client *http.Client, baseURL, token string) ([]string, error) {
	if client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.ForceAttemptHTTP2 = true
		client = &http.Client{Transport: transport}
	}
	if baseURL == "" {
		baseURL = "https://api2.cursor.sh"
	}
	if token == "" {
		return nil, fmt.Errorf("Cursor access token is required")
	}
	requestCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, strings.TrimRight(baseURL, "/")+cursorModelsPath, bytes.NewReader(MarshalGetUsableModelsRequest(nil)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/proto")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Ghost-Mode", "true")
	req.Header.Set("X-Cursor-Client-Version", cursorClientVersion)
	req.Header.Set("X-Cursor-Client-Type", "cli")
	req.Header.Set("X-Session-Id", newID())
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return nil, &CursorError{Kind: ErrorAuth, StatusCode: response.StatusCode, Err: fmt.Errorf("HTTP %d", response.StatusCode)}
	}
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("Cursor model discovery HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	decoded, err := UnmarshalGetUsableModelsResponse(payload)
	if err != nil {
		return nil, fmt.Errorf("decode Cursor model discovery: %w", err)
	}
	seen := map[string]struct{}{}
	ids := make([]string, 0, len(decoded.Models))
	for _, model := range decoded.Models {
		id := strings.TrimSpace(model.ID)
		if id == "" || len(ids) == 500 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("Cursor model discovery returned no usable models")
	}
	sort.Strings(ids)
	return ids, nil
}

func inferContextWindow(id string) int {
	id = strings.ToLower(id)
	switch {
	case strings.Contains(id, "1m"), strings.HasPrefix(id, "gemini-"), id == "glm-5.2", strings.HasPrefix(id, "gpt-5.6-"):
		return 1_000_000
	case strings.HasPrefix(id, "grok-4.5"):
		return 500_000
	case strings.HasPrefix(id, "gpt-5"):
		return 272_000
	case strings.HasPrefix(id, "grok-"):
		return 256_000
	case strings.Contains(id, "claude"), strings.HasPrefix(id, "auto"):
		return 200_000
	default:
		return 128_000
	}
}
func effortLadder(id string) []string {
	tiers := cursorEffortTiers[id]
	if len(tiers) == 0 {
		return nil
	}
	out := append([]string(nil), tiers...)
	return out
}

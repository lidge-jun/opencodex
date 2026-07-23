package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const maxModelsResponseBytes = 4 << 20

type CatalogBuilder struct {
	Registry *ProviderRegistry
	Cache    *ModelCache
	Client   *http.Client
	TTL      time.Duration
}

func NewCatalogBuilder(reg *ProviderRegistry) *CatalogBuilder {
	if reg == nil {
		reg = New()
	}
	return &CatalogBuilder{Registry: reg, Cache: NewModelCache(), Client: &http.Client{Timeout: 8 * time.Second}, TTL: DefaultModelCacheTTL}
}

// Build combines bundled rows, successful live discovery, and configured hints.
func (b *CatalogBuilder) Build(cfg config.Config, live map[string][]types.ModelEntry) []types.ModelEntry {
	providers := make(map[string]struct{}, len(cfg.Providers)+1)
	providers[OpenAICodexProviderID] = struct{}{}
	for name, provider := range cfg.Providers {
		if !provider.Disabled {
			providers[name] = struct{}{}
		}
	}
	rows := make(map[string]types.ModelEntry)
	for name := range providers {
		entry, ok := b.Registry.Lookup(name)
		if ok {
			for _, model := range entry.Models {
				mergeCatalogRow(rows, catalogEntry(name, model), false)
			}
		}
		for _, model := range live[name] {
			model.Provider = name
			mergeCatalogRow(rows, normalizeCatalogID(name, model), true)
		}
		if configured, exists := cfg.Providers[name]; exists {
			for _, id := range configured.Models {
				model := types.ModelEntry{ID: publicModelID(name, id), Provider: name, ReasoningEfforts: append([]string(nil), configured.ModelReasoningEfforts[id]...)}
				mergeCatalogRow(rows, model, false)
			}
		}
	}
	out := make([]types.ModelEntry, 0, len(rows))
	for _, row := range rows {
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func catalogEntry(provider string, model ModelDefinition) types.ModelEntry {
	return types.ModelEntry{ID: publicModelID(provider, model.ID), Provider: provider, DisplayName: model.DisplayName, ReasoningEfforts: append([]string(nil), model.ReasoningEfforts...), ContextWindow: model.ContextWindow}
}

func publicModelID(provider, id string) string {
	if provider == OpenAICodexProviderID {
		return id
	}
	return RoutedSlug(provider, id)
}

func normalizeCatalogID(provider string, model types.ModelEntry) types.ModelEntry {
	model.ID = strings.TrimSpace(model.ID)
	prefix := provider + "/"
	if strings.HasPrefix(model.ID, prefix) {
		model.ID = strings.TrimPrefix(model.ID, prefix)
	}
	model.ID = publicModelID(provider, model.ID)
	model.ReasoningEfforts = append([]string(nil), model.ReasoningEfforts...)
	return model
}

func mergeCatalogRow(rows map[string]types.ModelEntry, incoming types.ModelEntry, overwrite bool) {
	if incoming.ID == "" {
		return
	}
	current, exists := rows[incoming.ID]
	if !exists {
		rows[incoming.ID] = incoming
		return
	}
	if overwrite {
		if incoming.DisplayName == "" {
			incoming.DisplayName = current.DisplayName
		}
		if incoming.ContextWindow == 0 {
			incoming.ContextWindow = current.ContextWindow
		}
		if len(incoming.ReasoningEfforts) == 0 {
			incoming.ReasoningEfforts = current.ReasoningEfforts
		}
		rows[incoming.ID] = incoming
		return
	}
	if current.DisplayName == "" {
		current.DisplayName = incoming.DisplayName
	}
	if current.ContextWindow == 0 {
		current.ContextWindow = incoming.ContextWindow
	}
	if len(current.ReasoningEfforts) == 0 {
		current.ReasoningEfforts = incoming.ReasoningEfforts
	}
	rows[incoming.ID] = current
}

// Sync fetches live /models rows where enabled and falls back to last-known-good cache data.
func (b *CatalogBuilder) Sync(ctx context.Context, cfg config.Config) ([]types.ModelEntry, error) {
	live := make(map[string][]types.ModelEntry)
	var errs []string
	for name, provider := range cfg.Providers {
		entry, known := b.Registry.Lookup(name)
		if provider.Disabled || !known || !entry.LiveModels {
			continue
		}
		if models, ok := b.Cache.Fresh(name, b.TTL, time.Now()); ok {
			live[name] = models
			continue
		}
		if b.Cache.CoolingDown(name, ModelFetchFailureCooldown, time.Now()) {
			if stale, ok := b.Cache.Stale(name); ok {
				live[name] = stale
			}
			continue
		}
		models, err := b.fetchModels(ctx, name, provider)
		if err != nil {
			b.Cache.MarkFailure(name, time.Now())
			if stale, ok := b.Cache.Stale(name); ok {
				live[name] = stale
			} else {
				errs = append(errs, name+": "+err.Error())
			}
			continue
		}
		b.Cache.Set(name, models, time.Now())
		live[name] = models
	}
	result := b.Build(cfg, live)
	if len(errs) > 0 {
		return result, fmt.Errorf("catalog sync: %s", strings.Join(errs, "; "))
	}
	return result, nil
}

func (b *CatalogBuilder) fetchModels(ctx context.Context, provider string, cfg config.ProviderConfig) ([]types.ModelEntry, error) {
	base, err := url.Parse(strings.TrimRight(cfg.BaseURL, "/") + "/models")
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}
	for name, value := range cfg.Headers {
		req.Header.Set(name, value)
	}
	response, err := b.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("models endpoint returned %s", response.Status)
	}
	var payload struct {
		Data []struct {
			ID               string   `json:"id"`
			Name             string   `json:"name"`
			ContextWindow    int      `json:"context_window"`
			ReasoningEfforts []string `json:"reasoning_efforts"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxModelsResponseBytes))
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode models: %w", err)
	}
	models := make([]types.ModelEntry, 0, len(payload.Data))
	for _, item := range payload.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		models = append(models, types.ModelEntry{ID: id, Provider: provider, DisplayName: item.Name, ContextWindow: item.ContextWindow, ReasoningEfforts: append([]string(nil), item.ReasoningEfforts...)})
	}
	return models, nil
}

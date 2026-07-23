package registry

import (
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	DefaultModelCacheTTL      = 5 * time.Minute
	ModelFetchFailureCooldown = 30 * time.Second
)

type modelCacheEntry struct {
	models    []types.ModelEntry
	fetchedAt time.Time
}

type ModelCache struct {
	mu       sync.RWMutex
	entries  map[string]modelCacheEntry
	failures map[string]time.Time
}

func NewModelCache() *ModelCache {
	return &ModelCache{entries: make(map[string]modelCacheEntry), failures: make(map[string]time.Time)}
}

func cloneModelEntries(in []types.ModelEntry) []types.ModelEntry {
	out := make([]types.ModelEntry, len(in))
	for i, model := range in {
		out[i] = model
		out[i].ReasoningEfforts = append([]string(nil), model.ReasoningEfforts...)
	}
	return out
}

func (c *ModelCache) Fresh(provider string, ttl time.Duration, now time.Time) ([]types.ModelEntry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.entries[provider]
	if !ok || now.Sub(entry.fetchedAt) >= ttl {
		return nil, false
	}
	return cloneModelEntries(entry.models), true
}

func (c *ModelCache) Stale(provider string) ([]types.ModelEntry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.entries[provider]
	if !ok {
		return nil, false
	}
	return cloneModelEntries(entry.models), true
}

func (c *ModelCache) Set(provider string, models []types.ModelEntry, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[provider] = modelCacheEntry{models: cloneModelEntries(models), fetchedAt: now}
	delete(c.failures, provider)
}

func (c *ModelCache) MarkFailure(provider string, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failures[provider] = now
}

func (c *ModelCache) CoolingDown(provider string, cooldown time.Duration, now time.Time) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	at, ok := c.failures[provider]
	return ok && now.Sub(at) < cooldown
}

func (c *ModelCache) Clear(provider string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if provider == "" {
		clear(c.entries)
		clear(c.failures)
		return
	}
	delete(c.entries, provider)
	delete(c.failures, provider)
}

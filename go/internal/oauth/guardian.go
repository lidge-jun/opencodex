package oauth

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type GuardianConfig struct {
	Interval       time.Duration
	LeadTime       time.Duration
	RefreshTimeout time.Duration
	Enabled        bool
}

type GuardianSweepResult struct {
	Refreshed      []string
	Failed         []string
	SkippedBackoff []string
}

type guardianBackoff struct {
	Attempts int
	Until    time.Time
}

// TokenGuardian proactively refreshes credentials approaching expiry. It calls
// the store's cross-process-safe refresh path and never retains token values.
type TokenGuardian struct {
	Store      *CredentialStore
	Config     GuardianConfig
	Refreshers map[string]RefreshFunc

	mu      sync.Mutex
	backoff map[string]guardianBackoff
	cancel  context.CancelFunc
	done    chan struct{}
	now     func() time.Time
}

func NewTokenGuardian(store *CredentialStore, config GuardianConfig, refreshers map[string]RefreshFunc) *TokenGuardian {
	if config.Interval <= 0 {
		config.Interval = 6 * time.Hour
	}
	if config.LeadTime <= 0 {
		config.LeadTime = 15 * time.Minute
	}
	if config.RefreshTimeout <= 0 {
		config.RefreshTimeout = 30 * time.Second
	}
	return &TokenGuardian{Store: store, Config: config, Refreshers: refreshers, backoff: make(map[string]guardianBackoff), now: time.Now}
}

func (g *TokenGuardian) Sweep(ctx context.Context) GuardianSweepResult {
	result := GuardianSweepResult{}
	if !g.Config.Enabled {
		return result
	}
	store, err := g.Store.Load()
	if err != nil {
		result.Failed = append(result.Failed, "store")
		return result
	}
	now := g.now()
	for provider, set := range store {
		refresh := g.Refreshers[provider]
		if refresh == nil {
			continue
		}
		for _, account := range set.Accounts {
			key := provider + ":" + account.ID
			if account.NeedsReauth || !account.Credential.Expired(now, g.Config.Interval+g.Config.LeadTime) {
				continue
			}
			if g.inBackoff(key, now) {
				result.SkippedBackoff = append(result.SkippedBackoff, key)
				continue
			}
			refreshCtx, cancel := context.WithTimeout(ctx, g.Config.RefreshTimeout)
			_, refreshErr := g.Store.RefreshAccountIfGeneration(
				refreshCtx, provider, account.ID, CredentialGeneration(account.Credential), refresh,
			)
			cancel()
			if refreshErr != nil {
				g.recordFailure(key, now)
				result.Failed = append(result.Failed, key)
				continue
			}
			g.clearFailure(key)
			result.Refreshed = append(result.Refreshed, key)
		}
	}
	return result
}

func (g *TokenGuardian) inBackoff(key string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	entry, ok := g.backoff[key]
	return ok && entry.Until.After(now)
}

func (g *TokenGuardian) recordFailure(key string, now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	entry := g.backoff[key]
	entry.Attempts++
	delay := 5 * time.Minute * time.Duration(1<<min(entry.Attempts-1, 3))
	entry.Until = now.Add(min(delay, time.Hour))
	g.backoff[key] = entry
}

func (g *TokenGuardian) clearFailure(key string) {
	g.mu.Lock()
	delete(g.backoff, key)
	g.mu.Unlock()
}

func (g *TokenGuardian) Start(parent context.Context) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.cancel != nil {
		return fmt.Errorf("token guardian already started")
	}
	ctx, cancel := context.WithCancel(parent)
	g.cancel = cancel
	g.done = make(chan struct{})
	go g.run(ctx, g.done)
	return nil
}

func (g *TokenGuardian) run(ctx context.Context, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(g.Config.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			g.Sweep(ctx)
		}
	}
}

func (g *TokenGuardian) Stop() {
	g.mu.Lock()
	cancel, done := g.cancel, g.done
	g.cancel, g.done = nil, nil
	g.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
}

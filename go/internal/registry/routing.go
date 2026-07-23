package registry

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	ThreadAffinityIdleTTL    = 24 * time.Hour
	ThreadAffinityMaxEntries = 2048
	DefaultAccountCooldown   = time.Minute
	MaxAccountCooldown       = 24 * time.Hour
	TransientSoftAvoid       = 30 * time.Second
)

type CodexAccount struct {
	ID          string            `json:"id"`
	Generation  int64             `json:"generation"`
	AccessToken string            `json:"-"`
	Headers     map[string]string `json:"-"`
	Usage       float64           `json:"usage"`
	Usable      bool              `json:"usable"`
	NeedsReauth bool              `json:"needsReauth"`
}

type threadAffinity struct {
	accountID  string
	generation int64
	lastUsed   time.Time
}
type accountHealth struct {
	cooldownUntil, softAvoidUntil time.Time
	consecutiveFailures           int
}

type CodexRouter struct {
	mu       sync.Mutex
	accounts map[string]CodexAccount
	threads  map[string]threadAffinity
	health   map[string]accountHealth
	now      func() time.Time
}

func NewCodexRouter(accounts []CodexAccount) *CodexRouter {
	r := &CodexRouter{accounts: make(map[string]CodexAccount), threads: make(map[string]threadAffinity), health: make(map[string]accountHealth), now: time.Now}
	r.SetAccounts(accounts)
	return r
}

func (r *CodexRouter) SetAccounts(accounts []CodexAccount) {
	r.mu.Lock()
	defer r.mu.Unlock()
	next := make(map[string]CodexAccount, len(accounts))
	for _, account := range accounts {
		if account.ID != "" {
			account.Headers = cloneStringMap(account.Headers)
			next[account.ID] = account
		}
	}
	r.accounts = next
	for thread, affinity := range r.threads {
		account, ok := next[affinity.accountID]
		if !ok || account.Generation != affinity.generation {
			delete(r.threads, thread)
		}
	}
}

func (r *CodexRouter) Resolve(threadID string) (CodexAccount, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.prune(now)
	if affinity, ok := r.threads[threadID]; ok {
		if account, exists := r.accounts[affinity.accountID]; exists && account.Generation == affinity.generation && r.selectable(account, now) {
			affinity.lastUsed = now
			r.threads[threadID] = affinity
			return cloneCodexAccount(account), nil
		}
		delete(r.threads, threadID)
	}
	ids := make([]string, 0, len(r.accounts))
	for id, account := range r.accounts {
		if r.selectable(account, now) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return CodexAccount{}, fmt.Errorf("no usable Codex account")
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := r.accounts[ids[i]], r.accounts[ids[j]]
		if a.Usage == b.Usage {
			return a.ID < b.ID
		}
		return a.Usage < b.Usage
	})
	selected := r.accounts[ids[0]]
	if threadID != "" {
		r.threads[threadID] = threadAffinity{accountID: selected.ID, generation: selected.Generation, lastUsed: now}
	}
	return cloneCodexAccount(selected), nil
}

func cloneCodexAccount(account CodexAccount) CodexAccount {
	account.Headers = cloneStringMap(account.Headers)
	return account
}

func (r *CodexRouter) selectable(account CodexAccount, now time.Time) bool {
	if !account.Usable || account.NeedsReauth || account.AccessToken == "" {
		return false
	}
	health := r.health[account.ID]
	return !health.cooldownUntil.After(now) && !health.softAvoidUntil.After(now)
}

func (r *CodexRouter) prune(now time.Time) {
	for id, affinity := range r.threads {
		if now.Sub(affinity.lastUsed) >= ThreadAffinityIdleTTL {
			delete(r.threads, id)
		}
	}
	for len(r.threads) >= ThreadAffinityMaxEntries {
		oldestID, oldest := "", now
		for id, affinity := range r.threads {
			if oldestID == "" || affinity.lastUsed.Before(oldest) {
				oldestID, oldest = id, affinity.lastUsed
			}
		}
		delete(r.threads, oldestID)
	}
}

func (r *CodexRouter) ResolveAuth(_ context.Context, provider, threadID string) (*types.AuthContext, error) {
	if provider != OpenAICodexProviderID {
		return nil, fmt.Errorf("Codex account pool cannot authenticate provider %q", provider)
	}
	account, err := r.Resolve(threadID)
	if err != nil {
		return nil, err
	}
	return &types.AuthContext{Kind: "pool", Provider: provider, AccountID: account.ID, Generation: account.Generation, AccessToken: account.AccessToken, Headers: cloneStringMap(account.Headers)}, nil
}

func (r *CodexRouter) RecordOutcome(accountID string, status types.OutcomeStatus, meta *types.RetryMeta) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	health := r.health[accountID]
	switch status {
	case types.OutcomeSuccess:
		if health.cooldownUntil.After(now) {
			health.consecutiveFailures = 0
			health.softAvoidUntil = time.Time{}
			r.health[accountID] = health
		} else {
			delete(r.health, accountID)
		}
	case types.OutcomeRateLimited:
		duration := DefaultAccountCooldown
		if meta != nil && meta.RetryAfter > 0 {
			duration = meta.RetryAfter
		}
		if duration > MaxAccountCooldown {
			duration = MaxAccountCooldown
		}
		health.cooldownUntil, health.softAvoidUntil, health.consecutiveFailures = now.Add(duration), time.Time{}, 0
		r.health[accountID] = health
		r.clearAffinity(accountID)
	case types.OutcomeAuthError:
		account := r.accounts[accountID]
		account.NeedsReauth = true
		r.accounts[accountID] = account
		r.clearAffinity(accountID)
	case types.OutcomeProviderError:
		health.consecutiveFailures++
		duration := TransientSoftAvoid * time.Duration(health.consecutiveFailures)
		if duration > 30*time.Minute {
			duration = 30 * time.Minute
		}
		health.softAvoidUntil = now.Add(duration)
		r.health[accountID] = health
		r.clearAffinity(accountID)
	}
}

func (r *CodexRouter) clearAffinity(accountID string) {
	for thread, affinity := range r.threads {
		if affinity.accountID == accountID {
			delete(r.threads, thread)
		}
	}
}

var _ types.AuthProvider = (*CodexRouter)(nil)

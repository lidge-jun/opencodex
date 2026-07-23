package oauth

import (
	"context"
	"sync"
	"time"

	shared "github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	defaultAffinityTTL = 24 * time.Hour
	defaultMaxAffinity = 2048
	defaultCooldown    = time.Minute
	maxCooldown        = 24 * time.Hour
)

type affinityEntry struct {
	AccountID string
	LastUsed  time.Time
}

// AccountPool selects OAuth accounts while preserving per-thread affinity and
// excluding accounts in cooldown or terminal reauthentication state.
type AccountPool struct {
	store    *CredentialStore
	provider string

	mu          sync.Mutex
	affinity    map[string]affinityEntry
	cooldowns   map[string]time.Time
	next        int
	now         func() time.Time
	affinityTTL time.Duration
	maxAffinity int
}

func NewAccountPool(store *CredentialStore, provider string) *AccountPool {
	return &AccountPool{
		store: store, provider: provider,
		affinity: make(map[string]affinityEntry), cooldowns: make(map[string]time.Time),
		now: time.Now, affinityTTL: defaultAffinityTTL, maxAffinity: defaultMaxAffinity,
	}
}

func (p *AccountPool) Select(_ context.Context, threadID string) (ProviderAccount, error) {
	set, ok, err := p.store.GetAccountSet(p.provider)
	if err != nil {
		return ProviderAccount{}, err
	}
	if !ok {
		return ProviderAccount{}, ErrNoUsableAccount
	}
	now := p.now()
	p.mu.Lock()
	defer p.mu.Unlock()
	p.prune(now)
	if threadID != "" {
		if entry, found := p.affinity[threadID]; found {
			if account, usable := p.findUsable(set.Accounts, entry.AccountID, now); usable {
				entry.LastUsed = now
				p.affinity[threadID] = entry
				return account, nil
			}
			delete(p.affinity, threadID)
		}
	}
	usable := p.usableAccounts(set.Accounts, now)
	if len(usable) == 0 {
		return ProviderAccount{}, ErrNoUsableAccount
	}
	account := usable[p.next%len(usable)]
	p.next = (p.next + 1) % len(usable)
	if threadID != "" {
		p.affinity[threadID] = affinityEntry{AccountID: account.ID, LastUsed: now}
		p.pruneLRU()
	}
	return account, nil
}

func (p *AccountPool) usableAccounts(accounts []ProviderAccount, now time.Time) []ProviderAccount {
	usable := make([]ProviderAccount, 0, len(accounts))
	for _, account := range accounts {
		if account.NeedsReauth {
			continue
		}
		if until := p.cooldowns[account.ID]; until.After(now) {
			continue
		}
		usable = append(usable, account)
	}
	return usable
}

func (p *AccountPool) findUsable(accounts []ProviderAccount, id string, now time.Time) (ProviderAccount, bool) {
	for _, account := range accounts {
		if account.ID == id && !account.NeedsReauth && !p.cooldowns[id].After(now) {
			return account, true
		}
	}
	return ProviderAccount{}, false
}

func (p *AccountPool) prune(now time.Time) {
	for threadID, entry := range p.affinity {
		if now.Sub(entry.LastUsed) > p.affinityTTL {
			delete(p.affinity, threadID)
		}
	}
	for accountID, until := range p.cooldowns {
		if !until.After(now) {
			delete(p.cooldowns, accountID)
		}
	}
}

func (p *AccountPool) pruneLRU() {
	for len(p.affinity) > p.maxAffinity {
		var oldestThread string
		oldest := time.Time{}
		for threadID, entry := range p.affinity {
			if oldestThread == "" || entry.LastUsed.Before(oldest) {
				oldestThread, oldest = threadID, entry.LastUsed
			}
		}
		delete(p.affinity, oldestThread)
	}
}

func (p *AccountPool) RecordOutcome(accountID string, status shared.OutcomeStatus, meta *shared.RetryMeta) {
	if accountID == "" {
		return
	}
	now := p.now()
	p.mu.Lock()
	switch status {
	case shared.OutcomeAuthError:
		p.cooldowns[accountID] = now.Add(maxCooldown)
		p.clearAffinityLocked(accountID)
	case shared.OutcomeRateLimited:
		delay := defaultCooldown
		if meta != nil && meta.RetryAfter > 0 {
			delay = min(meta.RetryAfter, maxCooldown)
		}
		p.cooldowns[accountID] = now.Add(delay)
		p.clearAffinityLocked(accountID)
	case shared.OutcomeProviderError:
		p.cooldowns[accountID] = now.Add(30 * time.Second)
		p.clearAffinityLocked(accountID)
	}
	p.mu.Unlock()

	if status == shared.OutcomeAuthError {
		credential, ok, err := p.store.GetAccountCredential(p.provider, accountID)
		if err == nil && ok {
			_, _ = p.store.MarkNeedsReauth(context.Background(), p.provider, accountID, CredentialGeneration(credential))
		}
	}
}

func (p *AccountPool) clearAffinityLocked(accountID string) {
	for threadID, entry := range p.affinity {
		if entry.AccountID == accountID {
			delete(p.affinity, threadID)
		}
	}
}

func (p *AccountPool) CooldownUntil(accountID string) (time.Time, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	until, ok := p.cooldowns[accountID]
	if ok && !until.After(p.now()) {
		delete(p.cooldowns, accountID)
		return time.Time{}, false
	}
	return until, ok
}

func (p *AccountPool) Clear() {
	p.mu.Lock()
	defer p.mu.Unlock()
	clear(p.affinity)
	clear(p.cooldowns)
}

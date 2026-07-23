package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// RefreshAccount serializes refresh grants per account across processes, then
// persists with a generation compare-and-swap. A process that waited for another
// refresher adopts the newer credential instead of replaying the old grant.
func (s *CredentialStore) RefreshAccount(ctx context.Context, provider, accountID string, refresh RefreshFunc) (RefreshResult, error) {
	observed, ok, err := s.GetAccountCredential(provider, accountID)
	if err != nil {
		return RefreshResult{}, err
	}
	if !ok {
		return RefreshResult{}, ErrLoginRequired
	}
	return s.RefreshAccountIfGeneration(ctx, provider, accountID, CredentialGeneration(observed), refresh)
}

// RefreshAccountIfGeneration refreshes only when the locked store still has the
// generation observed by the caller. This is the stale-read-safe entry point for
// request resolvers and background sweepers.
func (s *CredentialStore) RefreshAccountIfGeneration(
	ctx context.Context,
	provider string,
	accountID string,
	observedGeneration string,
	refresh RefreshFunc,
) (RefreshResult, error) {
	lock, err := acquireFileLock(ctx, s.refreshLockPath(provider, accountID))
	if err != nil {
		return RefreshResult{}, err
	}
	defer lock.release()

	current, ok, err := s.GetAccountCredential(provider, accountID)
	if err != nil {
		return RefreshResult{}, err
	}
	if !ok {
		return RefreshResult{}, ErrLoginRequired
	}
	expected := CredentialGeneration(current)
	if expected != observedGeneration {
		return RefreshResult{Credential: current, Generation: expected, Superseded: true}, nil
	}
	updated, err := refresh(ctx, current.Refresh)
	if err != nil {
		return RefreshResult{}, err
	}
	if updated.Refresh == "" {
		updated.Refresh = current.Refresh
	}
	if !validCredential(updated) {
		return RefreshResult{}, errors.New("provider returned an invalid OAuth credential")
	}
	return s.mergeRefreshed(ctx, provider, accountID, expected, updated)
}

func (s *CredentialStore) mergeRefreshed(ctx context.Context, provider, accountID, expected string, updated OAuthCredentials) (RefreshResult, error) {
	result := RefreshResult{}
	err := s.mutate(ctx, func(store AuthStore) error {
		set, ok := store[provider]
		if !ok {
			return ErrLoginRequired
		}
		for i := range set.Accounts {
			if set.Accounts[i].ID != accountID {
				continue
			}
			stored := set.Accounts[i].Credential
			if CredentialGeneration(stored) != expected {
				result = RefreshResult{Credential: stored, Generation: CredentialGeneration(stored), Superseded: true}
				return nil
			}
			set.Accounts[i].Credential = updated
			set.Accounts[i].NeedsReauth = false
			store[provider] = set
			result = RefreshResult{Credential: updated, Generation: CredentialGeneration(updated), Refreshed: true}
			return nil
		}
		return ErrLoginRequired
	})
	return result, err
}

func (s *CredentialStore) refreshLockPath(provider, accountID string) string {
	safeProvider := strings.Map(safeLockRune, provider)
	digest := sha256.Sum256([]byte(accountID))
	name := fmt.Sprintf("auth.refresh.%s.%s.lock", safeProvider, hex.EncodeToString(digest[:12]))
	return filepath.Join(filepath.Dir(s.path), name)
}

func safeLockRune(r rune) rune {
	if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' {
		return r
	}
	return '_'
}

package oauth

import (
	"context"
	"errors"
)

func (s *CredentialStore) ListAccounts(provider string) ([]ProviderAccount, error) {
	set, ok, err := s.GetAccountSet(provider)
	if err != nil || !ok {
		return nil, err
	}
	return append([]ProviderAccount(nil), set.Accounts...), nil
}

// SaveAccountCredential updates one stable account slot without changing the
// provider's active account selection.
func (s *CredentialStore) SaveAccountCredential(
	ctx context.Context,
	provider string,
	accountID string,
	credential OAuthCredentials,
) error {
	if !validCredential(credential) {
		return errors.New("valid OAuth credential is required")
	}
	return s.mutate(ctx, func(store AuthStore) error {
		set, ok := store[provider]
		if !ok {
			return ErrLoginRequired
		}
		for i := range set.Accounts {
			if set.Accounts[i].ID == accountID {
				set.Accounts[i].Credential = credential
				set.Accounts[i].NeedsReauth = false
				store[provider] = set
				return nil
			}
		}
		return ErrLoginRequired
	})
}

func (s *CredentialStore) RemoveAccount(ctx context.Context, provider, accountID string) (bool, error) {
	removed := false
	err := s.mutate(ctx, func(store AuthStore) error {
		set, ok := store[provider]
		if !ok {
			return nil
		}
		accounts := make([]ProviderAccount, 0, len(set.Accounts))
		for _, account := range set.Accounts {
			if account.ID == accountID {
				removed = true
				continue
			}
			accounts = append(accounts, account)
		}
		if !removed {
			return nil
		}
		if len(accounts) == 0 {
			delete(store, provider)
			return nil
		}
		set.Accounts = accounts
		if set.ActiveAccountID == accountID {
			set.ActiveAccountID = accounts[0].ID
		}
		store[provider] = set
		return nil
	})
	return removed, err
}

func (s *CredentialStore) RemoveCredential(ctx context.Context, provider string) (bool, error) {
	set, ok, err := s.GetAccountSet(provider)
	if err != nil || !ok {
		return false, err
	}
	return s.RemoveAccount(ctx, provider, set.ActiveAccountID)
}

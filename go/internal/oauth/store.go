package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CredentialStore persists OAuth account sets in one JSON file. Every mutation
// is a locked load-modify-replace transaction, so independent proxy processes do
// not overwrite each other's account changes.
type CredentialStore struct {
	path string
	now  func() time.Time
}

func NewCredentialStore(path string) *CredentialStore {
	return &CredentialStore{path: path, now: time.Now}
}

func (s *CredentialStore) Path() string { return s.path }

func CredentialGeneration(credential OAuthCredentials) string {
	encoded, _ := json.Marshal([]any{credential.Refresh, credential.Access, credential.Expires})
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func (s *CredentialStore) Load() (AuthStore, error) {
	store, _, err := s.loadUnlocked()
	return store, err
}

func (s *CredentialStore) loadUnlocked() (AuthStore, bool, error) {
	f, err := os.Open(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return AuthStore{}, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("open OAuth credential store: %w", err)
	}
	defer f.Close()
	_ = f.Chmod(0o600)

	decoder := json.NewDecoder(io.LimitReader(f, 8<<20))
	decoder.UseNumber()
	var raw map[string]json.RawMessage
	if err := decoder.Decode(&raw); err != nil {
		return nil, false, fmt.Errorf("decode OAuth credential store: %w", err)
	}
	store := make(AuthStore, len(raw))
	hadLegacy := false
	for provider, value := range raw {
		set, legacy, err := decodeAccountSet(value)
		if err != nil {
			return nil, false, fmt.Errorf("decode OAuth provider %q: %w", provider, err)
		}
		if len(set.Accounts) != 0 {
			store[provider] = set
		}
		hadLegacy = hadLegacy || legacy
	}
	return store, hadLegacy, nil
}

func decodeAccountSet(raw json.RawMessage) (ProviderAccountSet, bool, error) {
	var set ProviderAccountSet
	if err := json.Unmarshal(raw, &set); err == nil && len(set.Accounts) > 0 {
		set.Accounts = validAccounts(set.Accounts)
		if len(set.Accounts) == 0 {
			return ProviderAccountSet{}, false, errors.New("account set has no valid accounts")
		}
		if !containsAccount(set.Accounts, set.ActiveAccountID) {
			set.ActiveAccountID = set.Accounts[0].ID
		}
		return set, false, nil
	}

	var credential OAuthCredentials
	if err := json.Unmarshal(raw, &credential); err != nil || !validCredential(credential) {
		return ProviderAccountSet{}, false, errors.New("invalid credential shape")
	}
	id := stableAccountID(credential)
	return ProviderAccountSet{
		ActiveAccountID: id,
		Accounts:        []ProviderAccount{{ID: id, Credential: credential}},
	}, true, nil
}

func validAccounts(accounts []ProviderAccount) []ProviderAccount {
	valid := make([]ProviderAccount, 0, len(accounts))
	seen := make(map[string]struct{}, len(accounts))
	for _, account := range accounts {
		account.ID = strings.TrimSpace(account.ID)
		account.Alias = strings.TrimSpace(account.Alias)
		if account.ID == "" || !validCredential(account.Credential) {
			continue
		}
		if _, duplicate := seen[account.ID]; duplicate {
			continue
		}
		seen[account.ID] = struct{}{}
		valid = append(valid, account)
	}
	return valid
}

func validCredential(credential OAuthCredentials) bool {
	return credential.Access != "" && credential.Expires > 0
}

func containsAccount(accounts []ProviderAccount, id string) bool {
	for i := range accounts {
		if accounts[i].ID == id {
			return true
		}
	}
	return false
}

func stableAccountID(credential OAuthCredentials) string {
	identity := credential.AccountID
	if identity == "" {
		identity = credential.Email
	}
	if identity == "" {
		identity = credential.Refresh
	}
	if identity == "" {
		identity = credential.Access
	}
	digest := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(digest[:4])
}

func (s *CredentialStore) mutate(ctx context.Context, fn func(AuthStore) error) error {
	lock, err := acquireFileLock(ctx, s.path+".lock")
	if err != nil {
		return err
	}
	defer lock.release()

	store, _, err := s.loadUnlocked()
	if err != nil {
		return err
	}
	if err := fn(store); err != nil {
		return err
	}
	return s.persist(store)
}

func (s *CredentialStore) persist(store AuthStore) error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create OAuth credential directory: %w", err)
	}
	_ = os.Chmod(dir, 0o700)

	temp, err := os.CreateTemp(dir, ".auth-*.tmp")
	if err != nil {
		return fmt.Errorf("create OAuth credential temp file: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return fmt.Errorf("secure OAuth credential temp file: %w", err)
	}
	encoder := json.NewEncoder(temp)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(store); err != nil {
		temp.Close()
		return fmt.Errorf("encode OAuth credential store: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("sync OAuth credential store: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close OAuth credential store: %w", err)
	}
	if err := atomicReplace(tempPath, s.path); err != nil {
		return fmt.Errorf("replace OAuth credential store: %w", err)
	}
	return syncDirectory(dir)
}

func syncDirectory(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return nil
	}
	defer f.Close()
	if err := f.Sync(); err != nil {
		// Directory sync is unsupported on Windows and some network filesystems.
		return nil
	}
	return nil
}

func (s *CredentialStore) SaveCredential(ctx context.Context, provider string, credential OAuthCredentials) error {
	provider = strings.TrimSpace(provider)
	if provider == "" || !validCredential(credential) {
		return errors.New("provider and a valid OAuth credential are required")
	}
	return s.mutate(ctx, func(store AuthStore) error {
		set := store[provider]
		upsertCredential(&set, provider, credential, s.now().UnixMilli())
		store[provider] = set
		return nil
	})
}

func upsertCredential(set *ProviderAccountSet, provider string, credential OAuthCredentials, now int64) {
	identity := credential.AccountID
	if identity == "" {
		identity = credential.Email
	}
	if len(set.Accounts) == 0 || provider == "chatgpt" {
		id := stableAccountID(credential)
		*set = ProviderAccountSet{id, []ProviderAccount{{ID: id, Credential: credential, AddedAt: now}}}
		return
	}
	if identity != "" {
		for i := range set.Accounts {
			existingIdentity := set.Accounts[i].Credential.AccountID
			if existingIdentity == "" {
				existingIdentity = set.Accounts[i].Credential.Email
			}
			if existingIdentity == identity {
				set.Accounts[i].Credential = credential
				set.Accounts[i].NeedsReauth = false
				set.ActiveAccountID = set.Accounts[i].ID
				return
			}
		}
		id := stableAccountID(credential)
		set.Accounts = append(set.Accounts, ProviderAccount{ID: id, Credential: credential, AddedAt: now})
		set.ActiveAccountID = id
		return
	}
	for i := range set.Accounts {
		if set.Accounts[i].ID == set.ActiveAccountID {
			set.Accounts[i].Credential = credential
			set.Accounts[i].NeedsReauth = false
			return
		}
	}
}

func (s *CredentialStore) GetCredential(provider string) (OAuthCredentials, bool, error) {
	set, ok, err := s.GetAccountSet(provider)
	if err != nil || !ok {
		return OAuthCredentials{}, false, err
	}
	return credentialFromSet(set, set.ActiveAccountID)
}

func (s *CredentialStore) GetAccountSet(provider string) (ProviderAccountSet, bool, error) {
	store, err := s.Load()
	if err != nil {
		return ProviderAccountSet{}, false, err
	}
	set, ok := store[provider]
	return set, ok, nil
}

func (s *CredentialStore) GetAccountCredential(provider, accountID string) (OAuthCredentials, bool, error) {
	set, ok, err := s.GetAccountSet(provider)
	if err != nil || !ok {
		return OAuthCredentials{}, false, err
	}
	return credentialFromSet(set, accountID)
}

func credentialFromSet(set ProviderAccountSet, accountID string) (OAuthCredentials, bool, error) {
	for i := range set.Accounts {
		if set.Accounts[i].ID == accountID {
			return set.Accounts[i].Credential, true, nil
		}
	}
	return OAuthCredentials{}, false, nil
}

func (s *CredentialStore) SetActiveAccount(ctx context.Context, provider, accountID string) (bool, error) {
	found := false
	err := s.mutate(ctx, func(store AuthStore) error {
		set, ok := store[provider]
		if !ok || !containsAccount(set.Accounts, accountID) {
			return nil
		}
		set.ActiveAccountID = accountID
		store[provider] = set
		found = true
		return nil
	})
	return found, err
}

func (s *CredentialStore) MarkNeedsReauth(ctx context.Context, provider, accountID string, expectedGeneration string) (bool, error) {
	updated := false
	err := s.mutate(ctx, func(store AuthStore) error {
		set, ok := store[provider]
		if !ok {
			return nil
		}
		for i := range set.Accounts {
			if set.Accounts[i].ID != accountID || CredentialGeneration(set.Accounts[i].Credential) != expectedGeneration {
				continue
			}
			set.Accounts[i].NeedsReauth = true
			store[provider] = set
			updated = true
			break
		}
		return nil
	})
	return updated, err
}

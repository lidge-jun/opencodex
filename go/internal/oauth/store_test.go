package oauth

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCredentialStoreRoundTripAndPermissions(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "nested", "auth.json")
	store := NewCredentialStore(path)
	store.now = func() time.Time { return time.UnixMilli(1234) }
	ctx := context.Background()

	first := OAuthCredentials{Access: "access-a", Refresh: "refresh-a", Expires: 100_000, AccountID: "human-a", Source: SourceOAuth}
	second := OAuthCredentials{Access: "access-b", Refresh: "refresh-b", Expires: 200_000, Email: "b@example.com", Source: SourceOAuth}
	if err := store.SaveCredential(ctx, "anthropic", first); err != nil {
		t.Fatalf("SaveCredential(first) error = %v", err)
	}
	if err := store.SaveCredential(ctx, "anthropic", second); err != nil {
		t.Fatalf("SaveCredential(second) error = %v", err)
	}

	reloaded := NewCredentialStore(path)
	set, ok, err := reloaded.GetAccountSet("anthropic")
	if err != nil || !ok {
		t.Fatalf("GetAccountSet() = (%v, %v, %v)", set, ok, err)
	}
	if len(set.Accounts) != 2 {
		t.Fatalf("account count = %d, want 2", len(set.Accounts))
	}
	active, ok, err := reloaded.GetCredential("anthropic")
	if err != nil || !ok {
		t.Fatalf("GetCredential() = (%v, %v, %v)", active, ok, err)
	}
	if active.Access != second.Access || active.Refresh != second.Refresh || active.Email != second.Email {
		t.Fatalf("active credential = %#v, want second credential", active)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("credential permissions = %o, want no group/other access", info.Mode().Perm())
	}
}

func TestCredentialStoreLoadsLegacyCredential(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(`{"chatgpt":{"access":"a","refresh":"r","expires":12345}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewCredentialStore(path)
	set, ok, err := store.GetAccountSet("chatgpt")
	if err != nil || !ok {
		t.Fatalf("GetAccountSet() = (%v, %v, %v)", set, ok, err)
	}
	if len(set.Accounts) != 1 || set.ActiveAccountID == "" || set.Accounts[0].Credential.Access != "a" {
		t.Fatalf("legacy account set = %#v", set)
	}
}

func TestCredentialStoreSerializesConcurrentMutations(t *testing.T) {
	t.Parallel()
	store := NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for _, provider := range []string{"alpha", "beta", "gamma", "delta"} {
		provider := provider
		wg.Add(1)
		go func() {
			defer wg.Done()
			credential := OAuthCredentials{Access: "access-" + provider, Refresh: "refresh-" + provider, Expires: 100_000, AccountID: provider}
			if err := store.SaveCredential(ctx, provider, credential); err != nil {
				t.Errorf("SaveCredential(%s) error = %v", provider, err)
			}
		}()
	}
	wg.Wait()
	loaded, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded) != 4 {
		t.Fatalf("provider count = %d, want 4", len(loaded))
	}
}

func TestCredentialStoreRefreshAdoptsCrossProcessWinner(t *testing.T) {
	t.Parallel()
	store := NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	credential := OAuthCredentials{Access: "old", Refresh: "grant", Expires: 1, AccountID: "account"}
	if err := store.SaveCredential(ctx, "anthropic", credential); err != nil {
		t.Fatal(err)
	}
	set, _, _ := store.GetAccountSet("anthropic")
	accountID := set.ActiveAccountID

	entered := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	refresh := func(context.Context, string) (OAuthCredentials, error) {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		return OAuthCredentials{Access: "new", Refresh: "rotated", Expires: 999_999, AccountID: "account"}, nil
	}
	first := make(chan RefreshResult, 1)
	second := make(chan RefreshResult, 1)
	go func() {
		result, err := store.RefreshAccount(ctx, "anthropic", accountID, refresh)
		if err != nil {
			t.Errorf("first refresh error = %v", err)
		}
		first <- result
	}()
	<-entered
	go func() {
		result, err := store.RefreshAccount(ctx, "anthropic", accountID, refresh)
		if err != nil {
			t.Errorf("second refresh error = %v", err)
		}
		second <- result
	}()
	close(release)
	firstResult, secondResult := <-first, <-second
	if calls.Load() != 1 {
		t.Fatalf("refresh calls = %d, want 1", calls.Load())
	}
	if !firstResult.Refreshed || !secondResult.Superseded {
		t.Fatalf("results = first %#v, second %#v", firstResult, secondResult)
	}
}

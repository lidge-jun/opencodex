package oauth

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	shared "github.com/lidge-jun/opencodex-go/internal/types"
)

func TestAccountPoolPreservesAffinityAndSkipsCooldown(t *testing.T) {
	t.Parallel()
	store := NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	ctx := context.Background()
	for _, credential := range []OAuthCredentials{
		{Access: "one", Refresh: "r1", Expires: 999_999, AccountID: "one"},
		{Access: "two", Refresh: "r2", Expires: 999_999, AccountID: "two"},
	} {
		if err := store.SaveCredential(ctx, "chatgpt-pool", credential); err != nil {
			t.Fatal(err)
		}
	}
	pool := NewAccountPool(store, "chatgpt-pool")
	first, err := pool.Select(ctx, "thread-a")
	if err != nil {
		t.Fatal(err)
	}
	reused, err := pool.Select(ctx, "thread-a")
	if err != nil || reused.ID != first.ID {
		t.Fatalf("affinity Select() = (%#v, %v), want account %s", reused, err, first.ID)
	}
	pool.RecordOutcome(first.ID, shared.OutcomeRateLimited, &shared.RetryMeta{RetryAfter: time.Minute})
	failover, err := pool.Select(ctx, "thread-a")
	if err != nil {
		t.Fatal(err)
	}
	if failover.ID == first.ID {
		t.Fatalf("cooled account %s was selected again", first.ID)
	}
}

func TestAuthResolverAPIKeyAndExpiredOAuth(t *testing.T) {
	t.Parallel()
	store := NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	resolver := NewAuthResolver(store, map[string]ProviderAuthConfig{
		"keyed": {Mode: AuthModeAPIKey, APIKey: "secret"},
	}, nil)
	keyed, err := resolver.ResolveAuth(context.Background(), "keyed", "")
	if err != nil {
		t.Fatal(err)
	}
	if keyed.APIKey != "secret" || keyed.Headers["Authorization"] != "Bearer secret" {
		t.Fatalf("API-key auth context = %#v", keyed)
	}
	_, err = resolver.ResolveAuth(context.Background(), "missing", "")
	if !errors.Is(err, ErrLoginRequired) {
		t.Fatalf("missing OAuth error = %v, want ErrLoginRequired", err)
	}
}

func TestTokenGuardianRefreshesExpiringCredential(t *testing.T) {
	t.Parallel()
	store := NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	ctx := context.Background()
	credential := OAuthCredentials{Access: "old", Refresh: "refresh", Expires: 1, AccountID: "one"}
	if err := store.SaveCredential(ctx, "anthropic", credential); err != nil {
		t.Fatal(err)
	}
	guardian := NewTokenGuardian(store, GuardianConfig{Enabled: true, Interval: time.Hour}, map[string]RefreshFunc{
		"anthropic": func(context.Context, string) (OAuthCredentials, error) {
			return OAuthCredentials{Access: "new", Refresh: "rotated", Expires: time.Now().Add(time.Hour).UnixMilli(), AccountID: "one"}, nil
		},
	})
	result := guardian.Sweep(ctx)
	if len(result.Refreshed) != 1 || len(result.Failed) != 0 {
		t.Fatalf("Sweep() = %#v", result)
	}
	stored, ok, err := store.GetCredential("anthropic")
	if err != nil || !ok || stored.Access != "new" {
		t.Fatalf("stored credential = (%#v, %v, %v)", stored, ok, err)
	}
}

package registry

import (
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestCodexRouterThreadAffinityAndCooldown(t *testing.T) {
	now := time.Date(2026, 7, 24, 0, 0, 0, 0, time.UTC)
	router := NewCodexRouter([]CodexAccount{
		{ID: "low", Generation: 1, AccessToken: "token-low", Usage: 10, Usable: true},
		{ID: "high", Generation: 1, AccessToken: "token-high", Usage: 80, Usable: true},
	})
	router.now = func() time.Time { return now }
	first, err := router.Resolve("thread-1")
	if err != nil || first.ID != "low" {
		t.Fatalf("first resolve = %#v, %v", first, err)
	}
	router.RecordOutcome("low", types.OutcomeRateLimited, &types.RetryMeta{RetryAfter: time.Minute})
	second, err := router.Resolve("thread-1")
	if err != nil || second.ID != "high" {
		t.Fatalf("cooldown failover = %#v, %v", second, err)
	}
	now = now.Add(2 * time.Minute)
	sticky, err := router.Resolve("thread-1")
	if err != nil || sticky.ID != "high" {
		t.Fatalf("thread affinity changed after cooldown expiry = %#v, %v", sticky, err)
	}
}

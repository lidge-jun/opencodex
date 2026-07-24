package combos

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func testResolver(t *testing.T, combo Combo) *Resolver {
	t.Helper()
	providers := make(map[string]Provider)
	for _, target := range combo.Targets {
		providers[target.Provider] = Provider{}
	}
	resolver, err := New(map[string]Combo{"balanced": combo}, providers)
	if err != nil {
		t.Fatal(err)
	}
	return resolver
}

func TestSmoothWeightedSelectionDistribution(t *testing.T) {
	resolver := testResolver(t, Combo{Strategy: StrategyRoundRobin, Targets: []Target{
		{Provider: "a", Model: "one", Weight: 5},
		{Provider: "b", Model: "two", Weight: 3},
		{Provider: "c", Model: "three", Weight: 2},
	}})
	counts := map[string]int{}
	for range 100 {
		pick, err := resolver.PickTarget("combo/balanced")
		if err != nil {
			t.Fatal(err)
		}
		counts[pick.Target.Provider]++
		resolver.NoteSuccess(pick)
	}
	if counts["a"] != 50 || counts["b"] != 30 || counts["c"] != 20 {
		t.Fatalf("unexpected weighted distribution: %#v", counts)
	}
}

func TestCooldownSkipsTargetUntilExpiry(t *testing.T) {
	resolver := testResolver(t, Combo{Strategy: StrategyRoundRobin, Targets: []Target{
		{Provider: "a", Model: "one", Weight: 10},
		{Provider: "b", Model: "two", Weight: 1},
	}})
	now := time.Date(2026, 7, 24, 0, 0, 0, 0, time.UTC)
	resolver.now = func() time.Time { return now }
	resolver.Cooldown("balanced", Target{Provider: "a", Model: "one"}, "2")
	pick, err := resolver.PickTarget("combo/balanced")
	if err != nil {
		t.Fatal(err)
	}
	if pick.Target.Provider != "b" {
		t.Fatalf("selected cooling target: %#v", pick.Target)
	}
	now = now.Add(3 * time.Second)
	resolver.NoteSuccess(pick)
	pick, err = resolver.PickTarget("combo/balanced")
	if err != nil {
		t.Fatal(err)
	}
	if pick.Target.Provider != "a" {
		t.Fatalf("expired target was not restored: %#v", pick.Target)
	}
}

func TestFailureDecisionAndRetryAfter(t *testing.T) {
	for _, tc := range []struct {
		status int
		code   string
		msg    string
		want   string
	}{
		{429, "rate_limit_exceeded", "slow down", DecisionHop},
		{503, "upstream_error", "overloaded", DecisionHop},
		{400, "invalid_request_error", "bad parameter", DecisionStop},
		{499, "", "cancelled", DecisionStop},
		{403, "", "origin_rejected", DecisionStop},
	} {
		if got := FailureDecision(tc.status, tc.code, tc.msg); got != tc.want {
			t.Errorf("FailureDecision(%d, %q, %q) = %q, want %q", tc.status, tc.code, tc.msg, got, tc.want)
		}
	}
	now := time.Date(2026, 7, 24, 12, 0, 0, 0, time.UTC)
	if got, ok := ParseRetryAfter("1.5", now); !ok || got != 1500*time.Millisecond {
		t.Fatalf("delta Retry-After = %v, %v", got, ok)
	}
	if got, ok := ParseRetryAfter(now.Add(30*time.Second).Format(time.RFC1123), now); !ok || got != 30*time.Second {
		t.Fatalf("date Retry-After = %v, %v", got, ok)
	}
}

func TestResolveRequestRewritesModelAndDefaultEffort(t *testing.T) {
	resolver := testResolver(t, Combo{DefaultEffort: "high", Targets: []Target{{Provider: "openrouter", Model: "model-x"}}})
	req := &types.NormalizedRequest{ModelID: "combo/balanced", RawBody: json.RawMessage(`{"model":"combo/balanced","input":[]}`)}
	pick, err := resolver.ResolveRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	if pick.Resolved.Provider != "openrouter" || req.ModelID != "model-x" || req.Options.Reasoning != "high" {
		t.Fatalf("unexpected resolution: pick=%#v request=%#v", pick, req)
	}
	var body map[string]any
	if err := json.Unmarshal(req.RawBody, &body); err != nil {
		t.Fatal(err)
	}
	if body["model"] != "model-x" || body["reasoning"].(map[string]any)["effort"] != "high" {
		t.Fatalf("request body was not rewritten: %#v", body)
	}

	clientOwned := &types.NormalizedRequest{ModelID: "combo/balanced", Options: types.RequestOptions{Reasoning: "low"}}
	if _, err := resolver.ResolveRequest(clientOwned); err != nil {
		t.Fatal(err)
	}
	if clientOwned.Options.Reasoning != "low" {
		t.Fatalf("client effort was overwritten: %q", clientOwned.Options.Reasoning)
	}
}

func TestNextRespectsMaxHops(t *testing.T) {
	resolver := testResolver(t, Combo{Strategy: StrategyFailover, MaxHops: 1, Targets: []Target{
		{Provider: "a", Model: "one"}, {Provider: "b", Model: "two"}, {Provider: "c", Model: "three"},
	}})
	req := &types.NormalizedRequest{ModelID: "combo/balanced"}
	pick, err := resolver.ResolveRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	next, err := resolver.Next(req, pick, 429, "rate_limit_exceeded", "slow", "")
	if err != nil || next.Target.Provider != "b" {
		t.Fatalf("first hop = %#v, %v", next, err)
	}
	if _, err := resolver.Next(req, next, 503, "upstream_error", "down", ""); err == nil {
		t.Fatal("expected max-hop exhaustion")
	}
}

func TestConcurrentResolutionSafety(t *testing.T) {
	resolver := testResolver(t, Combo{Strategy: StrategyRoundRobin, Targets: []Target{
		{Provider: "a", Model: "one", Weight: 3},
		{Provider: "b", Model: "two", Weight: 2},
	}})
	const workers = 20
	const each = 100
	counts := map[string]int{}
	var countsMu sync.Mutex
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range each {
				pick, err := resolver.PickTarget("combo/balanced")
				if err != nil {
					errs <- err
					return
				}
				countsMu.Lock()
				counts[pick.Target.Provider]++
				countsMu.Unlock()
				resolver.NoteSuccess(pick)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if total := counts["a"] + counts["b"]; total != workers*each {
		t.Fatal(fmt.Sprintf("resolved %d requests, want %d", total, workers*each))
	}
}

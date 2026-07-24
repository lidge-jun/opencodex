package platform

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestStartupHealthCacheTTLAndStaleFallback(t *testing.T) {
	now := time.Date(2026, time.July, 24, 0, 0, 0, 0, time.UTC)
	cache := NewStartupHealthCache(30 * time.Second)
	cache.now = func() time.Time { return now }
	calls := 0
	probe := func(context.Context) (StartupHealthDiagnostics, error) {
		calls++
		return StartupHealthDiagnostics{Service: HealthDiagnostic{State: HealthHealthy, Summary: "call"}}, nil
	}
	first, err := cache.Get(context.Background(), probe)
	if err != nil || calls != 1 || first.CheckedAt != now {
		t.Fatalf("first=%+v calls=%d err=%v", first, calls, err)
	}
	now = now.Add(29 * time.Second)
	if _, err := cache.Get(context.Background(), probe); err != nil || calls != 1 {
		t.Fatalf("cached calls=%d err=%v", calls, err)
	}
	now = now.Add(2 * time.Second)
	failed := func(context.Context) (StartupHealthDiagnostics, error) {
		calls++
		return StartupHealthDiagnostics{}, errors.New("probe failed")
	}
	stale, err := cache.Get(context.Background(), failed)
	if err != nil || !stale.Stale || calls != 2 {
		t.Fatalf("stale=%+v calls=%d err=%v", stale, calls, err)
	}
	cache.Invalidate()
	if _, err := cache.Get(context.Background(), failed); err == nil {
		t.Fatal("expected probe error after invalidation")
	}
}

func TestStartupActionArguments(t *testing.T) {
	arguments, err := StartupActionArguments(StartupUninstallService)
	if err != nil || len(arguments) != 2 || arguments[0] != "service" || arguments[1] != "uninstall" {
		t.Fatalf("arguments=%v err=%v", arguments, err)
	}
	if _, err := StartupActionArguments("foreign"); err == nil {
		t.Fatal("expected unknown action rejection")
	}
}

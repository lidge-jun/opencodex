package platform

import (
	"context"
	"fmt"
	"os/exec"
	"sync"
	"time"
)

type StartupAction string

const (
	StartupInstallService   StartupAction = "install-service"
	StartupUninstallService StartupAction = "uninstall-service"
	StartupInstallShim      StartupAction = "install-shim"
	StartupUninstallShim    StartupAction = "uninstall-shim"
)

func StartupActionArguments(action StartupAction) ([]string, error) {
	switch action {
	case StartupInstallService:
		return []string{"service", "install"}, nil
	case StartupUninstallService:
		return []string{"service", "uninstall"}, nil
	case StartupInstallShim:
		return []string{"codex-shim", "install"}, nil
	case StartupUninstallShim:
		return []string{"codex-shim", "uninstall"}, nil
	default:
		return nil, fmt.Errorf("unknown startup action %q", action)
	}
}

func RunStartupAction(ctx context.Context, executable string, action StartupAction) error {
	arguments, err := StartupActionArguments(action)
	if err != nil {
		return err
	}
	command := exec.CommandContext(ctx, executable, arguments...)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("startup action %s: %w: %s", action, err, output)
	}
	return nil
}

type HealthState string

const (
	HealthHealthy HealthState = "healthy"
	HealthWarning HealthState = "warning"
	HealthOffline HealthState = "offline"
)

type HealthDiagnostic struct {
	State   HealthState `json:"state"`
	Summary string      `json:"summary,omitempty"`
}

type StartupHealthDiagnostics struct {
	Service   HealthDiagnostic `json:"service"`
	Tray      HealthDiagnostic `json:"tray"`
	Startup   HealthDiagnostic `json:"startup"`
	CheckedAt time.Time        `json:"checkedAt"`
	Stale     bool             `json:"stale,omitempty"`
}

type HealthProbe func(context.Context) (StartupHealthDiagnostics, error)

type StartupHealthCache struct {
	mu        sync.Mutex
	ttl       time.Duration
	now       func() time.Time
	value     StartupHealthDiagnostics
	expires   time.Time
	populated bool
}

func NewStartupHealthCache(ttl time.Duration) *StartupHealthCache {
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &StartupHealthCache{ttl: ttl, now: time.Now}
}

func (cache *StartupHealthCache) Get(ctx context.Context, probe HealthProbe) (StartupHealthDiagnostics, error) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	now := cache.now()
	if cache.populated && now.Before(cache.expires) {
		return cache.value, nil
	}
	value, err := probe(ctx)
	if err != nil {
		if cache.populated {
			stale := cache.value
			stale.Stale = true
			return stale, nil
		}
		return StartupHealthDiagnostics{}, err
	}
	if value.CheckedAt.IsZero() {
		value.CheckedAt = now.UTC()
	}
	value.Stale = false
	cache.value = value
	cache.expires = now.Add(cache.ttl)
	cache.populated = true
	return value, nil
}

func (cache *StartupHealthCache) Invalidate() {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.populated = false
	cache.expires = time.Time{}
}

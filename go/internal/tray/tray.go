package tray

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotSupported        = errors.New("system tray is not supported on this platform")
	ErrForeignRegistration = errors.New("refusing to modify a foreign tray startup registration")
)

const DefaultHeartbeatStaleAfter = 15 * time.Second

type State string

const (
	StateOnline  State = "online"
	StateWarning State = "warning"
	StateOffline State = "offline"
)

type Status struct {
	Supported bool   `json:"supported"`
	Installed bool   `json:"installed"`
	Running   bool   `json:"running"`
	Stale     bool   `json:"stale"`
	State     State  `json:"state"`
	Summary   string `json:"summary"`
}

type Command struct {
	Executable string
	Arguments  []string
}

type Config struct {
	StateDir            string
	Executable          string
	RunArguments        []string
	DashboardURL        string
	HealthURL           string
	StartupHealthURL    string
	RestartCommand      Command
	PollInterval        time.Duration
	HeartbeatInterval   time.Duration
	HeartbeatStaleAfter time.Duration
}

// Handoff records only owned state that may be restored after an executable update.
type Handoff struct {
	Installed bool
	Running   bool
}

// Manager owns one startup registration and its tray process. Implementations must
// never replace or remove a registration unless its persisted command matches.
type Manager interface {
	Install(ctx context.Context, startNow bool) (Status, error)
	Uninstall(ctx context.Context) (Status, error)
	Start(ctx context.Context) (Status, error)
	Stop(ctx context.Context) (Status, error)
	Status(ctx context.Context) (Status, error)
	Run(ctx context.Context) error
	PrepareUpdate(ctx context.Context) (Handoff, error)
	CompleteUpdate(ctx context.Context, handoff Handoff) (Status, error)
}

func New(config Config) (Manager, error) { return newManager(config) }

//go:build windows

package tray

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lxn/walk"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	runRegistryPath = `Software\Microsoft\Windows\CurrentVersion\Run`
	stateVersion    = 1
)

type registrationState struct {
	Version    int      `json:"version"`
	RunValue   string   `json:"runValue"`
	RunCommand string   `json:"runCommand"`
	Executable string   `json:"executable"`
	Arguments  []string `json:"arguments"`
}

type windowsManager struct {
	config        Config
	statePath     string
	heartbeatPath string
	stopPath      string
	runValue      string
}

func newManager(config Config) (Manager, error) {
	if strings.TrimSpace(config.StateDir) == "" || strings.TrimSpace(config.Executable) == "" {
		return nil, fmt.Errorf("tray state directory and executable are required")
	}
	absoluteStateDir, err := filepath.Abs(config.StateDir)
	if err != nil {
		return nil, err
	}
	absoluteExecutable, err := filepath.Abs(config.Executable)
	if err != nil {
		return nil, err
	}
	config.StateDir = absoluteStateDir
	config.Executable = absoluteExecutable
	if config.PollInterval <= 0 {
		config.PollInterval = 3 * time.Second
	}
	if config.HeartbeatInterval <= 0 {
		config.HeartbeatInterval = 3 * time.Second
	}
	if config.HeartbeatStaleAfter <= 0 {
		config.HeartbeatStaleAfter = DefaultHeartbeatStaleAfter
	}
	digest := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(absoluteStateDir))))
	return &windowsManager{
		config:        config,
		statePath:     filepath.Join(absoluteStateDir, "tray-state.json"),
		heartbeatPath: filepath.Join(absoluteStateDir, "tray-heartbeat.json"),
		stopPath:      filepath.Join(absoluteStateDir, "tray-stop"),
		runValue:      "OpenCodexTray-" + hex.EncodeToString(digest[:6]),
	}, nil
}

func (manager *windowsManager) desiredState() registrationState {
	arguments := append([]string(nil), manager.config.RunArguments...)
	command := windowsCommandLine(manager.config.Executable, arguments)
	return registrationState{Version: stateVersion, RunValue: manager.runValue, RunCommand: command, Executable: manager.config.Executable, Arguments: arguments}
}

func windowsCommandLine(executable string, arguments []string) string {
	parts := []string{quoteWindowsArgument(executable)}
	for _, argument := range arguments {
		parts = append(parts, quoteWindowsArgument(argument))
	}
	return strings.Join(parts, " ")
}

func quoteWindowsArgument(value string) string {
	if value != "" && !strings.ContainsAny(value, " \t\n\v\"") {
		return value
	}
	var builder strings.Builder
	builder.WriteByte('"')
	backslashes := 0
	for _, character := range value {
		if character == '\\' {
			backslashes++
			continue
		}
		if character == '"' {
			builder.WriteString(strings.Repeat("\\", backslashes*2+1))
			builder.WriteRune(character)
			backslashes = 0
			continue
		}
		builder.WriteString(strings.Repeat("\\", backslashes))
		backslashes = 0
		builder.WriteRune(character)
	}
	builder.WriteString(strings.Repeat("\\", backslashes*2))
	builder.WriteByte('"')
	return builder.String()
}

func (manager *windowsManager) readState() (*registrationState, error) {
	data, err := os.ReadFile(manager.statePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var state registrationState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("decode tray state: %w", err)
	}
	if state.Version != stateVersion || state.RunValue != manager.runValue || state.RunCommand == "" {
		return nil, fmt.Errorf("tray state is invalid or not owned by this installation")
	}
	return &state, nil
}

func (manager *windowsManager) readRegistration() (string, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, runRegistryPath, registry.QUERY_VALUE)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("open HKCU Run registry key: %w", err)
	}
	defer key.Close()
	value, _, err := key.GetStringValue(manager.runValue)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read tray startup registration: %w", err)
	}
	return value, nil
}

func (manager *windowsManager) assertRegistrationOwned() (*registrationState, string, error) {
	state, err := manager.readState()
	if err != nil {
		return nil, "", err
	}
	registered, err := manager.readRegistration()
	if err != nil {
		return nil, "", err
	}
	if registered != "" && (state == nil || registered != state.RunCommand) {
		return state, registered, ErrForeignRegistration
	}
	return state, registered, nil
}

func (manager *windowsManager) Install(ctx context.Context, startNow bool) (Status, error) {
	state, previousRegistration, err := manager.assertRegistrationOwned()
	if err != nil {
		return Status{}, err
	}
	if state != nil {
		handoff, stopErr := manager.PrepareUpdate(ctx)
		if stopErr != nil {
			return Status{}, stopErr
		}
		_ = handoff
	}
	if _, err := os.Stat(manager.config.Executable); err != nil {
		return Status{}, fmt.Errorf("tray executable: %w", err)
	}
	if err := os.MkdirAll(manager.config.StateDir, 0o700); err != nil {
		return Status{}, err
	}
	var previousState *registrationState
	if state != nil {
		copy := *state
		copy.Arguments = append([]string(nil), state.Arguments...)
		previousState = &copy
	}
	desired := manager.desiredState()
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runRegistryPath, registry.SET_VALUE)
	if err != nil {
		return Status{}, fmt.Errorf("open HKCU Run registry key for writing: %w", err)
	}
	defer key.Close()
	if err := key.SetStringValue(manager.runValue, desired.RunCommand); err != nil {
		return Status{}, fmt.Errorf("write tray startup registration: %w", err)
	}
	restoreRegistration := func() {
		if previousRegistration != "" {
			_ = key.SetStringValue(manager.runValue, previousRegistration)
		} else {
			_ = key.DeleteValue(manager.runValue)
		}
		if previousState != nil {
			_ = writeJSONAtomic(manager.statePath, *previousState)
		} else {
			_ = os.Remove(manager.statePath)
		}
	}
	if err := writeJSONAtomic(manager.statePath, desired); err != nil {
		restoreRegistration()
		return Status{}, err
	}
	if startNow {
		status, startErr := manager.Start(ctx)
		if startErr != nil {
			restoreRegistration()
			return status, startErr
		}
		return status, nil
	}
	return manager.Status(ctx)
}

func writeJSONAtomic(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".tray-state-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(data, '\n')); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return replaceOwnedFile(temporaryPath, path)
}

func (manager *windowsManager) Start(ctx context.Context) (Status, error) {
	state, registered, err := manager.assertRegistrationOwned()
	if err != nil {
		return Status{}, err
	}
	if state == nil || registered == "" || registered != state.RunCommand {
		return Status{}, fmt.Errorf("tray is not installed")
	}
	status, err := manager.Status(ctx)
	if err != nil || status.Running {
		return status, err
	}
	_ = os.Remove(manager.stopPath)
	command := exec.Command(manager.config.Executable, manager.config.RunArguments...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
	command.Stdin, command.Stdout, command.Stderr = nil, nil, nil
	if err := command.Start(); err != nil {
		return Status{}, fmt.Errorf("start tray: %w", err)
	}
	_ = command.Process.Release()
	return manager.waitForRunning(ctx, true)
}

func (manager *windowsManager) Stop(ctx context.Context) (Status, error) {
	state, _, err := manager.assertRegistrationOwned()
	if err != nil {
		return Status{}, err
	}
	if state == nil {
		return manager.Status(ctx)
	}
	if err := os.WriteFile(manager.stopPath, []byte("stop\n"), 0o600); err != nil {
		return Status{}, fmt.Errorf("signal tray stop: %w", err)
	}
	return manager.waitForRunning(ctx, false)
}

func (manager *windowsManager) waitForRunning(ctx context.Context, expected bool) (Status, error) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		status, err := manager.Status(ctx)
		if err != nil {
			return Status{}, err
		}
		if status.Running == expected {
			return status, nil
		}
		select {
		case <-ctx.Done():
			return status, fmt.Errorf("wait for tray running=%t: %w", expected, ctx.Err())
		case <-ticker.C:
		}
	}
}

func (manager *windowsManager) Uninstall(ctx context.Context) (Status, error) {
	state, registered, err := manager.assertRegistrationOwned()
	if err != nil {
		return Status{}, err
	}
	if state != nil {
		if _, err := manager.Stop(ctx); err != nil {
			return Status{}, err
		}
	}
	if registered != "" {
		key, err := registry.OpenKey(registry.CURRENT_USER, runRegistryPath, registry.SET_VALUE)
		if err != nil {
			return Status{}, err
		}
		err = key.DeleteValue(manager.runValue)
		key.Close()
		if err != nil && !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return Status{}, fmt.Errorf("remove tray startup registration: %w", err)
		}
	}
	for _, path := range []string{manager.statePath, manager.heartbeatPath, manager.stopPath} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return Status{}, err
		}
	}
	return manager.Status(ctx)
}

func (manager *windowsManager) Status(context.Context) (Status, error) {
	state, registered, err := manager.assertRegistrationOwned()
	if err != nil {
		if errors.Is(err, ErrForeignRegistration) {
			return Status{Supported: true, Installed: false, Stale: true, State: StateWarning, Summary: "startup registration is foreign or unowned"}, err
		}
		return Status{}, err
	}
	installed := state != nil && registered != "" && registered == state.RunCommand
	heartbeat, heartbeatErr := ReadHeartbeat(manager.heartbeatPath, manager.config.HeartbeatStaleAfter, time.Now().UTC())
	running := heartbeatErr == nil && processAlive(heartbeat.Heartbeat.PID)
	stale := heartbeatErr == nil && (!running || heartbeat.Stale)
	summary := "not installed"
	if installed && running {
		summary = "installed and running"
	} else if installed {
		summary = "installed, not currently running"
	} else if running {
		summary = "unregistered tray process is running"
		stale = true
	}
	stateValue := StateOffline
	if running {
		stateValue = StateOnline
	}
	if stale {
		stateValue = StateWarning
	}
	return Status{Supported: true, Installed: installed, Running: running, Stale: stale, State: stateValue, Summary: summary}, nil
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	windows.CloseHandle(handle)
	return true
}

func (manager *windowsManager) PrepareUpdate(ctx context.Context) (Handoff, error) {
	status, err := manager.Status(ctx)
	if err != nil {
		return Handoff{}, err
	}
	handoff := Handoff{Installed: status.Installed, Running: status.Running}
	if status.Running {
		if _, err := manager.Stop(ctx); err != nil {
			return Handoff{}, err
		}
	}
	return handoff, nil
}

func (manager *windowsManager) CompleteUpdate(ctx context.Context, handoff Handoff) (Status, error) {
	if !handoff.Installed {
		return manager.Status(ctx)
	}
	return manager.Install(ctx, handoff.Running)
}

type trayView struct {
	manager *windowsManager
	window  *walk.MainWindow
	notify  *walk.NotifyIcon
	status  *walk.Action
	open    *walk.Action
	restart *walk.Action
	icons   map[State]*walk.Icon
	mu      sync.Mutex
	state   State
}

func (manager *windowsManager) Run(ctx context.Context) error {
	state, registered, err := manager.assertRegistrationOwned()
	if err != nil {
		return err
	}
	if state == nil || registered == "" || registered != state.RunCommand {
		return fmt.Errorf("tray is not installed")
	}
	window, err := walk.NewMainWindow()
	if err != nil {
		return err
	}
	notify, err := walk.NewNotifyIcon(window)
	if err != nil {
		return err
	}
	view := &trayView{manager: manager, window: window, notify: notify, icons: map[State]*walk.Icon{
		StateOnline: walk.IconInformation(), StateWarning: walk.IconWarning(), StateOffline: walk.IconError(),
	}}
	if err := view.configure(); err != nil {
		notify.Dispose()
		return err
	}
	runContext, cancel := context.WithCancel(ctx)
	defer cancel()
	defer os.Remove(manager.heartbeatPath)
	defer os.Remove(manager.stopPath)
	go view.poll(runContext)
	go func() {
		<-runContext.Done()
		window.Synchronize(func() { walk.App().Exit(0) })
	}()
	window.Run()
	notify.SetVisible(false)
	notify.Dispose()
	return nil
}

func (view *trayView) configure() error {
	view.status = walk.NewAction()
	view.status.SetText("Proxy: Checking...")
	view.status.SetEnabled(false)
	view.open = walk.NewAction()
	view.open.SetText("Open Dashboard")
	view.open.Triggered().Attach(func() { _ = openDashboard(view.manager.config.DashboardURL) })
	view.restart = walk.NewAction()
	view.restart.SetText("Restart Proxy")
	view.restart.Triggered().Attach(func() { _ = runDetached(view.manager.config.RestartCommand) })
	quit := walk.NewAction()
	quit.SetText("Quit")
	quit.Triggered().Attach(func() { walk.App().Exit(0) })
	for _, action := range []*walk.Action{view.status, view.open, view.restart, quit} {
		if err := view.notify.ContextMenu().Actions().Add(action); err != nil {
			return err
		}
	}
	view.notify.MouseDown().Attach(func(_, _ int, button walk.MouseButton) {
		if button == walk.LeftButton {
			_ = openDashboard(view.manager.config.DashboardURL)
		}
	})
	if err := view.notify.SetIcon(view.icons[StateOffline]); err != nil {
		return err
	}
	if err := view.notify.SetToolTip("opencodex: Checking..."); err != nil {
		return err
	}
	return view.notify.SetVisible(true)
}

func (view *trayView) poll(ctx context.Context) {
	heartbeat := HeartbeatWriter{Path: view.manager.heartbeatPath, PID: os.Getpid(), Interval: view.manager.config.HeartbeatInterval}
	heartbeatContext, cancelHeartbeat := context.WithCancel(ctx)
	defer cancelHeartbeat()
	go func() { _ = heartbeat.Run(heartbeatContext) }()
	ticker := time.NewTicker(view.manager.config.PollInterval)
	defer ticker.Stop()
	for {
		state, label := view.manager.pollHealth(ctx)
		view.window.Synchronize(func() { view.applyState(state, label) })
		if _, err := os.Stat(view.manager.stopPath); err == nil {
			view.window.Synchronize(func() { walk.App().Exit(0) })
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (manager *windowsManager) pollHealth(ctx context.Context) (State, string) {
	if manager.config.HealthURL == "" {
		return StateOffline, "Proxy: Offline"
	}
	probeContext, cancel := context.WithTimeout(ctx, 900*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(probeContext, http.MethodGet, manager.config.HealthURL, nil)
	if err != nil {
		return StateWarning, "Proxy: Health URL invalid"
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return StateOffline, "Proxy: Offline"
	}
	defer response.Body.Close()
	var health struct {
		Status  string `json:"status"`
		Service string `json:"service"`
		Port    int    `json:"port"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&health) != nil || health.Status != "ok" || health.Service != "opencodex" {
		return StateWarning, "Proxy: Health warning"
	}
	label := "Proxy: Online"
	if health.Port > 0 {
		label += " (port " + strconv.Itoa(health.Port) + ")"
	}
	if manager.config.StartupHealthURL != "" && !manager.startupHealthSafe(ctx) {
		return StateWarning, label + " - startup safety warning"
	}
	return StateOnline, label
}

func (manager *windowsManager) startupHealthSafe(ctx context.Context) bool {
	probeContext, cancel := context.WithTimeout(ctx, 900*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(probeContext, http.MethodGet, manager.config.StartupHealthURL, nil)
	if err != nil {
		return false
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	var health struct {
		Status string `json:"status"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&health) != nil {
		return false
	}
	return health.Status != "at-risk" && health.Status != "warning"
}

func (view *trayView) applyState(state State, label string) {
	view.mu.Lock()
	defer view.mu.Unlock()
	view.status.SetText(label)
	view.restart.SetEnabled(state == StateOnline)
	view.open.SetEnabled(state != StateOffline)
	view.notify.SetToolTip("opencodex: " + string(state))
	if view.state != state {
		_ = view.notify.SetIcon(view.icons[state])
		view.state = state
	}
}

func openDashboard(rawURL string) error {
	if rawURL == "" {
		return fmt.Errorf("dashboard URL is not configured")
	}
	return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", rawURL).Start()
}

func runDetached(command Command) error {
	if command.Executable == "" {
		return fmt.Errorf("restart command is not configured")
	}
	child := exec.Command(command.Executable, command.Arguments...)
	child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
	if err := child.Start(); err != nil {
		return err
	}
	return child.Process.Release()
}

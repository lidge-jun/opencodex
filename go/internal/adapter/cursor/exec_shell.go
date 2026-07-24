package cursor

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

const defaultShellTimeout = 120 * time.Second

type ShellRequest struct {
	Command, WorkingDirectory, Shell string
	Timeout                          time.Duration
	Env                              map[string]string
}
type ShellResult struct {
	Command, WorkingDirectory, Stdout, Stderr, Signal string
	ExitCode                                          int
	Duration                                          time.Duration
	Aborted                                           bool
}
type ShellEvent struct {
	Stream, Data string
	ExitCode     *int
	Aborted      bool
}
type BackgroundShellResult struct {
	ShellID                   int64
	PID                       int
	Command, WorkingDirectory string
}
type StdinResult struct {
	ShellID           int64
	OutputBytesBefore int64
}

type backgroundShell struct {
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	outputBytes atomic.Int64
	done        chan struct{}
}

type ShellExecutor struct {
	Policy     ExecPolicy
	mu         sync.Mutex
	nextID     int64
	background map[int64]*backgroundShell
}

func NewShellExecutor(policy ExecPolicy) *ShellExecutor {
	return &ShellExecutor{Policy: policy, background: make(map[int64]*backgroundShell)}
}

func (e *ShellExecutor) Run(ctx context.Context, req ShellRequest) (ShellResult, error) {
	if err := e.Policy.allowLocal("shell"); err != nil {
		return ShellResult{}, err
	}
	ctx, cancel := boundedContext(ctx, req.Timeout)
	defer cancel()
	cmd, cwd, err := shellCommand(ctx, req)
	if err != nil {
		return ShellResult{}, err
	}
	started := time.Now()
	var stdout, stderr lockedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	result := shellResult(cmd, req.Command, cwd, stdout.String(), stderr.String(), time.Since(started), ctx.Err() != nil)
	if err != nil && !isExitError(err) && ctx.Err() == nil {
		return result, err
	}
	return result, nil
}

// Stream emits stdout/stderr line fragments as they arrive and always ends with an exit event.
func (e *ShellExecutor) Stream(ctx context.Context, req ShellRequest) (<-chan ShellEvent, error) {
	if err := e.Policy.allowLocal("shell"); err != nil {
		return nil, err
	}
	ctx, cancel := boundedContext(ctx, req.Timeout)
	cmd, _, err := shellCommand(ctx, req)
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	events := make(chan ShellEvent, 32)
	go func() {
		defer close(events)
		defer cancel()
		var readers sync.WaitGroup
		readers.Add(2)
		go streamLines(stdout, "stdout", events, &readers)
		go streamLines(stderr, "stderr", events, &readers)
		err := cmd.Wait()
		readers.Wait()
		code := exitCode(err)
		events <- ShellEvent{Stream: "exit", ExitCode: &code, Aborted: ctx.Err() != nil}
	}()
	return events, nil
}

func (e *ShellExecutor) StartBackground(_ context.Context, req ShellRequest) (BackgroundShellResult, error) {
	if err := e.Policy.allowLocal("shell"); err != nil {
		return BackgroundShellResult{}, err
	}
	// A background process intentionally outlives the request that spawned it.
	cmd, cwd, err := shellCommand(context.Background(), req)
	if err != nil {
		return BackgroundShellResult{}, err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return BackgroundShellResult{}, err
	}
	bg := &backgroundShell{cmd: cmd, stdin: stdin, done: make(chan struct{})}
	cmd.Stdout = byteCounter{&bg.outputBytes}
	cmd.Stderr = byteCounter{&bg.outputBytes}
	if err := cmd.Start(); err != nil {
		return BackgroundShellResult{}, err
	}
	e.mu.Lock()
	e.nextID++
	id := e.nextID
	e.background[id] = bg
	e.mu.Unlock()
	go func() { _ = cmd.Wait(); close(bg.done); e.mu.Lock(); delete(e.background, id); e.mu.Unlock() }()
	return BackgroundShellResult{ShellID: id, PID: cmd.Process.Pid, Command: req.Command, WorkingDirectory: cwd}, nil
}

func (e *ShellExecutor) WriteStdin(shellID int64, data string) (StdinResult, error) {
	if err := e.Policy.allowLocal("shell"); err != nil {
		return StdinResult{}, err
	}
	e.mu.Lock()
	shell := e.background[shellID]
	e.mu.Unlock()
	if shell == nil {
		return StdinResult{}, fmt.Errorf("unknown shell id %d", shellID)
	}
	before := shell.outputBytes.Load()
	if _, err := io.WriteString(shell.stdin, data); err != nil {
		return StdinResult{}, err
	}
	return StdinResult{ShellID: shellID, OutputBytesBefore: before}, nil
}

func (e *ShellExecutor) Stop(shellID int64) error {
	e.mu.Lock()
	shell := e.background[shellID]
	e.mu.Unlock()
	if shell == nil {
		return fmt.Errorf("unknown shell id %d", shellID)
	}
	return shell.cmd.Process.Kill()
}

func shellCommand(ctx context.Context, req ShellRequest) (*exec.Cmd, string, error) {
	if req.Command == "" {
		return nil, "", errors.New("shell command is empty")
	}
	cwd := req.WorkingDirectory
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return nil, "", err
		}
	}
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		return nil, "", fmt.Errorf("working directory is not accessible: %s", cwd)
	}
	shell := req.Shell
	var args []string
	if shell == "" {
		if runtime.GOOS == "windows" {
			shell = "cmd.exe"
			args = []string{"/d", "/s", "/c", req.Command}
		} else {
			shell = "/bin/sh"
			args = []string{"-c", req.Command}
		}
	} else if runtime.GOOS == "windows" {
		args = []string{"/d", "/s", "/c", req.Command}
	} else {
		args = []string{"-c", req.Command}
	}
	cmd := exec.CommandContext(ctx, shell, args...)
	cmd.Dir = cwd
	cmd.Env = os.Environ()
	for key, value := range req.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd, cwd, nil
}

func boundedContext(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	if timeout <= 0 {
		timeout = defaultShellTimeout
	}
	return context.WithTimeout(parent, timeout)
}
func isExitError(err error) bool { var target *exec.ExitError; return errors.As(err, &target) }
func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var target *exec.ExitError
	if errors.As(err, &target) {
		return target.ExitCode()
	}
	return 1
}
func shellResult(cmd *exec.Cmd, command, cwd, stdout, stderr string, elapsed time.Duration, aborted bool) ShellResult {
	code := 0
	signal := ""
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
		if status := cmd.ProcessState.String(); code < 0 {
			signal = status
		}
	}
	return ShellResult{Command: command, WorkingDirectory: cwd, Stdout: stdout, Stderr: stderr, ExitCode: code, Signal: signal, Duration: elapsed, Aborted: aborted}
}

func streamLines(reader io.Reader, stream string, out chan<- ShellEvent, wg *sync.WaitGroup) {
	defer wg.Done()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 1_000_000)
	for scanner.Scan() {
		out <- ShellEvent{Stream: stream, Data: scanner.Text() + "\n"}
	}
	if err := scanner.Err(); err != nil {
		out <- ShellEvent{Stream: "stderr", Data: err.Error()}
	}
}

type lockedBuffer struct {
	mu   sync.Mutex
	data []byte
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	b.data = append(b.data, p...)
	b.mu.Unlock()
	return len(p), nil
}
func (b *lockedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return string(b.data) }

type byteCounter struct{ count *atomic.Int64 }

func (w byteCounter) Write(p []byte) (int, error) { w.count.Add(int64(len(p))); return len(p), nil }

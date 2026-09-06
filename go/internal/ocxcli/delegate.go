package ocxcli

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// DelegateToTypeScript invokes the source lifecycle owner with inherited file
// descriptors. OCX_TYPESCRIPT_CLI is intended for packaged deployments; a
// checkout is discovered from the current working directory for development.
func DelegateToTypeScript(args []string) (int, error) {
	cli, err := typeScriptCLIPath()
	if err != nil {
		return ExitFailure, err
	}
	bun := os.Getenv("OCX_BUN")
	if bun == "" {
		bun = "bun"
	}
	command := exec.Command(bun, append([]string{cli}, args...)...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	err = command.Run()
	if err == nil {
		return ExitOK, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	return ExitFailure, fmt.Errorf("run TypeScript lifecycle owner: %w", err)
}

func typeScriptCLIPath() (string, error) {
	if configured := os.Getenv("OCX_TYPESCRIPT_CLI"); configured != "" {
		if info, err := os.Stat(configured); err == nil && !info.IsDir() {
			return configured, nil
		}
		return "", fmt.Errorf("OCX_TYPESCRIPT_CLI is not a readable file: %s", configured)
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		candidate := filepath.Join(dir, "src", "cli", "index.ts")
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", errors.New("TypeScript lifecycle owner not found; set OCX_TYPESCRIPT_CLI to src/cli/index.ts")
}

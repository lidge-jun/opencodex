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
		return "", fmt.Errorf("OCX_TYPESCRIPT_CLI is not a readable TypeScript CLI file: %s; install or update the full OpenCodex distribution, or point OCX_TYPESCRIPT_CLI at src/cli/index.ts", configured)
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
	return "", errors.New("this standalone ocx binary needs the TypeScript lifecycle owner for this command; install or update the full OpenCodex distribution, or set OCX_TYPESCRIPT_CLI to an explicit src/cli/index.ts path (and OCX_BUN to Bun if it is not on PATH)")
}

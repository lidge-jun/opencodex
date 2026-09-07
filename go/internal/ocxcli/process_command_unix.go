//go:build !windows

package ocxcli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// readProcessCommandLine mirrors the Unix portion of the TypeScript probe:
// procfs first on Linux, then fixed absolute ps paths. A failed probe is
// reported as an error so destructive callers can retain fail-open behavior.
func readProcessCommandLine(pid int) (string, error) {
	if pid <= 0 {
		return "", errors.New("invalid pid")
	}
	if runtimeGOOS() == "linux" {
		if raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid)); err == nil {
			if value := strings.TrimSpace(strings.ReplaceAll(string(raw), "\x00", " ")); value != "" {
				return value, nil
			}
		}
	}
	for _, ps := range []string{"/bin/ps", "/usr/bin/ps"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		output, err := exec.CommandContext(ctx, ps, "-p", strconv.Itoa(pid), "-o", "command=").CombinedOutput()
		cancel()
		if err != nil {
			continue
		}
		if value := strings.TrimSpace(string(output)); value != "" {
			return value, nil
		}
	}
	return "", errors.New("process command inspection is unavailable on this platform")
}

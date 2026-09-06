//go:build linux

package ocxcli

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// doctorBootTime mirrors the TypeScript uptime-derived boot floor. An unreadable
// proc file disables the optimization, preserving the more conservative PID check.
func doctorBootTime(now time.Time) time.Time {
	raw, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}
	}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || fields[0] != "btime" {
			continue
		}
		seconds, parseErr := strconv.ParseInt(fields[1], 10, 64)
		if parseErr != nil || seconds <= 0 {
			return time.Time{}
		}
		boot := time.Unix(seconds, 0)
		if boot.After(now) {
			return time.Time{}
		}
		return boot
	}
	return time.Time{}
}

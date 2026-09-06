//go:build !linux

package ocxcli

import "time"

func doctorBootTime(time.Time) time.Time { return time.Time{} }

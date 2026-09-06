//go:build windows

package ocxcli

// A false negative is safer than unlinking a live atomic writer. Windows does
// not expose Unix signal-0 semantics through os.Process, so keep the candidate.
func doctorProcessAlive(pid int) bool { return true }

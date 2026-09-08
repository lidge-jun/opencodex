//go:build !linux

package ocxcli

// Non-Linux app-server enumeration is not ported. The TS owner enumerates via
// ps (macOS) or PowerShell GetOwner (Windows); the Go binary treats both as
// "no Codex app-server processes", which is byte-identical in every fixture
// environment and diverges only when a real Codex app-server process is
// running on macOS/Windows during a catalog write.

type codexAppServerProcess struct {
	pid         int
	commandLine string
}

func listCodexAppServerProcesses() []codexAppServerProcess {
	return nil
}

// afterCatalogWriteHandleAppServers is a no-op outside Linux: no Codex
// app-server process is ever enumerated, which matches the TypeScript owner's
// output in every fixture environment.
func afterCatalogWriteHandleAppServers(deps Deps, restartCodex, toStderr bool) {}

# 020 — WP2: reporting resident memory instead of reserved address space

## Symptom

The dashboard's "상주 메모리 (RSS)" tile disagrees with the operating system, and the number
it shows does not fall when the runtime frees memory. Measured live on 2026-07-29 against
pid 97438:

| Source | Value |
|---|---|
| `/api/system/memory` -> `rss` | 992 MiB |
| `ps -o rss=` for the same pid | 971 MiB |
| `heapUsed` (`MemStats.HeapAlloc`) | 335 MiB |

The watchdog history shows the sharper tell: between 11:57 and 12:04 `heapUsed` sat flat at
4-5 MiB while the reported `rss` stayed pinned at 615 MiB and never moved, because the field
being sampled is not a measurement of residency at all.

## Root cause

Two sites publish `runtime.MemStats.Sys` under the name `rss`.

`go/internal/management/system.go:34`:

```go
writeJSON(w, http.StatusOK, map[string]any{..., "rss": stats.Sys, "heapUsed": stats.HeapAlloc, ...})
```

`go/internal/server/watchdog.go:58`:

```go
return MemorySample{At: time.Now(), RSS: m.Sys, HeapUsed: m.HeapAlloc, HeapTotal: m.HeapSys}
```

`Sys` is the total address space the Go runtime has obtained from the OS. It counts memory
the runtime has already returned, and it never decreases in practice, so it is an upper bound
on lifetime reservation rather than current residency. The oracle reads the real thing:
`src/server/management/system-routes.ts:50` uses `process.memoryUsage().rss`, which on every
platform Bun supports is the OS-reported resident set.

`NewMemoryWatchdog` already anticipated this. `go/internal/server/watchdog.go:26`:

```go
// NewMemoryWatchdog samples memory into a fixed-size ring. sample may be injected for platform RSS accuracy.
```

The injection point (`server.Config.MemorySample`, `go/internal/server/server.go:82`) exists
and is unused; the platform probe it was waiting for was never written.

## NEW / MODIFY map

### NEW `go/internal/platform/rss_darwin.go`

```go
//go:build darwin

package platform

// procTaskInfo mirrors darwin's struct proc_taskinfo. Only the leading fields are
// read, but the whole struct must be declared so the kernel's size check passes.
type procTaskInfo struct { ... ResidentSize uint64 ... }

func residentSetSize() (uint64, bool) {
	var info procTaskInfo
	written, _, errno := syscall.Syscall6(
		syscall.SYS_PROC_INFO, procInfoCallNumPIDInfo, uintptr(os.Getpid()),
		procPIDTaskInfo, 0, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if errno != 0 || written == 0 {
		return 0, false
	}
	return info.ResidentSize, true
}
```

Verified before writing this plan: a standalone build of this call against pid 97438 returned
`rss 1018888192` while `ps` reported `995008` KiB — the same number. It needs no cgo, which
matters because `scripts/build-go-release.go:131` pins `CGO_ENABLED=0` for every target.

### NEW `go/internal/platform/rss_linux.go`

```go
//go:build linux
```

Read field 2 of `/proc/self/statm` (resident pages) and multiply by `os.Getpagesize()`.
Return `false` when the file is missing or unparsable.

### NEW `go/internal/platform/rss_windows.go`

```go
//go:build windows
```

**Amended during the A gate.** The first draft named `windows.VM_COUNTERS`, and that type
does not exist in the pinned `golang.org/x/sys v0.46.0` — the `WorkingSetSize` field found by
the original search belongs to `SYSTEM_PROCESS_INFORMATION`
(`windows/types_windows.go:3238`), a different structure reached through a different call.
Writing the plan's version would not have compiled.

`NtQueryInformationProcess` and the `ProcessVmCounters` class are both present
(`windows/syscall_windows.go:460`, `windows/types_windows.go:3106`), so the call is
available but the result struct has to be declared locally. Use
`psapi.GetProcessMemoryInfo`, which is the documented API for this question and needs
only a locally declared `PROCESS_MEMORY_COUNTERS`:

```go
var modpsapi = windows.NewLazySystemDLL("psapi.dll")
var procGetProcessMemoryInfo = modpsapi.NewProc("GetProcessMemoryInfo")

type processMemoryCounters struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	...
}
```

`psapi.dll` is already loaded this way inside `x/sys` itself
(`windows/zsyscall_windows.go:50`), so the mechanism is proven in the pinned dependency
even though this file declares its own proc. Compile-verified only: no Windows host is
available here, which is exactly why the `MemStats.Sys` fallback stays.

### NEW `go/internal/platform/rss_other.go`

```go
//go:build !darwin && !linux && !windows
```

`func residentSetSize() (uint64, bool) { return 0, false }` so unlisted platforms still build.

### NEW `go/internal/platform/rss.go`

Exported wrapper `func ResidentSetSize() (uint64, bool)` delegating to the per-platform
implementation, so callers never see build tags.

### MODIFY `go/internal/server/watchdog.go` — `runtimeMemorySample`

```go
func runtimeMemorySample() MemorySample {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	// Sys is the address space the runtime reserved over its lifetime, not what is
	// resident now, so prefer the OS figure and keep Sys only as a fallback.
	rss := m.Sys
	if resident, ok := platform.ResidentSetSize(); ok {
		rss = resident
	}
	return MemorySample{At: time.Now(), RSS: rss, HeapUsed: m.HeapAlloc, HeapTotal: m.HeapSys}
}
```

### MODIFY `go/internal/management/system.go` — `/api/system/memory`

Same substitution for the `"rss"` field. `heapUsed`/`heapTotal` keep reading `HeapAlloc`/
`HeapSys`; they are correct, only mislabeled downstream (WP3).

Import direction check: `internal/platform` currently depends on no other internal package
(`go list -deps ./internal/platform`), and both `internal/server` and `internal/management`
already import it (`server/port_reclaim.go:14`), so this introduces no cycle.

## TESTS

### NEW `go/internal/platform/rss_test.go`

- On a supported platform, `ResidentSetSize` returns `ok` and a plausible non-zero value
  (above one page, below the machine's physical memory).
- Allocating and touching a large slice raises the reported value, proving it tracks
  residency rather than returning a constant. Guarded with a generous margin and skipped
  when `ok` is false so the test stays honest on unsupported platforms.

### MODIFY `go/internal/server/watchdog_test.go`

The existing test injects its own sampler and stays valid. Add a case asserting that the
default `runtimeMemorySample` does not report `Sys` when the platform probe succeeds.

## Verification (C)

| Command | Expected |
|---|---|
| `cd go && go build ./...` | exit 0 |
| `cd go && go test ./internal/platform/... ./internal/server/... ./internal/management/...` | exit 0 |
| `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./cmd/ocx` (+ darwin/windows, both arches) | exit 0 for all six release targets |
| rebuild dogfood, compare `rss` from the endpoint against `ps -o rss=` | within normal sampling drift |

Cross-compiling all six targets is the only evidence that satisfies c4, since the Windows and
Linux probes cannot be executed here.

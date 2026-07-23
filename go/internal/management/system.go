package management

import (
	"net/http"
	"os"
	"runtime"
	"time"
)

var processStarted = time.Now()

func (a *API) handleSystem(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	switch r.URL.Path {
	case "/api/system/runtime":
		result := a.runtimeInfo()
		result["pid"] = os.Getpid()
		result["uptimeSeconds"] = time.Since(processStarted).Seconds()
		a.mu.RLock()
		result["streamMode"] = a.config.StreamMode
		a.mu.RUnlock()
		writeJSON(w, http.StatusOK, result)
		return true
	case "/api/system/memory":
		var stats runtime.MemStats
		runtime.ReadMemStats(&stats)
		a.mu.RLock()
		mode := a.config.StreamMode
		a.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{"pid": os.Getpid(), "goVersion": runtime.Version(), "platform": runtime.GOOS, "uptimeSeconds": time.Since(processStarted).Seconds(), "rss": stats.Sys, "heapUsed": stats.HeapAlloc, "heapTotal": stats.HeapSys, "goroutines": runtime.NumGoroutine(), "streamMode": mode})
		return true
	}
	return false
}

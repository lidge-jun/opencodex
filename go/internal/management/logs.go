package management

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/storage"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

type RequestLogEntry struct {
	RequestID     string       `json:"requestId"`
	Timestamp     int64        `json:"timestamp"`
	Provider      string       `json:"provider"`
	Model         string       `json:"model"`
	Status        int          `json:"status"`
	DurationMS    int64        `json:"durationMs"`
	FirstOutputMS *int64       `json:"firstOutputMs,omitempty"`
	ErrorCode     string       `json:"errorCode,omitempty"`
	UpstreamError string       `json:"upstreamError,omitempty"`
	UsageStatus   usage.Status `json:"usageStatus"`
	Usage         *types.Usage `json:"usage,omitempty"`
	TotalTokens   *int         `json:"totalTokens,omitempty"`
}

type RequestLog struct {
	mu       sync.RWMutex
	entries  []RequestLogEntry
	capacity int
	sequence atomic.Uint64
	usage    *usage.Log
}
type RequestAttempt struct {
	RequestID     string
	Provider      string
	Model         string
	StartedAt     time.Time
	FirstOutputMS *int64
}

func NewRequestLog(capacity int) *RequestLog {
	if capacity <= 0 {
		capacity = 200
	}
	return &RequestLog{capacity: capacity, entries: make([]RequestLogEntry, 0, capacity)}
}
func (l *RequestLog) SetUsageLog(log *usage.Log) { l.mu.Lock(); l.usage = log; l.mu.Unlock() }
func (l *RequestLog) Begin(provider, model string) RequestAttempt {
	now := time.Now()
	seq := l.sequence.Add(1) % 1_000_000
	return RequestAttempt{RequestID: fmt.Sprintf("ocx-%s-%x", strconv.FormatInt(now.UnixMilli(), 36), seq), Provider: provider, Model: model, StartedAt: now}
}
func (a *RequestAttempt) MarkFirstOutput(now time.Time) {
	if a.FirstOutputMS == nil {
		value := max(int64(0), now.Sub(a.StartedAt).Milliseconds())
		a.FirstOutputMS = &value
	}
}
func (l *RequestLog) Finish(attempt RequestAttempt, status int, value *types.Usage, upstreamError string) RequestLogEntry {
	usageStatus := usage.StatusUnreported
	var total *int
	if value != nil {
		usageStatus = usage.StatusReported
		if value.Estimated {
			usageStatus = usage.StatusEstimated
		}
		n := usage.CanonicalTotal(*value)
		total = &n
	}
	entry := RequestLogEntry{RequestID: attempt.RequestID, Timestamp: attempt.StartedAt.UnixMilli(), Provider: attempt.Provider, Model: attempt.Model, Status: status, DurationMS: time.Since(attempt.StartedAt).Milliseconds(), FirstOutputMS: attempt.FirstOutputMS, ErrorCode: httpErrorCode(status), UpstreamError: config.RedactString(upstreamError), UsageStatus: usageStatus, Usage: value, TotalTokens: total}
	l.Add(entry)
	return entry
}
func (l *RequestLog) Add(entry RequestLogEntry) {
	entry.UpstreamError = config.RedactString(entry.UpstreamError)
	l.mu.Lock()
	l.entries = append(l.entries, entry)
	if len(l.entries) > l.capacity {
		copy(l.entries, l.entries[len(l.entries)-l.capacity:])
		l.entries = l.entries[:l.capacity]
	}
	persist := l.usage
	l.mu.Unlock()
	if persist != nil {
		_ = persist.Append(usage.Entry{RequestID: entry.RequestID, Timestamp: entry.Timestamp, Provider: entry.Provider, Model: entry.Model, Status: entry.Status, DurationMS: entry.DurationMS, FirstOutputMS: entry.FirstOutputMS, UsageStatus: entry.UsageStatus, Usage: entry.Usage, TotalTokens: entry.TotalTokens, ErrorCode: entry.ErrorCode, UpstreamError: entry.UpstreamError})
	}
}
func (l *RequestLog) Entries(provider, status string, tail int) []RequestLogEntry {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make([]RequestLogEntry, 0, len(l.entries))
	for _, entry := range l.entries {
		if provider != "" && entry.Provider != provider {
			continue
		}
		if status != "" && !matchesStatus(entry.Status, status) {
			continue
		}
		out = append(out, entry)
	}
	if tail > 0 && len(out) > tail {
		out = out[len(out)-tail:]
	}
	return out
}
func (l *RequestLog) Clear() { l.mu.Lock(); l.entries = l.entries[:0]; l.mu.Unlock() }
func (l *RequestLog) Hydrate(entries []usage.Entry) {
	l.mu.Lock()
	defer l.mu.Unlock()
	start := max(0, len(entries)-l.capacity)
	for _, entry := range entries[start:] {
		l.entries = append(l.entries, RequestLogEntry{RequestID: entry.RequestID, Timestamp: entry.Timestamp, Provider: entry.Provider, Model: entry.Model, Status: entry.Status, DurationMS: entry.DurationMS, FirstOutputMS: entry.FirstOutputMS, ErrorCode: entry.ErrorCode, UpstreamError: entry.UpstreamError, UsageStatus: entry.UsageStatus, Usage: entry.Usage, TotalTokens: entry.TotalTokens})
	}
}

func (a *API) handleLogs(w http.ResponseWriter, r *http.Request) bool {
	switch r.Method + " " + r.URL.Path {
	case "GET /api/logs":
		tail, _ := strconv.Atoi(r.URL.Query().Get("tail"))
		entries := a.requestLogs.Entries(strings.TrimSpace(r.URL.Query().Get("provider")), strings.TrimSpace(r.URL.Query().Get("status")), min(max(tail, 0), 200))
		rows := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			rows = append(rows, metricDTO(entry))
		}
		writeJSON(w, http.StatusOK, rows)
		return true
	case "DELETE /api/logs":
		a.requestLogs.Clear()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return true
	case "GET /api/debug":
		a.mu.RLock()
		enabled := a.debugEnabled
		a.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{"usage": enabled})
		return true
	case "PUT /api/debug":
		var body struct {
			Usage *bool `json:"usage,omitempty"`
			Reset bool  `json:"reset,omitempty"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if body.Reset {
			a.mu.Lock()
			a.debugEnabled = false
			a.mu.Unlock()
		} else if body.Usage != nil {
			a.mu.Lock()
			a.debugEnabled = *body.Usage
			a.mu.Unlock()
		} else {
			writeError(w, http.StatusBadRequest, "provide usage boolean or reset:true")
			return true
		}
		a.mu.RLock()
		enabled := a.debugEnabled
		a.mu.RUnlock()
		if !enabled && a.debugLog != nil {
			_ = a.debugLog.Clear()
		}
		writeJSON(w, http.StatusOK, map[string]any{"usage": enabled})
		return true
	case "GET /api/debug/usage-logs":
		if a.debugLog == nil {
			writeJSON(w, http.StatusOK, []any{})
			return true
		}
		after, _ := strconv.Atoi(r.URL.Query().Get("after"))
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		entries, err := a.debugLog.Entries(after, limit)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "usage diagnostics could not be read")
			return true
		}
		writeJSON(w, http.StatusOK, entries)
		return true
	case "DELETE /api/debug/usage-logs":
		if a.debugLog != nil {
			if err := a.debugLog.Clear(); err != nil {
				writeError(w, http.StatusInternalServerError, "usage diagnostics could not be cleared")
				return true
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return true
	case "GET /api/usage":
		window := usage.ParseRange(r.URL.Query().Get("range"))
		surface := usage.ParseSurface(r.URL.Query().Get("surface"))
		if a.usageLog == nil {
			writeJSON(w, http.StatusOK, usage.Summarize(nil, window, time.Now(), surface))
			return true
		}
		entries, err := a.usageLog.ReadAll()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "usage log could not be read")
			return true
		}
		writeJSON(w, http.StatusOK, usage.Summarize(entries, window, time.Now(), surface))
		return true
	case "DELETE /api/usage":
		if a.usageLog != nil {
			if err := a.usageLog.Clear(); err != nil {
				writeError(w, http.StatusInternalServerError, "usage log could not be cleared")
				return true
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return true
	case "GET /api/storage":
		home := a.storageHome
		if home == "" {
			writeError(w, http.StatusNotImplemented, "Codex storage home is not configured")
			return true
		}
		report, err := storage.Scan(home)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "storage scan failed")
			return true
		}
		writeJSON(w, http.StatusOK, report)
		return true
	}
	return false
}

func matchesStatus(status int, filter string) bool {
	filter = strings.ToLower(filter)
	if len(filter) == 3 && filter[1:] == "xx" {
		want := int(filter[0] - '0')
		return status/100 == want
	}
	return strconv.Itoa(status) == filter
}
func httpErrorCode(status int) string {
	switch {
	case status >= 200 && status < 400:
		return ""
	case status == 400 || status == 409:
		return "invalid_request_error"
	case status == 401:
		return "invalid_api_key"
	case status == 403:
		return "permission_denied"
	case status == 429:
		return "rate_limit_exceeded"
	case status == 499:
		return "client_closed_request"
	case status == 503:
		return "server_is_overloaded"
	case status >= 500:
		return "upstream_server_error"
	default:
		return fmt.Sprintf("http_%d", status)
	}
}

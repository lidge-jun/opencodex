package usage

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type Status string

const (
	StatusReported    Status = "reported"
	StatusUnreported  Status = "unreported"
	StatusUnsupported Status = "unsupported"
	StatusEstimated   Status = "estimated"
)

type Surface string

const (
	SurfaceCodex  Surface = "codex"
	SurfaceClaude Surface = "claude"
)

type Attempt struct {
	Ordinal     int          `json:"ordinal"`
	Provider    string       `json:"provider"`
	Model       string       `json:"model"`
	Adapter     string       `json:"adapter,omitempty"`
	HTTPStatus  int          `json:"status"`
	DurationMS  int64        `json:"durationMs"`
	FirstOutput *int64       `json:"firstOutputMs,omitempty"`
	SendCount   int          `json:"sendCount,omitempty"`
	Recovery    []string     `json:"recoveryKinds,omitempty"`
	UsageStatus Status       `json:"usageStatus"`
	Usage       *types.Usage `json:"usage,omitempty"`
	TotalTokens *int         `json:"totalTokens,omitempty"`
	ErrorCode   string       `json:"errorCode,omitempty"`
}

type Entry struct {
	RequestID      string       `json:"requestId"`
	Timestamp      int64        `json:"timestamp"`
	ThreadID       string       `json:"threadId,omitempty"`
	Provider       string       `json:"provider"`
	Model          string       `json:"model"`
	Surface        Surface      `json:"surface,omitempty"`
	ResolvedModel  string       `json:"resolvedModel,omitempty"`
	RequestedModel string       `json:"requestedModel,omitempty"`
	Status         int          `json:"status"`
	DurationMS     int64        `json:"durationMs"`
	FirstOutputMS  *int64       `json:"firstOutputMs,omitempty"`
	UsageStatus    Status       `json:"usageStatus"`
	Usage          *types.Usage `json:"usage,omitempty"`
	TotalTokens    *int         `json:"totalTokens,omitempty"`
	Attempts       []Attempt    `json:"attempts,omitempty"`
	ErrorCode      string       `json:"errorCode,omitempty"`
	TerminalStatus string       `json:"terminalStatus,omitempty"`
	CloseReason    string       `json:"closeReason,omitempty"`
	UpstreamError  string       `json:"upstreamError,omitempty"`
}

// Log is an append-only JSONL usage recorder. Its mutex makes append/read/clear
// safe within one process; O_APPEND keeps individual records atomic at the OS boundary.
type Log struct {
	path string
	mu   sync.RWMutex
}

func NewLog(path string) *Log { return &Log{path: path} }

func (l *Log) Path() string { return l.path }

func (l *Log) Record(ctx context.Context, record *types.UsageRecord) error {
	if record == nil {
		return errors.New("usage record is required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	status := StatusReported
	if record.Usage.Estimated {
		status = StatusEstimated
	}
	total := CanonicalTotal(record.Usage)
	entry := Entry{
		RequestID:   record.RequestID,
		Timestamp:   record.StartedAt.UnixMilli(),
		ThreadID:    record.ThreadID,
		Provider:    record.Provider,
		Model:       record.Model,
		Status:      outcomeHTTPStatus(record.Status),
		DurationMS:  record.Duration.Milliseconds(),
		UsageStatus: status,
		Usage:       cloneUsage(&record.Usage),
		TotalTokens: &total,
	}
	return l.Append(entry)
}

func (l *Log) Append(entry Entry) error {
	if err := validateEntry(entry); err != nil {
		return err
	}
	data, err := json.Marshal(normalizeEntry(entry))
	if err != nil {
		return fmt.Errorf("encode usage entry: %w", err)
	}
	data = append(data, '\n')

	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return fmt.Errorf("create usage directory: %w", err)
	}
	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open usage log: %w", err)
	}
	defer file.Close()
	if err := file.Chmod(0o600); err != nil && !errors.Is(err, os.ErrPermission) {
		return fmt.Errorf("protect usage log: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("append usage log: %w", err)
	}
	return nil
}

func (l *Log) ReadAll() ([]Entry, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	file, err := os.Open(l.path)
	if errors.Is(err, os.ErrNotExist) {
		return []Entry{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open usage log: %w", err)
	}
	defer file.Close()
	return readEntries(file)
}

func (l *Log) ReadRecent(limit int) ([]Entry, error) {
	if limit <= 0 {
		return []Entry{}, nil
	}
	entries, err := l.ReadAll()
	if err != nil || len(entries) <= limit {
		return entries, err
	}
	return append([]Entry(nil), entries[len(entries)-limit:]...), nil
}

func (l *Log) Clear() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.Remove(l.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("clear usage log: %w", err)
	}
	return nil
}

func readEntries(reader io.Reader) ([]Entry, error) {
	scanner := bufio.NewScanner(reader)
	buffer := make([]byte, 64*1024)
	scanner.Buffer(buffer, 4*1024*1024)
	entries := make([]Entry, 0)
	for scanner.Scan() {
		var entry Entry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil || validateEntry(entry) != nil {
			continue // tolerate partial or hand-edited lines
		}
		entries = append(entries, normalizeEntry(entry))
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read usage log: %w", err)
	}
	return entries, nil
}

func validateEntry(entry Entry) error {
	if entry.RequestID == "" || entry.Provider == "" || entry.Model == "" {
		return errors.New("requestId, provider, and model are required")
	}
	if entry.Timestamp < 0 || entry.DurationMS < 0 {
		return errors.New("timestamp and duration must be non-negative")
	}
	if !validStatus(entry.UsageStatus) {
		return errors.New("invalid usage status")
	}
	if entry.Usage != nil && !validUsage(*entry.Usage) {
		return errors.New("usage tokens must be non-negative")
	}
	return nil
}

func validStatus(status Status) bool {
	return status == StatusReported || status == StatusUnreported || status == StatusUnsupported || status == StatusEstimated
}

func validUsage(value types.Usage) bool {
	return value.InputTokens >= 0 && value.OutputTokens >= 0 && value.TotalTokens >= 0 &&
		value.CachedInputTokens >= 0 && value.CacheReadInputTokens >= 0 &&
		value.CacheCreationInputTokens >= 0 && value.ReasoningOutputTokens >= 0
}

func normalizeEntry(entry Entry) Entry {
	entry.UpstreamError = capString(entry.UpstreamError, 500)
	entry.ErrorCode = capString(entry.ErrorCode, 64)
	entry.TerminalStatus = capString(entry.TerminalStatus, 64)
	entry.CloseReason = capString(entry.CloseReason, 64)
	if entry.Usage != nil {
		entry.Usage = cloneUsage(entry.Usage)
	}
	entry.Attempts = append([]Attempt(nil), entry.Attempts...)
	return entry
}

func cloneUsage(value *types.Usage) *types.Usage {
	if value == nil {
		return nil
	}
	clone := *value
	return &clone
}

func capString(value string, max int) string {
	if len(value) > max {
		return value[:max]
	}
	return value
}

func outcomeHTTPStatus(status types.OutcomeStatus) int {
	switch status {
	case types.OutcomeSuccess:
		return 200
	case types.OutcomeAuthError:
		return 401
	case types.OutcomeRateLimited:
		return 429
	case types.OutcomeCancelled:
		return 499
	default:
		return 502
	}
}

var _ types.UsageRecorder = (*Log)(nil)

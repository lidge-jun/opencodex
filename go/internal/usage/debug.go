package usage

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	DebugSampleBytes = 2048
	DebugMaxLines    = 200
	DebugKeepLines   = 100
)

type DebugRecord struct {
	Timestamp           int64        `json:"ts"`
	RequestID           string       `json:"requestId"`
	Provider            string       `json:"provider"`
	Model               string       `json:"model"`
	UpstreamContentType string       `json:"upstreamContentType,omitempty"`
	UpstreamStatus      int          `json:"upstreamStatus"`
	BodyKind            string       `json:"bodyKind"`
	BodySample          string       `json:"bodySample"`
	ExtractedUsage      *types.Usage `json:"extractedUsage,omitempty"`
}
type DebugEntry struct {
	Seq  int    `json:"seq"`
	At   int64  `json:"at"`
	Line string `json:"line"`
}
type DebugLog struct {
	path string
	mu   sync.Mutex
}

func NewDebugLog(path string) *DebugLog { return &DebugLog{path: path} }
func (d *DebugLog) Path() string        { return d.path }

func RedactDebugSample(value string, maxBytes int) string {
	if maxBytes <= 0 {
		maxBytes = DebugSampleBytes
	}
	value = config.RedactString(value)
	if len(value) <= maxBytes {
		return value
	}
	return fmt.Sprintf("%s... [+%d more]", value[:maxBytes], len(value)-maxBytes)
}

func (d *DebugLog) Append(record DebugRecord) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	record.BodySample = RedactDebugSample(record.BodySample, DebugSampleBytes)
	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode usage diagnostic: %w", err)
	}
	if err = os.MkdirAll(filepath.Dir(d.path), 0o700); err != nil {
		return fmt.Errorf("create usage diagnostic directory: %w", err)
	}
	file, err := os.OpenFile(d.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open usage diagnostic: %w", err)
	}
	if _, err = file.Write(append(data, '\n')); err != nil {
		file.Close()
		return fmt.Errorf("append usage diagnostic: %w", err)
	}
	if err = file.Close(); err != nil {
		return fmt.Errorf("close usage diagnostic: %w", err)
	}
	return d.trim()
}

func (d *DebugLog) Entries(after, limit int) ([]DebugEntry, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	file, err := os.Open(d.path)
	if errors.Is(err, os.ErrNotExist) {
		return []DebugEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	out := []DebugEntry{}
	scanner := bufio.NewScanner(file)
	seq := 0
	for scanner.Scan() {
		seq++
		if seq <= after {
			continue
		}
		line := scanner.Text()
		var record DebugRecord
		_ = json.Unmarshal([]byte(line), &record)
		out = append(out, DebugEntry{Seq: seq, At: record.Timestamp, Line: line})
	}
	if err = scanner.Err(); err != nil {
		return nil, err
	}
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out, nil
}

func (d *DebugLog) Clear() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := os.Remove(d.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (d *DebugLog) trim() error {
	data, err := os.ReadFile(d.path)
	if err != nil {
		return err
	}
	lines := splitNonEmptyLines(string(data))
	if len(lines) <= DebugMaxLines {
		return nil
	}
	kept := lines[len(lines)-DebugKeepLines:]
	return os.WriteFile(d.path, []byte(joinLines(kept)+"\n"), 0o600)
}

func splitNonEmptyLines(value string) []string {
	scanner := bufio.NewScanner(strings.NewReader(value))
	out := []string{}
	for scanner.Scan() {
		if scanner.Text() != "" {
			out = append(out, scanner.Text())
		}
	}
	return out
}
func joinLines(values []string) string {
	result := ""
	for i, value := range values {
		if i > 0 {
			result += "\n"
		}
		result += value
	}
	return result
}

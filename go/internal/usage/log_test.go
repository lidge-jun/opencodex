package usage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestLogJSONLRoundTrip(t *testing.T) {
	log := NewLog(filepath.Join(t.TempDir(), "usage.jsonl"))
	record := &types.UsageRecord{
		RequestID: "req-1", ThreadID: "thread-1", Provider: "deepseek", Model: "deepseek-chat",
		Usage:  types.Usage{InputTokens: 120, OutputTokens: 30, CacheReadInputTokens: 20},
		Status: types.OutcomeSuccess, StartedAt: time.UnixMilli(1_700_000_000_000), Duration: 1250 * time.Millisecond,
	}
	if err := log.Record(context.Background(), record); err != nil {
		t.Fatalf("Record() error = %v", err)
	}
	if err := log.Append(Entry{RequestID: "req-2", Timestamp: 1_700_000_001_000, Provider: "cursor", Model: "auto", Status: 200, DurationMS: 20, UsageStatus: StatusUnreported}); err != nil {
		t.Fatalf("Append() error = %v", err)
	}

	entries, err := log.ReadAll()
	if err != nil {
		t.Fatalf("ReadAll() error = %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("len(entries) = %d, want 2", len(entries))
	}
	if entries[0].RequestID != "req-1" || entries[0].DurationMS != 1250 {
		t.Fatalf("first entry = %#v", entries[0])
	}
	if entries[0].TotalTokens == nil || *entries[0].TotalTokens != 150 {
		t.Fatalf("total = %v, want 150", entries[0].TotalTokens)
	}

	recent, err := log.ReadRecent(1)
	if err != nil || len(recent) != 1 || recent[0].RequestID != "req-2" {
		t.Fatalf("ReadRecent() = %#v, %v", recent, err)
	}
}

func TestLogSkipsMalformedJSONLRows(t *testing.T) {
	log := NewLog(filepath.Join(t.TempDir(), "usage.jsonl"))
	if err := log.Append(Entry{RequestID: "valid", Timestamp: 1, Provider: "p", Model: "m", Status: 200, UsageStatus: StatusReported, Usage: &types.Usage{InputTokens: 1}}); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(log.Path(), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.WriteString("{partial\n")
	_ = file.Close()
	entries, err := log.ReadAll()
	if err != nil || len(entries) != 1 {
		t.Fatalf("ReadAll() = %#v, %v", entries, err)
	}
}

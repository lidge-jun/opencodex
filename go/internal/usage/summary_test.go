package usage

import (
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestSummaryAggregatesByProviderModelDateAndSurface(t *testing.T) {
	now := time.Date(2026, 7, 24, 12, 0, 0, 0, time.Local)
	entries := []Entry{
		{RequestID: "codex", Timestamp: now.Add(-time.Hour).UnixMilli(), Provider: "deepseek", Model: "deepseek-chat", Status: 200, DurationMS: 100, UsageStatus: StatusReported, Usage: &types.Usage{InputTokens: 100, OutputTokens: 20, CacheReadInputTokens: 40}},
		{RequestID: "claude", Timestamp: now.Add(-2 * time.Hour).UnixMilli(), Provider: "deepseek", Model: "deepseek-chat", Surface: SurfaceClaude, Status: 200, DurationMS: 100, UsageStatus: StatusEstimated, Usage: &types.Usage{InputTokens: 50, OutputTokens: 10, Estimated: true}},
		{RequestID: "missing", Timestamp: now.Add(-24 * time.Hour).UnixMilli(), Provider: "other", Model: "unknown", Status: 502, DurationMS: 100, UsageStatus: StatusUnreported},
	}

	summary := Summarize(entries, Range7D, now, "all")
	if summary.Summary.Requests != 3 || summary.Summary.MeasuredRequests != 2 || summary.Summary.TotalTokens != 180 {
		t.Fatalf("totals = %#v", summary.Summary)
	}
	if len(summary.Days) != 7 {
		t.Fatalf("len(days) = %d, want 7", len(summary.Days))
	}
	if len(summary.Models) != 2 || summary.Models[0].Requests != 2 {
		t.Fatalf("models = %#v", summary.Models)
	}
	if len(summary.Providers) != 2 || summary.Providers[0].Provider != "deepseek" {
		t.Fatalf("providers = %#v", summary.Providers)
	}
	claude := Summarize(entries, Range7D, now, "claude")
	if claude.Summary.Requests != 1 || claude.Summary.EstimatedRequests != 1 {
		t.Fatalf("claude totals = %#v", claude.Summary)
	}
}

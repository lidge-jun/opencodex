package usage

import (
	"math"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestCostCalculationDoesNotDoubleChargeCache(t *testing.T) {
	overlays := []PriceOverlay{{Provider: "acme", Model: "model", Price: Price{Input: 2, Output: 10, CacheRead: .2, CacheWrite: 4}, Status: PriceVerified}}
	value := types.Usage{InputTokens: 1_000_000, OutputTokens: 100_000, CacheReadInputTokens: 200_000, CacheCreationInputTokens: 100_000}
	estimate, ok := EstimateCost("acme", "model", value, StatusReported, overlays)
	if !ok {
		t.Fatal("EstimateCost() did not match exact overlay")
	}
	if estimate.Tokens.Input != 700_000 || estimate.Tokens.CacheRead != 200_000 || estimate.Tokens.CacheWrite != 100_000 {
		t.Fatalf("tokens = %#v", estimate.Tokens)
	}
	if math.Abs(estimate.Cost.Total-2.84) > 1e-9 {
		t.Fatalf("total cost = %.12f, want 2.84", estimate.Cost.Total)
	}
	if got := CanonicalTotal(value); got != 1_100_000 {
		t.Fatalf("CanonicalTotal() = %d, want 1100000", got)
	}
}

func TestCostRejectsContradictoryCacheBreakdown(t *testing.T) {
	_, ok := NormalizeCostTokens(types.Usage{InputTokens: 10, OutputTokens: 1, CacheReadInputTokens: 9, CacheCreationInputTokens: 2})
	if ok {
		t.Fatal("NormalizeCostTokens() accepted cache read + write greater than input")
	}
}

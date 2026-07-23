package usage

import (
	"math"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type CostTokens struct{ Input, Output, CacheRead, CacheWrite int }
type CostBreakdown struct{ Input, Output, CacheRead, CacheWrite, Total float64 }
type CostEstimate struct {
	Tokens    CostTokens    `json:"tokens"`
	Cost      CostBreakdown `json:"cost"`
	Price     PriceOverlay  `json:"price"`
	Estimated bool          `json:"estimated"`
}

func NormalizeCostTokens(value types.Usage) (CostTokens, bool) {
	if !validUsage(value) {
		return CostTokens{}, false
	}
	write := value.CacheCreationInputTokens
	read := value.CacheReadInputTokens
	if read == 0 {
		read = value.CachedInputTokens
	}
	candidates := []int{read}
	if value.CacheReadInputTokens == 0 && value.CachedInputTokens > 0 && write > 0 {
		candidates = append(candidates, max(0, value.CachedInputTokens-write))
	}
	for _, candidate := range candidates {
		if candidate+write > value.InputTokens {
			continue
		}
		return CostTokens{Input: value.InputTokens - candidate - write, Output: value.OutputTokens, CacheRead: candidate, CacheWrite: write}, true
	}
	return CostTokens{}, false
}

func CalculateCost(tokens CostTokens, price Price) CostBreakdown {
	result := CostBreakdown{
		Input:      float64(tokens.Input) * price.Input / 1_000_000,
		Output:     float64(tokens.Output) * price.Output / 1_000_000,
		CacheRead:  float64(tokens.CacheRead) * price.CacheRead / 1_000_000,
		CacheWrite: float64(tokens.CacheWrite) * price.CacheWrite / 1_000_000,
	}
	result.Total = result.Input + result.Output + result.CacheRead + result.CacheWrite
	return result
}

func EstimateCost(provider, model string, value types.Usage, status Status, overlays []PriceOverlay) (CostEstimate, bool) {
	tokens, ok := NormalizeCostTokens(value)
	if !ok {
		return CostEstimate{}, false
	}
	if overlays == nil {
		overlays = ExpectedPriceOverlays
	}
	price, ok := FindPrice(provider, model, overlays)
	if !ok {
		return CostEstimate{}, false
	}
	return CostEstimate{Tokens: tokens, Cost: CalculateCost(tokens, price.Price), Price: price,
		Estimated: value.Estimated || status == StatusEstimated || price.Status == PriceVerifiedDerived}, true
}

func TokensPerSecond(outputTokens int, durationMS int64) (float64, bool) {
	if outputTokens <= 0 || durationMS <= 0 {
		return 0, false
	}
	value := float64(outputTokens) / (float64(durationMS) / 1000)
	return value, !math.IsInf(value, 0) && !math.IsNaN(value)
}

func BaseProvider(provider string) string {
	// Account pool suffixes are diagnostic identity, not a pricing namespace.
	for _, prefix := range []string{"google-antigravity", "openai", "cursor", "kimi"} {
		if provider == prefix || strings.HasPrefix(provider, prefix+"-p") {
			return prefix
		}
	}
	return provider
}

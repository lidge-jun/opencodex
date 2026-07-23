package usage

type Price struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

type PriceStatus string

const (
	PriceVerified        PriceStatus = "verified"
	PriceVerifiedDerived PriceStatus = "verified-derived"
)

type PriceOverlay struct {
	Provider   string      `json:"provider"`
	Model      string      `json:"modelId"`
	Price      Price       `json:"cost4"`
	Source     string      `json:"source,omitempty"`
	VerifiedAt string      `json:"verifiedAt,omitempty"`
	Status     PriceStatus `json:"status"`
}

var ExpectedPriceOverlays = []PriceOverlay{
	{Provider: "deepseek", Model: "deepseek-chat", Price: Price{Input: .27, Output: 1.10, CacheRead: .07}, Status: PriceVerified},
	{Provider: "deepseek", Model: "deepseek-reasoner", Price: Price{Input: .55, Output: 2.19, CacheRead: .14}, Status: PriceVerified},
	{Provider: "google", Model: "gemini-3.6-flash", Price: Price{Input: 1.5, Output: 7.5, CacheRead: .15}, Status: PriceVerified},
	{Provider: "google-antigravity", Model: "gemini-3.6-flash", Price: Price{Input: 1.5, Output: 7.5, CacheRead: .15}, Status: PriceVerified},
	{Provider: "google-antigravity", Model: "gemini-3.1-pro", Price: Price{Input: 2, Output: 12, CacheRead: .2}, Status: PriceVerified},
	{Provider: "google-antigravity", Model: "claude-sonnet-4-6", Price: Price{Input: 3, Output: 15, CacheRead: .3, CacheWrite: 3.75}, Status: PriceVerified},
	{Provider: "google-antigravity", Model: "claude-opus-4-6-thinking", Price: Price{Input: 5, Output: 25, CacheRead: .5, CacheWrite: 6.25}, Status: PriceVerified},
	{Provider: "kimi", Model: "k3", Price: Price{Input: 3, Output: 15, CacheRead: .3, CacheWrite: 3}, Status: PriceVerifiedDerived},
	{Provider: "kimi", Model: "kimi-k2.7-code", Price: Price{Input: .95, Output: 4, CacheRead: .19, CacheWrite: .95}, Status: PriceVerifiedDerived},
	{Provider: "alibaba-token-plan", Model: "qwen3.8-max-preview", Price: Price{Input: 1.5, Output: 5, CacheRead: .15}, Status: PriceVerifiedDerived},
	{Provider: "alibaba-token-plan-intl", Model: "qwen3.8-max-preview", Price: Price{Input: 1.5, Output: 5, CacheRead: .15}, Status: PriceVerifiedDerived},
	{Provider: "cursor", Model: "auto", Price: Price{Input: 1.25, Output: 6, CacheRead: .25, CacheWrite: 1.25}, Status: PriceVerified},
}

func FindPrice(provider, model string, overlays []PriceOverlay) (PriceOverlay, bool) {
	provider = BaseProvider(provider)
	var derived *PriceOverlay
	for i := range overlays {
		row := overlays[i]
		if row.Provider != provider || row.Model != model {
			continue
		}
		if row.Status == PriceVerified {
			return row, true
		}
		if row.Status == PriceVerifiedDerived && derived == nil {
			derived = &row
		}
	}
	if derived != nil {
		return *derived, true
	}
	return PriceOverlay{}, false
}

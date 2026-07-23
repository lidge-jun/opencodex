package usage

import "github.com/lidge-jun/opencodex-go/internal/types"

// CanonicalTotal treats input tokens as inclusive of cache reads/writes.
func CanonicalTotal(value types.Usage) int {
	base := value.InputTokens + value.OutputTokens
	if value.TotalTokens > base {
		return value.TotalTokens
	}
	return base
}

func DisplayTotal(value *types.Usage, stored *int) (int, bool) {
	if value == nil {
		if stored == nil {
			return 0, false
		}
		return *stored, true
	}
	total := CanonicalTotal(*value)
	if stored != nil && *stored > total {
		total = *stored
	}
	return total, true
}

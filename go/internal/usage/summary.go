package usage

import (
	"sort"
	"time"
)

type Range string

const (
	Range7D  Range = "7d"
	Range30D Range = "30d"
	RangeAll Range = "all"
)

type SummaryTotals struct {
	Requests                 int     `json:"requests"`
	AttemptCount             int     `json:"attemptCount"`
	MeasuredRequests         int     `json:"measuredRequests"`
	ReportedRequests         int     `json:"reportedRequests"`
	UnreportedRequests       int     `json:"unreportedRequests"`
	UnsupportedRequests      int     `json:"unsupportedRequests"`
	EstimatedRequests        int     `json:"estimatedRequests"`
	InputTokens              int     `json:"inputTokens"`
	OutputTokens             int     `json:"outputTokens"`
	CachedInputTokens        int     `json:"cachedInputTokens"`
	CacheReadInputTokens     int     `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int     `json:"cacheCreationInputTokens"`
	ReasoningOutputTokens    int     `json:"reasoningOutputTokens"`
	TotalTokens              int     `json:"totalTokens"`
	CoverageRatio            float64 `json:"coverageRatio"`
	EstimatedCostUSD         float64 `json:"estimatedCostUsd"`
	PricedRequests           int     `json:"pricedRequests"`
	UnpricedRequests         int     `json:"unpricedRequests"`
	UnmeteredRequests        int     `json:"unmeteredRequests"`
}

type DayModel struct {
	Model        string `json:"model"`
	Provider     string `json:"provider"`
	Requests     int    `json:"requests"`
	AttemptCount int    `json:"attemptCount"`
	TotalTokens  int    `json:"totalTokens"`
}
type Day struct {
	Date             string     `json:"date"`
	Requests         int        `json:"requests"`
	MeasuredRequests int        `json:"measuredRequests"`
	ReportedRequests int        `json:"reportedRequests"`
	TotalTokens      int        `json:"totalTokens"`
	Models           []DayModel `json:"models"`
}
type ModelSummary struct {
	Provider          string  `json:"provider"`
	Model             string  `json:"model"`
	Requests          int     `json:"requests"`
	AttemptCount      int     `json:"attemptCount"`
	MeasuredRequests  int     `json:"measuredRequests"`
	ReportedRequests  int     `json:"reportedRequests"`
	EstimatedRequests int     `json:"estimatedRequests"`
	InputTokens       int     `json:"inputTokens"`
	OutputTokens      int     `json:"outputTokens"`
	TotalTokens       int     `json:"totalTokens"`
	ShareRatio        float64 `json:"shareRatio"`
	EstimatedCostUSD  float64 `json:"estimatedCostUsd,omitempty"`
}
type ProviderSummary struct {
	Provider          string  `json:"provider"`
	Requests          int     `json:"requests"`
	AttemptCount      int     `json:"attemptCount"`
	MeasuredRequests  int     `json:"measuredRequests"`
	ReportedRequests  int     `json:"reportedRequests"`
	EstimatedRequests int     `json:"estimatedRequests"`
	TotalTokens       int     `json:"totalTokens"`
	ShareRatio        float64 `json:"shareRatio"`
	EstimatedCostUSD  float64 `json:"estimatedCostUsd,omitempty"`
}
type Summary struct {
	Range       Range             `json:"range"`
	Surface     string            `json:"surface"`
	Since       *int64            `json:"since"`
	GeneratedAt int64             `json:"generatedAt"`
	Summary     SummaryTotals     `json:"summary"`
	Days        []Day             `json:"days"`
	Models      []ModelSummary    `json:"models"`
	Providers   []ProviderSummary `json:"providers"`
}

func ParseRange(value string) Range {
	if value == string(Range7D) {
		return Range7D
	}
	if value == string(RangeAll) {
		return RangeAll
	}
	return Range30D
}
func ParseSurface(value string) string {
	if value == "codex" || value == "claude" {
		return value
	}
	return "all"
}

func Summarize(entries []Entry, window Range, now time.Time, surface string) Summary {
	surface = ParseSurface(surface)
	filtered, since := filterEntries(entries, window, now, surface)
	totals := SummaryTotals{}
	for _, entry := range filtered {
		bumpStatus(&totals, entry.UsageStatus)
		if len(entry.Attempts) > 0 {
			totals.AttemptCount += len(entry.Attempts)
		} else {
			totals.AttemptCount++
		}
		addTokens(&totals, entry)
		addCost(&totals, entry)
	}
	if totals.Requests > 0 {
		totals.CoverageRatio = float64(totals.MeasuredRequests) / float64(totals.Requests)
	}
	return Summary{Range: window, Surface: surface, Since: since, GeneratedAt: now.UnixMilli(), Summary: totals,
		Days: buildDays(filtered, window, now), Models: buildModels(filtered, totals.TotalTokens), Providers: buildProviders(filtered, totals.TotalTokens)}
}

func filterEntries(entries []Entry, window Range, now time.Time, surface string) ([]Entry, *int64) {
	var since *int64
	if window != RangeAll {
		days := 30
		if window == Range7D {
			days = 7
		}
		value := now.Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
		since = &value
	}
	out := make([]Entry, 0, len(entries))
	for _, entry := range entries {
		if since != nil && entry.Timestamp < *since {
			continue
		}
		if surface == "claude" && entry.Surface != SurfaceClaude {
			continue
		}
		if surface == "codex" && entry.Surface == SurfaceClaude {
			continue
		}
		out = append(out, entry)
	}
	return out, since
}

func bumpStatus(total *SummaryTotals, status Status) {
	total.Requests++
	if status == StatusReported || status == StatusEstimated {
		total.MeasuredRequests++
	}
	switch status {
	case StatusReported:
		total.ReportedRequests++
	case StatusEstimated:
		total.EstimatedRequests++
	case StatusUnsupported:
		total.UnsupportedRequests++
	default:
		total.UnreportedRequests++
	}
}

func addTokens(total *SummaryTotals, entry Entry) {
	if entry.Usage == nil {
		return
	}
	u := entry.Usage
	total.InputTokens += u.InputTokens
	total.OutputTokens += u.OutputTokens
	read := u.CacheReadInputTokens
	if read == 0 && u.CachedInputTokens > 0 {
		read = u.CachedInputTokens
		if u.CacheCreationInputTokens > 0 {
			read = max(0, read-u.CacheCreationInputTokens)
		}
	}
	total.CachedInputTokens += read
	total.CacheReadInputTokens += read
	total.CacheCreationInputTokens += u.CacheCreationInputTokens
	total.ReasoningOutputTokens += u.ReasoningOutputTokens
	value, _ := DisplayTotal(u, entry.TotalTokens)
	total.TotalTokens += value
}

func addCost(total *SummaryTotals, entry Entry) {
	if entry.Usage == nil || entry.UsageStatus == StatusUnreported || entry.UsageStatus == StatusUnsupported {
		total.UnmeteredRequests++
		return
	}
	estimate, ok := EstimateCost(entry.Provider, entry.Model, *entry.Usage, entry.UsageStatus, nil)
	if !ok {
		total.UnpricedRequests++
		return
	}
	total.PricedRequests++
	total.EstimatedCostUSD += estimate.Cost.Total
}

func buildDays(entries []Entry, window Range, now time.Time) []Day {
	days := 0
	if window == Range7D {
		days = 7
	} else if window == Range30D {
		days = 30
	} else {
		days = allDayCount(entries, now)
	}
	grid := make(map[string]*Day, days)
	for i := days - 1; i >= 0; i-- {
		key := now.AddDate(0, 0, -i).Format("2006-01-02")
		grid[key] = &Day{Date: key, Models: []DayModel{}}
	}
	modelMaps := make(map[string]map[string]*DayModel)
	for _, entry := range entries {
		key := time.UnixMilli(entry.Timestamp).In(now.Location()).Format("2006-01-02")
		day := grid[key]
		if day == nil {
			day = &Day{Date: key, Models: []DayModel{}}
			grid[key] = day
		}
		day.Requests++
		if measured(entry.UsageStatus) {
			day.MeasuredRequests++
		}
		if entry.UsageStatus == StatusReported {
			day.ReportedRequests++
		}
		value, _ := DisplayTotal(entry.Usage, entry.TotalTokens)
		day.TotalTokens += value
		if modelMaps[key] == nil {
			modelMaps[key] = map[string]*DayModel{}
		}
		mkey := BaseProvider(entry.Provider) + "/" + entry.Model
		dm := modelMaps[key][mkey]
		if dm == nil {
			dm = &DayModel{Model: entry.Model, Provider: BaseProvider(entry.Provider)}
			modelMaps[key][mkey] = dm
		}
		dm.Requests++
		if len(entry.Attempts) > 0 {
			dm.AttemptCount += len(entry.Attempts)
		} else {
			dm.AttemptCount++
		}
		dm.TotalTokens += value
	}
	out := make([]Day, 0, len(grid))
	for key, day := range grid {
		for _, model := range modelMaps[key] {
			day.Models = append(day.Models, *model)
		}
		sort.Slice(day.Models, func(i, j int) bool { return day.Models[i].Requests > day.Models[j].Requests })
		out = append(out, *day)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date < out[j].Date })
	return out
}

func allDayCount(entries []Entry, now time.Time) int {
	if len(entries) == 0 {
		return 1
	}
	oldest := entries[0].Timestamp
	for _, entry := range entries[1:] {
		if entry.Timestamp < oldest {
			oldest = entry.Timestamp
		}
	}
	n := int(now.Sub(time.UnixMilli(oldest)).Hours()/24) + 1
	return max(1, n)
}

func buildModels(entries []Entry, grand int) []ModelSummary {
	rows := map[string]*ModelSummary{}
	for _, entry := range entries {
		key := BaseProvider(entry.Provider) + "/" + entry.Model
		row := rows[key]
		if row == nil {
			row = &ModelSummary{Provider: BaseProvider(entry.Provider), Model: entry.Model}
			rows[key] = row
		}
		row.Requests++
		if len(entry.Attempts) > 0 {
			row.AttemptCount += len(entry.Attempts)
		} else {
			row.AttemptCount++
		}
		if measured(entry.UsageStatus) {
			row.MeasuredRequests++
		}
		if entry.UsageStatus == StatusReported {
			row.ReportedRequests++
		}
		if entry.UsageStatus == StatusEstimated {
			row.EstimatedRequests++
		}
		if entry.Usage != nil {
			row.InputTokens += entry.Usage.InputTokens
			row.OutputTokens += entry.Usage.OutputTokens
			value, _ := DisplayTotal(entry.Usage, entry.TotalTokens)
			row.TotalTokens += value
			if est, ok := EstimateCost(entry.Provider, entry.Model, *entry.Usage, entry.UsageStatus, nil); ok {
				row.EstimatedCostUSD += est.Cost.Total
			}
		}
	}
	out := make([]ModelSummary, 0, len(rows))
	for _, row := range rows {
		if grand > 0 {
			row.ShareRatio = float64(row.TotalTokens) / float64(grand)
		}
		out = append(out, *row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Requests > out[j].Requests })
	return out
}

func buildProviders(entries []Entry, grand int) []ProviderSummary {
	rows := map[string]*ProviderSummary{}
	for _, entry := range entries {
		key := BaseProvider(entry.Provider)
		row := rows[key]
		if row == nil {
			row = &ProviderSummary{Provider: key}
			rows[key] = row
		}
		row.Requests++
		if len(entry.Attempts) > 0 {
			row.AttemptCount += len(entry.Attempts)
		} else {
			row.AttemptCount++
		}
		if measured(entry.UsageStatus) {
			row.MeasuredRequests++
		}
		if entry.UsageStatus == StatusReported {
			row.ReportedRequests++
		}
		if entry.UsageStatus == StatusEstimated {
			row.EstimatedRequests++
		}
		value, _ := DisplayTotal(entry.Usage, entry.TotalTokens)
		row.TotalTokens += value
		if entry.Usage != nil {
			if est, ok := EstimateCost(entry.Provider, entry.Model, *entry.Usage, entry.UsageStatus, nil); ok {
				row.EstimatedCostUSD += est.Cost.Total
			}
		}
	}
	out := make([]ProviderSummary, 0, len(rows))
	for _, row := range rows {
		if grand > 0 {
			row.ShareRatio = float64(row.TotalTokens) / float64(grand)
		}
		out = append(out, *row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Requests > out[j].Requests })
	return out
}

func measured(status Status) bool { return status == StatusReported || status == StatusEstimated }

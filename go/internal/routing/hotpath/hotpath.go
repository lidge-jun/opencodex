package hotpath

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
)

const DefaultKeyCooldownMS int64 = 60000
const MaxKeyCooldownMS int64 = 600000

type Account struct {
	ID               string   `json:"id"`
	Paused           bool     `json:"paused,omitempty"`
	Usable           bool     `json:"usable"`
	UsagePercent     *float64 `json:"usagePercent,omitempty"`
	CooldownUntilMS  int64    `json:"cooldownUntilMs,omitempty"`
	SoftAvoidUntilMS int64    `json:"softAvoidUntilMs,omitempty"`
}
type Key struct {
	ID              string `json:"id"`
	CooldownUntilMS int64  `json:"cooldownUntilMs,omitempty"`
}
type Input struct {
	NowMS               int64     `json:"nowMs"`
	Strategy            string    `json:"strategy,omitempty"`
	ActiveAccountID     string    `json:"activeAccountId,omitempty"`
	AutoSwitchThreshold *float64  `json:"autoSwitchThreshold,omitempty"`
	Accounts            []Account `json:"accounts,omitempty"`
	Keys                []Key     `json:"keys,omitempty"`
	FailedKeyID         string    `json:"failedKeyId,omitempty"`
	Status              int       `json:"status,omitempty"`
	RetryAfter          string    `json:"retryAfter,omitempty"`
}
type Decision struct {
	AccountID       string `json:"accountId,omitempty"`
	CooldownUntilMS int64  `json:"cooldownUntilMs,omitempty"`
	KeyID           string `json:"keyId,omitempty"`
}

func Decide(in Input) Decision {
	d := SelectAccount(in.Accounts, in.ActiveAccountID, in.AutoSwitchThreshold, in.Strategy, in.NowMS)
	if in.FailedKeyID != "" && in.Status == http.StatusTooManyRequests {
		d.KeyID, d.CooldownUntilMS = FailoverKey(in.Keys, in.FailedKeyID, in.RetryAfter, in.NowMS)
	}
	return d
}
func SelectAccount(as []Account, active string, threshold *float64, strategy string, now int64) Decision {
	es := []Account{}
	var earliest int64
	for _, a := range as {
		if a.ID == "" || a.Paused || !a.Usable {
			continue
		}
		if a.CooldownUntilMS > now || a.SoftAvoidUntilMS > now {
			u := a.CooldownUntilMS
			if u <= now || (a.SoftAvoidUntilMS > now && a.SoftAvoidUntilMS < u) {
				u = a.SoftAvoidUntilMS
			}
			if u > now && (earliest == 0 || u < earliest) {
				earliest = u
			}
			continue
		}
		es = append(es, a)
	}
	if len(es) == 0 {
		return Decision{CooldownUntilMS: earliest}
	}
	limit := 80.0
	if threshold != nil {
		limit = *threshold
	}
	if strategy == "round-robin" {
		return Decision{AccountID: es[0].ID}
	}
	if strategy == "fill-first" {
		return Decision{AccountID: fill(es, active, limit).ID}
	}
	for _, a := range es {
		if a.ID == active && (a.UsagePercent == nil || limit <= 0 || *a.UsagePercent < limit) {
			return Decision{AccountID: a.ID}
		}
	}
	best := es[0]
	for _, a := range es[1:] {
		if usage(a) < usage(best) {
			best = a
		}
	}
	return Decision{AccountID: best.ID}
}
func fill(es []Account, active string, limit float64) Account {
	xs := append([]Account(nil), es...)
	sort.SliceStable(xs, func(i, j int) bool { return xs[i].ID < xs[j].ID })
	for _, a := range xs {
		if a.ID == active && (a.UsagePercent == nil || limit <= 0 || *a.UsagePercent < limit) {
			return a
		}
	}
	for _, a := range xs {
		if a.UsagePercent == nil || limit <= 0 || *a.UsagePercent < limit {
			return a
		}
	}
	return xs[0]
}
func usage(a Account) float64 {
	if a.UsagePercent == nil {
		return 101
	}
	if *a.UsagePercent < 0 {
		return 0
	}
	if *a.UsagePercent > 100 {
		return 100
	}
	return *a.UsagePercent
}
func FailoverKey(keys []Key, failed, retry string, now int64) (string, int64) {
	until := now + retryMS(retry, now)
	start := -1
	for i := range keys {
		if keys[i].ID == failed {
			keys[i].CooldownUntilMS = until
			start = i
			break
		}
	}
	for n := 1; n <= len(keys); n++ {
		k := keys[(start+n+len(keys))%len(keys)]
		if k.ID != "" && k.CooldownUntilMS <= now {
			return k.ID, until
		}
	}
	return "", until
}
func retryMS(v string, now int64) int64 {
	s := strings.TrimSpace(v)
	if n, e := strconv.ParseFloat(s, 64); e == nil && n >= 0 {
		d := int64(n*1000 + .999999)
		if d < 1 {
			d = 1
		}
		if d > MaxKeyCooldownMS {
			return MaxKeyCooldownMS
		}
		return d
	}
	if t, e := http.ParseTime(s); e == nil {
		d := t.UnixMilli() - now
		if d < 1 {
			d = 1
		}
		if d > MaxKeyCooldownMS {
			return MaxKeyCooldownMS
		}
		return d
	}
	return DefaultKeyCooldownMS
}

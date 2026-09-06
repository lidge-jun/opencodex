package hotpath

import (
	"net/http"
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
	// Rotation strategies are not claimed by this seam yet: their TS source of
	// truth includes mutable smooth-weight and sticky-success state. Returning
	// no account is deliberate; callers must retain TS ownership until that
	// state is carried in a parent-authorized snapshot.
	if strategy == "round-robin" || strategy == "fill-first" {
		return Decision{}
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
	if numericRetryAfter(s) {
		n, _ := strconv.ParseFloat(s, 64)
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

func numericRetryAfter(value string) bool {
	if value == "" {
		return false
	}
	dot := false
	for index, r := range value {
		if r >= '0' && r <= '9' {
			continue
		}
		if r == '.' && !dot && index > 0 && index < len(value)-1 {
			dot = true
			continue
		}
		return false
	}
	return true
}

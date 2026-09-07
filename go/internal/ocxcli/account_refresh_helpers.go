// Refresh-line and quota-parts renderers shared by the Go-owned `ocx account
// refresh` handler, mirroring refreshLine/quotaParts/providerQuotaLine and the
// passive-provider note in src/cli/account-extended.ts.
package ocxcli

import (
	"fmt"
	"math"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// accountHasPassiveQuota mirrors hasPassiveAccountQuota in src/providers/quota.ts:
// only meta-muse reports quota in-band and has no probe to refresh.
func accountHasPassiveQuota(name string) bool {
	return name == "meta-muse"
}

// codexCatalogRefreshPending mirrors codexCatalogRefreshPending in
// src/cli/account-catalog-refresh.ts (own-property descriptor check, no
// prototype walks).
func codexCatalogRefreshPending(json *jsonwire.Value) bool {
	if json == nil || json.Kind() != jsonwire.Object {
		return false
	}
	field := json.Find("catalogRefreshPending")
	return field != nil && field.Kind() == jsonwire.Bool && field.Bool()
}

const codexCatalogRefreshPendingWarning = "Warning: the account change was saved, but the Codex model catalog refresh is pending. Run 'ocx sync' to retry."

func warnIfCodexCatalogRefreshPending(acc accountDeps, json *jsonwire.Value) {
	if codexCatalogRefreshPending(json) {
		reportAccountStderrLine(acc, codexCatalogRefreshPendingWarning)
	}
}

// isoResetState mirrors resetIso: it reports a reset timestamp string only for
// finite numbers; seconds (<1e10) are promoted to millis.
func accountResetISO(value float64, ok bool) (string, bool) {
	if !ok {
		return "", false
	}
	text := isoReset(value, true)
	if text == "" {
		return "", false
	}
	return text, true
}

// accountQuotaParts mirrors quotaParts in account-extended.ts.
func accountQuotaParts(quota *jsonwire.Value) []string {
	if quota == nil || quota.Kind() != jsonwire.Object {
		return nil
	}
	var parts []string
	add := func(label string, percent float64, ok bool, resetAt float64, hasReset bool) {
		if !ok {
			return
		}
		parts = append(parts, fmt.Sprintf("%s %s%%", label, jsonwire.FormatV8Number(percent)))
		if reset, ok := accountResetISO(resetAt, hasReset); ok {
			parts = append(parts, "resets "+reset)
		}
	}
	percent, ok := accountNumber(quota, "fiveHourPercent")
	resetAt, hasReset := accountNumber(quota, "fiveHourResetAt")
	add("5h", percent, ok, resetAt, hasReset)
	percent, ok = accountNumber(quota, "weeklyPercent")
	resetAt, hasReset = accountNumber(quota, "weeklyResetAt")
	add("weekly", percent, ok, resetAt, hasReset)
	percent, ok = accountNumber(quota, "monthlyPercent")
	resetAt, hasReset = accountNumber(quota, "monthlyResetAt")
	add("monthly", percent, ok, resetAt, hasReset)
	if windows := activeOrEmptyArray(quota, "customWindows"); windows != nil {
		for _, window := range windows {
			label := objectString(window, "label")
			percent, ok = accountNumber(window, "percent")
			resetAt, hasReset = accountNumber(window, "resetAt")
			add(label, percent, ok, resetAt, hasReset)
		}
	}
	return parts
}

// accountProviderQuotaLine mirrors providerQuotaLine.
func accountProviderQuotaLine(name string, report *jsonwire.Value) string {
	parts := []string{name}
	if report != nil && report.Kind() == jsonwire.Object {
		if quota := report.Find("quota"); quota != nil {
			parts = append(parts, accountQuotaParts(quota)...)
		}
	}
	return strings.Join(parts, " ")
}

// accountRefreshLine mirrors refreshLine for a codex row: email/plan are
// dropped when empty, quota parts or the quota: unknown marker, then
// needs-reauth.
func accountRefreshLine(row *accountRow) string {
	var parts []string
	parts = append(parts, displayID(row.id))
	if row.hasEmail && row.email != "" {
		parts = append(parts, row.email)
	}
	if row.hasPlan && row.plan != "" {
		parts = append(parts, row.plan)
	}
	if row.paused {
		parts = append(parts, "paused")
	}
	quotaParts := accountQuotaParts(row.quota)
	if len(quotaParts) == 0 {
		parts = append(parts, "quota: unknown")
	} else {
		parts = append(parts, strings.Join(quotaParts, " "))
	}
	if row.needsReauthSet && row.needsReauth {
		parts = append(parts, "needs-reauth")
	}
	var kept []string
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, " ")
}

// accountQuotaPercent reads fiveHourPercent ?? shortPercent off a quota object.
func accountQuotaPercent(quota *jsonwire.Value) (float64, bool) {
	for _, key := range []string{"fiveHourPercent", "shortPercent"} {
		if number, ok := accountNumber(quota, key); ok {
			return number, true
		}
	}
	return 0, false
}

// accountQuotaText mirrors quotaText in account.ts for the QUOTA table column.
func accountQuotaText(row *accountRow) string {
	if row.quotaUnavailable {
		return "unavailable"
	}
	if !row.hasQuota || row.quota == nil {
		return "-"
	}
	var parts []string
	if percent, ok := accountQuotaPercent(row.quota); ok {
		parts = append(parts, "5h "+jsonwire.FormatV8Number(percent)+"%")
	}
	if percent, ok := accountNumber(row.quota, "weeklyPercent"); ok {
		parts = append(parts, "wk "+jsonwire.FormatV8Number(percent)+"%")
	}
	if percent, ok := accountNumber(row.quota, "monthlyPercent"); ok {
		parts = append(parts, "mo "+jsonwire.FormatV8Number(mathRound(percent))+"%")
	}
	if len(parts) == 0 {
		return "-"
	}
	return strings.Join(parts, " ")
}

func mathRound(value float64) float64 {
	return math.Floor(value + 0.5)
}

// fetchProviderQuotaReport mirrors fetchProviderQuotaReport in account-api.ts:
// a refreshed quota report list is filtered for the requested provider. A
// missing report is not an error (report == nil, status 200).
func fetchProviderQuotaReport(client *http.Client, baseURL, name string) (int, *jsonwire.Value, *jsonwire.Value, string) {
	response := accountHTTP(client, baseURL, "GET", "/api/provider-quotas?refresh=1", nil)
	if response.status == 0 {
		return 0, nil, response.body, response.transportError
	}
	if response.status != 200 {
		return response.status, nil, response.body, ""
	}
	var report *jsonwire.Value
	for _, candidate := range activeOrEmptyArray(response.body, "reports") {
		if objectString(candidate, "provider") == name {
			report = candidate
			break
		}
	}
	return 200, report, nil, ""
}

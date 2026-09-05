/**
 * The freshness bound must distinguish "stale" from "old".
 *
 * A probed provider re-reads on its own TTL, so a report past the bound means the probe
 * is failing and rendering it would present a dead number as live. A PASSIVE provider
 * (`meta-muse`) publishes no endpoint at all — usage arrives only inside a streaming
 * response — so its last observation is the only measurement that exists. Applying the
 * probed rule to it deleted the row, which is the defect these tests pin: Meta usage was
 * visible on the Accounts tab (no age filter there) and nowhere else.
 */
import { expect, test } from "bun:test";
import {
  QUOTA_REPORT_MAX_AGE_MS,
  freshQuotaReport,
  freshQuotaReportRecord,
  freshQuotaReportsFromResponse,
  observedAtFromReport,
} from "../src/provider-workspace/report";

const NOW = 1_788_511_281_008;
/** The age actually measured on the live proxy when the defect was reported. */
const OBSERVED_AT = 1_788_491_894_216;

const museQuota = {
  updatedAt: OBSERVED_AT,
  fiveHourPercent: 1,
  fiveHourResetAt: 1_788_509_678_000,
  weeklyPercent: 1,
  weeklyResetAt: 1_788_739_200_000,
};

function museRow(extra: Record<string, unknown> = {}) {
  return {
    provider: "meta-muse",
    label: "Meta Muse Code (CLI credential)",
    source: "meta-muse:subscription-observation",
    updatedAt: OBSERVED_AT,
    quota: museQuota,
    observed: true,
    ...extra,
  };
}

test("the live 5.4-hour-old Muse observation survives the bound that drops a probed row", () => {
  const age = NOW - OBSERVED_AT;
  expect(age).toBeGreaterThan(QUOTA_REPORT_MAX_AGE_MS);

  expect(freshQuotaReport(museRow(), NOW)).not.toBeNull();
  // Same row, same age, minus the marker: this is what the GUI used to receive.
  expect(freshQuotaReport({ ...museRow(), observed: undefined }, NOW)).toBeNull();
});

test("a probed report past the bound is still dropped", () => {
  const stale = {
    provider: "anthropic",
    source: "anthropic:oauth-usage",
    updatedAt: NOW - QUOTA_REPORT_MAX_AGE_MS - 1,
    quota: { fiveHourPercent: 19 },
  };
  expect(freshQuotaReport(stale, NOW)).toBeNull();
  expect(freshQuotaReport({ ...stale, updatedAt: NOW - 60_000 }, NOW)).not.toBeNull();
});

test("the marker round-trips, because the cache is re-validated through the same predicate", () => {
  const fromResponse = freshQuotaReportsFromResponse([museRow()], NOW);
  expect(fromResponse["meta-muse"]?.observed).toBe(true);

  // What writeSessionListCache/readSessionListCache do to it between page loads.
  const rehydrated = freshQuotaReportRecord(
    JSON.parse(JSON.stringify(fromResponse)) as unknown,
    NOW + 60 * 60_000,
  );
  expect(rehydrated?.["meta-muse"]).toBeDefined();
  expect(rehydrated?.["meta-muse"]?.observed).toBe(true);
});

test("a non-boolean marker is treated as absent rather than rejecting the row", () => {
  // Advisory field: an unknown future value must not make a row vanish.
  const recent = { ...museRow({ observed: "yes" }), updatedAt: NOW - 60_000, quota: { ...museQuota, updatedAt: NOW - 60_000 } };
  const view = freshQuotaReport(recent, NOW);
  expect(view).not.toBeNull();
  expect(view?.observed).toBeUndefined();
  // And it does not buy an exemption.
  expect(freshQuotaReport(museRow({ observed: 1 }), NOW)).toBeNull();
});

test("the observation timestamp is offered only for an observed row", () => {
  expect(observedAtFromReport(freshQuotaReport(museRow(), NOW) ?? undefined)).toBe(OBSERVED_AT);
  expect(observedAtFromReport({ updatedAt: NOW, quota: {} })).toBeUndefined();
  expect(observedAtFromReport(undefined)).toBeUndefined();
});

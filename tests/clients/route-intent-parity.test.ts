import { expect, test } from "bun:test";
import { createLinkChildParityStore, parseLinkChildParityReport, LINK_CHILD_PARITY_MAX_BYTES } from "../../src/link/child-parity";
import { ROUTE_CLIENT_IDS } from "../../src/link/route-intent";
const report = { linkId: "lnk_0123456789abcdef", lastApplyAt: null, runtimeStartedAt: 1794000000000, appliedCodexSettingsDigest: null, sequence: 1 };
test("extended peer schema parses route-only apply, opt-out, and strips local diagnostic content", () => {
  const extended = { ...report, appliedRouteIntentDigest: "a".repeat(64), routeClientOutcomes: [{ client: "aside", outcome: "current", source: "local", target: "/private/client/models.json", message: "secret-token" }] };
  const parsed = parseLinkChildParityReport(extended);
  expect(parsed).not.toBeNull();
  expect(parsed).toMatchObject({ appliedRouteIntentDigest: "a".repeat(64), routeClientOutcomes: [{ client: "aside", outcome: "current", source: "local" }] });
  expect(JSON.stringify(parsed)).not.toContain("secret-token");
  expect(JSON.stringify(parsed)).not.toContain("/private");
  const store = createLinkChildParityStore(() => 1794000001000);
  store.record(parsed!, new Set([report.linkId]));
  expect(store.get(report.linkId)).toMatchObject({ appliedRouteIntentDigest: "a".repeat(64), routeClientOutcomes: [{ client: "aside", outcome: "current", source: "local" }] });
  expect(parseLinkChildParityReport(report)).toEqual(report);
});
test("strict route report rejects malformed digest, duplicates, missing paired fields and secrets", () => {
  const extended = { ...report, appliedRouteIntentDigest: null, routeClientOutcomes: [{ client: "aside", outcome: "failed" }] };
  expect(parseLinkChildParityReport(extended)).not.toBeNull();
  for (const extra of [{ appliedRouteIntentDigest: "bad" }, { routeClientOutcomes: [{ client: "unknown", outcome: "current" }] }, { routeClientOutcomes: [{ client: "aside", outcome: "failed", apiKey: "secret" }] }, { routeClientOutcomes: [...extended.routeClientOutcomes, ...extended.routeClientOutcomes] }]) {
    expect(parseLinkChildParityReport({ ...extended, ...extra })).toBeNull();
  }
  expect(parseLinkChildParityReport({ ...report, appliedRouteIntentDigest: null })).toBeNull();
});
test("bounded report fits the entire client roster", () => {
  const extended = { ...report, appliedRouteIntentDigest: "b".repeat(64), routeClientOutcomes: ROUTE_CLIENT_IDS.map(client => ({ client, outcome: "not_installed", intentDigest: "c".repeat(64), initialIntent: { enabled: true }, initialRevision: Number.MAX_SAFE_INTEGER })) };
  expect(Buffer.byteLength(JSON.stringify(extended))).toBeLessThanOrEqual(LINK_CHILD_PARITY_MAX_BYTES);
  expect(parseLinkChildParityReport(extended)).not.toBeNull();
});

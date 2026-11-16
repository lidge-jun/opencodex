import { expect, test } from "bun:test";
import { homeRouteIntentReceipt, sendLinkChildParityReport, type HomeRouteIntentRecord } from "../../src/client/link-home";
import { createLinkParityReporter, LINK_PARITY_PERIOD_MS, LINK_PARITY_RETRY_MS } from "../../src/client/link-parity-reporter";
import { projectHomeRouteIntent, ROUTE_CLIENT_IDS } from "../../src/link/route-intent";
import type { LinkChildParityReport } from "../../src/link/child-parity";
import type { OcxClientConnectionConfig } from "../../src/types";

const linkId = "lnk_0123456789abcdef";
const at = "2026-11-07T00:00:00.000Z";
const connection = { transport: "link", apiKeyId: "fixture", link: { linkId, tunnelPort: 22001 } } as OcxClientConnectionConfig;
const receipt = homeRouteIntentReceipt(linkId, projectHomeRouteIntent({} as never, "fixture"), at, at,
  ROUTE_CLIENT_IDS.map(client => ({ client, outcome: "current" })), null);

function harness(statuses: number[], routeRecord: HomeRouteIntentRecord | null = receipt) {
  const sent: LinkChildParityReport[] = [];
  let pending: (() => void) | undefined;
  const delays: number[] = [];
  const reporter = createLinkParityReporter({ connection, runtimeStartedAt: at, linkKey: () => "fixture-key",
    readRecord: () => null, readRouteRecord: () => routeRecord,
    readCommonReceipt: () => routeRecord && ({ version: 1, linkId, document: routeRecord.document,
      clients: routeRecord.document.clients, sources: routeRecord.document.sources,
      selectedClients: ROUTE_CLIENT_IDS.filter(id => routeRecord.document.clients[id].enabled),
      outcomes: routeRecord.routeClientOutcomes, appliedRouteIntentDigest: routeRecord.appliedRouteIntentDigest, appliedAt: at }),
    readLocalOff: () => [],
    send: (connection, key, report) => sendLinkChildParityReport(connection, key, report, {
      fetchImpl: (async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: statuses.shift() ?? 204 });
      }) as typeof fetch,
    }),
    setTimer: (callback, ms) => { pending = callback; delays.push(ms); return callback; },
    clearTimer: () => { pending = undefined; },
  });
  const fire = async () => {
    const callback = pending; pending = undefined; callback?.();
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  return { reporter, sent, delays, fire, pending: () => pending };
}

test.each([400, 413, 422])("HTTP %i on extended parity retries base once and probes extended again next tick", async status => {
  const h = harness([status, 204, 204]);
  try {
    h.reporter.start(); await h.fire();
    expect(h.sent).toHaveLength(2);
    const { appliedRouteIntentDigest, routeClientOutcomes, ...base } = h.sent[0]!;
    expect(appliedRouteIntentDigest).toBeDefined();
    expect(routeClientOutcomes).toHaveLength(ROUTE_CLIENT_IDS.length);
    expect(h.sent[1]).toEqual(base);
    expect(h.delays.at(-1)).toBe(LINK_PARITY_PERIOD_MS);
    await h.fire();
    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]?.appliedRouteIntentDigest).toBe(appliedRouteIntentDigest);
    expect(h.sent[2]!.sequence).toBeGreaterThan(base.sequence);
  } finally { h.reporter.stop(); }
});

test.each([401, 403, 409, 429, 500])("HTTP %i never triggers a schema fallback", async status => {
  const h = harness([status]);
  try {
    h.reporter.start(); await h.fire();
    expect(h.sent).toHaveLength(1);
    expect(h.delays.at(-1)).toBe(LINK_PARITY_RETRY_MS[1]);
  } finally { h.reporter.stop(); }
});

test("missing parity route stops reporting without a fallback", async () => {
  const h = harness([404]);
  h.reporter.start(); await h.fire();
  expect(h.sent).toHaveLength(1);
  expect(h.pending()).toBeUndefined();
  h.reporter.stop();
});

test("base rejection backs off and each later tick still probes the extended schema", async () => {
  const h = harness([400, 500, 204]);
  try {
    h.reporter.start(); await h.fire();
    expect(h.sent).toHaveLength(2);
    expect(h.delays.at(-1)).toBe(LINK_PARITY_RETRY_MS[1]);
    await h.fire();
    expect(h.sent[2]?.appliedRouteIntentDigest).toBeDefined();
    expect(h.delays.at(-1)).toBe(LINK_PARITY_PERIOD_MS);
  } finally { h.reporter.stop(); }
});

test("a withdrawal falls back once after schema refusal and remains explicit next tick", async () => {
  const h = harness([400, 204, 204], null);
  try {
    h.reporter.start(); await h.fire();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]?.appliedRouteIntentDigest).toBeNull();
    expect(h.sent[0]?.routeClientOutcomes).toEqual([]);
    expect(h.sent[1]?.appliedRouteIntentDigest).toBeUndefined();
    expect(h.delays.at(-1)).toBe(LINK_PARITY_PERIOD_MS);
    await h.fire();
    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]?.appliedRouteIntentDigest).toBeNull();
    expect(h.sent[2]?.routeClientOutcomes).toEqual([]);
  } finally { h.reporter.stop(); }
});

import { expect, test } from "bun:test";
import { createLinkParityReporter, linkChildParityReport } from "../../src/client/link-parity-reporter";
import { homeRouteIntentReceipt, sendLinkChildParityReport } from "../../src/client/link-home";
import { projectHomeRouteIntent, ROUTE_CLIENT_IDS, routeIntentDigest } from "../../src/link/route-intent";
const id = "lnk_0123456789abcdef";
const connection = { transport: "link", apiKeyId: "key-id", link: { linkId: id, tunnelPort: 19200 } } as never;
const at = "2026-11-07T00:00:00.000Z";
const doc = projectHomeRouteIntent({} as never, "test");
const receipt = homeRouteIntentReceipt(id, doc, at, at, ROUTE_CLIENT_IDS.map(client => ({ client, outcome: "current", ...(client === "aside" ? { source: "local", target: "u0,u1", message: "sensitive" } : {}) })) as never, null);
const readCommonReceipt = () => ({ version: 1 as const, linkId: id, document: doc, clients: doc.clients, sources: doc.sources,
  selectedClients: ROUTE_CLIENT_IDS.filter(client => doc.clients[client].enabled), outcomes: receipt.routeClientOutcomes,
  appliedRouteIntentDigest: receipt.appliedRouteIntentDigest, appliedAt: at });
test("report carries receipt digest, local opt-out and only safe slot targets", async () => {
  const report = linkChildParityReport(connection, at, null, 1, receipt);
  expect(report?.appliedRouteIntentDigest).toBe(routeIntentDigest(doc));
  expect(Array.isArray(report?.routeClientOutcomes)).toBe(true);
  expect(report?.routeClientOutcomes?.find(row => row.client === "aside")).toEqual({ client: "aside", outcome: "current", source: "local", target: "u0,u1" });
  expect(JSON.stringify(report)).not.toContain("sensitive");
  let sent = "";
  expect(await sendLinkChildParityReport(connection, "key", { ...report!, routeClientOutcomes: [{ client: "aside", outcome: "failed", target: "/private/config.json", message: "sensitive" }] }, {
    fetchImpl: (async (_input, init) => { sent = String(init?.body); return new Response(null, { status: 204 }); }) as typeof fetch,
  })).toBe("accepted");
  expect(sent).not.toContain("/private");
  expect(sent).not.toContain("sensitive");
});
test("runtime reporter reads route receipt and ignores a receipt for another link", async () => {
  expect(linkChildParityReport(connection, at, null, 1, { ...receipt, linkId: "lnk_aaaaaaaaaaaaaaaa" })?.appliedRouteIntentDigest).toBeUndefined();
  let pending: (() => void) | undefined;
  let sent: unknown;
  const reporter = createLinkParityReporter({ connection, runtimeStartedAt: at, linkKey: () => "key", readRecord: () => null,
    readRouteRecord: () => receipt,
    readCommonReceipt, readLocalOff: () => [],
    send: async (_connection, _key, report) => { sent = report; return "accepted"; },
    setTimer: callback => { pending = callback; return 1; }, clearTimer: () => {},
  });
  reporter.start(); pending?.();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  reporter.stop();
  expect(sent).toMatchObject({ appliedRouteIntentDigest: routeIntentDigest(doc) });
});

test("an immediate report queues behind an in-flight send and never overlaps", async () => {
  const timers: Array<{ run: () => void; delay: number; cancelled: boolean }> = [];
  const completions: Array<(value: "accepted") => void> = [];
  const sequences: number[] = [];
  const reporter = createLinkParityReporter({ connection, runtimeStartedAt: at, linkKey: () => "key", readRecord: () => null,
    readRouteRecord: () => receipt,
    readCommonReceipt, readLocalOff: () => [],
    send: async (_connection, _key, report) => {
      sequences.push(report.sequence);
      return await new Promise<"accepted">(resolve => completions.push(resolve));
    },
    setTimer: (run, delay) => { const entry = { run, delay, cancelled: false }; timers.push(entry); return entry; },
    clearTimer: timer => { (timer as { cancelled: boolean }).cancelled = true; },
  });
  reporter.start();
  reporter.requestReport(); reporter.requestReport();
  expect(sequences).toHaveLength(1);
  expect(timers[0]?.cancelled).toBe(true);
  completions.shift()!("accepted");
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(timers.at(-1)?.delay).toBe(0);
  timers.at(-1)!.run();
  expect(sequences).toHaveLength(2);
  expect(sequences[1]!).toBeGreaterThan(sequences[0]!);
  reporter.stop(); completions.shift()!("accepted");
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(timers).toHaveLength(2);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchHomeRouteIntent, homeRouteIntentPath, homeRouteIntentReceipt, readHomeRouteIntentRecord, writeHomeRouteIntentRecord, clearHomeRouteIntentRecord } from "../../src/client/link-home";
import { projectHomeRouteIntent, ROUTE_CLIENT_IDS, routeIntentDigest } from "../../src/link/route-intent";
import { removeTreeWithRetry } from "../helpers/remove-tree";
const id = "lnk_0123456789abcdef";
const connection = { transport: "link", apiKeyId: "key-id", link: { linkId: id, tunnelPort: 19200 } } as never;
const document = projectHomeRouteIntent({} as never, "test");
let root: string;
let previous: string | undefined;
beforeEach(() => { previous = process.env.OPENCODEX_HOME; root = mkdtempSync(join(tmpdir(), "ocx-home-route-")); process.env.OPENCODEX_HOME = root; });
afterEach(() => { if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous; removeTreeWithRetry(root); });
test("bounded authenticated fetch uses exact route, no redirects, and returns explicit unsupported/failed", async () => {
  let url = ""; let init: RequestInit | undefined;
  const deps = { fetchImpl: (async (input, options) => { url = String(input); init = options; return Response.json(document); }) as typeof fetch };
  expect(await fetchHomeRouteIntent(connection, "test-admission", deps)).toEqual({ kind: "fresh", document });
  expect(url).toBe("http://127.0.0.1:19200/v1/link-management/route-intent");
  expect(init?.redirect).toBe("manual");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-admission");
  for (const [status, kind] of [[404, "unsupported"], [302, "failed"], [500, "failed"]] as const) {
    expect((await fetchHomeRouteIntent(connection, "key", { fetchImpl: (async () => new Response(null, { status })) as typeof fetch })).kind).toBe(kind);
  }
  expect((await fetchHomeRouteIntent(connection, "key", { fetchImpl: (async () => Response.json({ ...document, apiKey: "secret" })) as typeof fetch })).kind).toBe("failed");
  expect((await fetchHomeRouteIntent(connection, "key", { fetchImpl: (async () => new Response(" ".repeat(65537))) as typeof fetch })).kind).toBe("failed");
});
test("receipts are link-bound and only complete dispositions claim an applied digest", () => {
  const time = "2026-11-07T00:00:00.000Z";
  const outcomes = ROUTE_CLIENT_IDS.map(client => ({ client, outcome: "current" as const }));
  const receipt = homeRouteIntentReceipt(id, document, time, time, outcomes, null);
  expect(receipt.appliedRouteIntentDigest).toBe(routeIntentDigest(document));
  writeHomeRouteIntentRecord(receipt);
  expect(readHomeRouteIntentRecord(id)).toEqual(receipt);
  expect(readHomeRouteIntentRecord("lnk_aaaaaaaaaaaaaaaa")).toBeNull();
  expect(homeRouteIntentReceipt(id, document, time, "2026-11-07T01:00:00.000Z", outcomes, receipt).appliedAt).toBe(time);
  const partial = homeRouteIntentReceipt(id, document, time, time, [{ client: "aside", outcome: "failed" }], receipt);
  expect(partial.appliedRouteIntentDigest).toBeNull();
  expect(partial.routeClientOutcomes).toEqual([{ client: "aside", outcome: "failed" }]);
  expect(homeRouteIntentReceipt(id, document, time, time, outcomes.map(row => row.client === "codex" ? { ...row, outcome: "not_installed" } : row), null).appliedRouteIntentDigest).toBeNull();
  expect(homeRouteIntentReceipt(id, document, time, time, outcomes.map(row => row.client === "codex" ? { ...row, source: "local" } : row), null).appliedRouteIntentDigest).toBeNull();
  writeFileSync(homeRouteIntentPath(), JSON.stringify({ ...receipt, document: { ...document, path: "/private" } }));
  expect(readHomeRouteIntentRecord(id)).toBeNull();
  writeHomeRouteIntentRecord(receipt);
  expect(readFileSync(homeRouteIntentPath(), "utf8")).not.toContain("admission");
  clearHomeRouteIntentRecord();
  expect(readHomeRouteIntentRecord(id)).toBeNull();
});

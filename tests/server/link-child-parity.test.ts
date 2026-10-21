/**
 * OCX-6 on the Home: the Child's apply report and the link row that shows it.
 *
 * The report is the one write the link accepts. It is admitted only for the link the admitting key
 * belongs to, read with a hard size cap, and changes nothing but an in-memory status field, which
 * `GET /api/link/status` and `ocx link status --json` then carry as `lastApplyAt` (epoch ms).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkManagementRequest } from "../../src/server/index/link-management";
import {
  createLinkChildParityStore,
  homeLinkChildParity,
  LINK_CHILD_PARITY_MAX_BYTES,
  LINK_CHILD_PARITY_PATH,
  linkChildParityRouteAllowed,
  parseLinkChildParityReport,
} from "../../src/link/child-parity";
import { linkManagementRouteAllowed } from "../../src/link/management-routes";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore, type LinkStore } from "../../src/link/store";
import { projectLinkStatus } from "../../src/link/status-projection";
import { runLinkCommand } from "../../src/cli/link";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINK_ID = "lnk_0123456789abcdef";
const OTHER_LINK = "lnk_fedcba9876543210";
const KEY_ID = "link-key-1";
const DIGEST = "57c751eff89844f93db71a6ee4acdac03afbc29fec52734ade80a40193e826cd";
const store: LinkStore = {
  version: 1,
  listenerPort: 19100,
  links: [
    { id: LINK_ID, alias: "child-a", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 19200, apiKeyId: KEY_ID, createdAt: "2026-10-20T00:00:00.000Z" },
    { id: OTHER_LINK, alias: "child-b", direction: "hub-initiated", hostKeyFingerprint: "SHA256:qrstuvwxyzabcdef", tunnelPort: 19201, apiKeyId: "link-key-2", createdAt: "2026-10-20T00:00:00.000Z" },
  ],
};
const report = { linkId: LINK_ID, lastApplyAt: 1_761_008_400_000, runtimeStartedAt: 1_761_008_405_000, appliedCodexSettingsDigest: DIGEST, sequence: 3 };

let root = "";
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-child-parity-"));
  process.env.OPENCODEX_HOME = root;
  writeLinkStore(linkStorePath(), store);
  homeLinkChildParity.clear();
});
afterEach(() => {
  homeLinkChildParity.clear();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

function post(body: string, keyId: string | null = KEY_ID, path = LINK_CHILD_PARITY_PATH, method = "POST"): Promise<Response> {
  const url = new URL(path, "http://127.0.0.1:19100");
  const req = new Request(url, method === "POST" ? { method, body, headers: { "content-type": "application/json" } } : { method });
  return handleLinkManagementRequest(req, url, {} as never, {} as never, undefined, keyId ?? undefined);
}

describe("the Child's apply report on the Home", () => {
  test("a valid report for the admitting key's own link is kept and shown", async () => {
    const before = readFileSync(linkStorePath(), "utf8");
    const response = await post(JSON.stringify(report));
    expect(response.status).toBe(204);
    expect(homeLinkChildParity.get(LINK_ID)).toMatchObject({
      lastApplyAt: report.lastApplyAt, runtimeStartedAt: report.runtimeStartedAt, appliedCodexSettingsDigest: DIGEST,
    });
    expect(homeLinkChildParity.get(OTHER_LINK).lastApplyAt).toBeNull();
    // Nothing durable changes on the Home.
    expect(readFileSync(linkStorePath(), "utf8")).toBe(before);
  });

  test("refuses another link's report, a missing key, a malformed or oversized body, and other methods", async () => {
    expect((await post(JSON.stringify({ ...report, linkId: OTHER_LINK }))).status).toBe(403);
    expect((await post(JSON.stringify(report), null)).status).toBe(403);
    expect((await post(JSON.stringify({ ...report, extra: 1 }))).status).toBe(400);
    expect((await post(JSON.stringify({ ...report, lastApplyAt: "2026-10-21T00:00:00.000Z" }))).status).toBe(400);
    expect((await post(JSON.stringify({ ...report, appliedCodexSettingsDigest: `sha256:${DIGEST}` }))).status).toBe(400);
    expect((await post(JSON.stringify({ ...report, appliedCodexSettingsDigest: null }))).status).toBe(400);
    expect((await post(JSON.stringify({ ...report, sequence: -1 }))).status).toBe(400);
    const { sequence: _sequence, ...unsequenced } = report;
    expect((await post(JSON.stringify(unsequenced))).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect((await post(" ".repeat(LINK_CHILD_PARITY_MAX_BYTES + 1))).status).toBe(413);
    expect((await post("", KEY_ID, LINK_CHILD_PARITY_PATH, "GET")).status).toBe(404);
    expect(homeLinkChildParity.get(LINK_ID).reportedAt).toBeNull();
  });

  test("before any apply a Child reports its start alone", () => {
    expect(parseLinkChildParityReport({ ...report, lastApplyAt: null, appliedCodexSettingsDigest: null })).toEqual({
      ...report, lastApplyAt: null, appliedCodexSettingsDigest: null,
    });
  });

  test("the listener admits exactly the report POST, and the read table never admits it", () => {
    const url = new URL(LINK_CHILD_PARITY_PATH, "http://127.0.0.1:19100");
    expect(linkChildParityRouteAllowed(url, new Request(url, { method: "POST", body: "{}" }))).toBe(true);
    expect(linkChildParityRouteAllowed(url, new Request(url))).toBe(false);
    expect(linkChildParityRouteAllowed(new URL("?x=1", url), new Request(url, { method: "POST", body: "{}" }))).toBe(false);
    expect(linkManagementRouteAllowed(url, new Request(url, { method: "POST", body: "{}" }))).toBe(false);
    expect(linkManagementRouteAllowed(url, new Request(url))).toBe(false);
  });

  test("reports for links that are gone are dropped", () => {
    let now = 1_761_008_410_000;
    const parity = createLinkChildParityStore(() => now);
    parity.record(report, new Set([LINK_ID]));
    now += 1;
    parity.record({ ...report, linkId: OTHER_LINK }, new Set([OTHER_LINK]));
    expect(parity.get(LINK_ID).reportedAt).toBeNull();
    expect(parity.get(OTHER_LINK).reportedAt).toBe(now);
  });

  test("a late report never moves the Home's view backward", () => {
    const parity = createLinkChildParityStore(() => 1_761_008_410_000);
    const links = new Set([LINK_ID]);
    const newerRuntime = { ...report, runtimeStartedAt: report.runtimeStartedAt + 60_000, sequence: 1 };
    expect(parity.record(newerRuntime, links)).toBe(true);
    // The old runtime's in-flight POST lands afterwards: ignored, whatever its sequence.
    expect(parity.record({ ...report, sequence: 99 }, links)).toBe(false);
    expect(parity.get(LINK_ID).runtimeStartedAt).toBe(newerRuntime.runtimeStartedAt);
    // Within one runtime only a later send wins, even when it withdraws the digest.
    const withdrawn = { ...newerRuntime, lastApplyAt: null, appliedCodexSettingsDigest: null, sequence: 2 };
    expect(parity.record(withdrawn, links)).toBe(true);
    expect(parity.record({ ...newerRuntime, sequence: 1 }, links)).toBe(false);
    expect(parity.get(LINK_ID)).toMatchObject({ lastApplyAt: null, appliedCodexSettingsDigest: null });
  });
});

describe("ocx link status --json on the Home (shape snapshot)", () => {
  test("each link row carries lastApplyAt and the Child's runtime start as epoch ms", async () => {
    const parity = createLinkChildParityStore(() => 1_761_008_410_000);
    parity.record(report, new Set([LINK_ID, OTHER_LINK]));
    const dto = projectLinkStatus(
      store, [], { state: "listening", port: 19100 }, {}, { version: 1, entries: {} }, null, null,
      id => parity.get(id),
    );
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      const code = await runLinkCommand(["status", "--json"], {
        baseUrl: "http://127.0.0.1:19101",
        fetchImpl: (async () => Response.json(dto)) as unknown as typeof fetch,
        readAdminToken: () => "ocx_admin_test-token",
      });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    expect(JSON.parse(lines[0]!)).toEqual({
      role: "home",
      listener: { state: "listening", port: 19100 },
      links: [
        {
          id: LINK_ID, alias: "child-a", direction: "hub-initiated", state: "idle", since: "2026-10-20T00:00:00.000Z", reason: null, tunnelPort: 19200,
          lastApplyAt: 1_761_008_400_000, runtimeStartedAt: 1_761_008_405_000, appliedCodexSettingsDigest: DIGEST, reportedAt: 1_761_008_410_000,
        },
        {
          id: OTHER_LINK, alias: "child-b", direction: "hub-initiated", state: "idle", since: "2026-10-20T00:00:00.000Z", reason: null, tunnelPort: 19201,
          lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null, reportedAt: null,
        },
      ],
      child: null,
    });
  });
});

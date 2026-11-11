import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { GuiSessionIssuance } from "../../src/server/gui-session";
import { MANAGEMENT_ROUTES } from "../../src/server/management/route-registry";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
let previousHome: string | undefined;
const line = (value: unknown): string => JSON.stringify(value) + "\n";
const content = line({ event: "tunnel_transition", outcome: "hostkey", previousState: "connecting", state: "failed", attempt: 2, tunnelPort: 43110, timestamp: 10, alias: "\u001b[2Jprivate-host" })
  + line({ event: "\u001b[31mforged", outcome: "match", timestamp: 11 })
  + line({ event: "owner_lookup", outcome: "match", timestamp: 12 });

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-link-diagnostics-route-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function seed(): string {
  const dir = join(home, "link");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "diagnostics.jsonl");
  writeFileSync(path, content);
  return path;
}

function config(runtimeRole: OcxConfig["runtimeRole"] = "standalone"): OcxConfig {
  return { port: 10100, hostname: "127.0.0.1", runtimeRole, defaultProvider: "mock", providers: {}, apiKeys: [] } as OcxConfig;
}

/** No link supervisor or listener: the read must not depend on the link lifecycle. */
const deps: ManagementApiDeps = {};

async function call(path: string, options: { method?: string; principal?: "admin-token" | "gui-session"; trustedLoopback?: boolean; issuance?: GuiSessionIssuance | null; paired?: boolean; cfg?: OcxConfig } = {}) {
  const url = new URL("http://127.0.0.1" + path);
  const req = new Request(url, { method: options.method ?? "GET", headers: { host: "127.0.0.1" } });
  const paired = options.paired ?? true;
  return handleManagementAPI(req, url, options.cfg ?? config(), deps, options.principal,
    { isPaired: () => paired, isCurrent: () => true, revokeCurrent: () => true },
    { trustedLoopback: options.trustedLoopback ?? true, guiSessionIssuance: options.issuance ?? null });
}

describe("GET /api/link/diagnostics", () => {
  test("is declared as a non-mutating route", () => {
    const row = MANAGEMENT_ROUTES.find(entry => entry.method === "GET" && entry.path === "/api/link/diagnostics");
    expect(row?.mutates).toBe(false);
  });

  test("returns the sanitized records to loopback admin and dashboard sessions, without the file path", async () => {
    const path = seed();
    for (const options of [{ principal: "admin-token" as const }, { principal: "gui-session" as const, issuance: "loopback" as GuiSessionIssuance }]) {
      const response = await call("/api/link/diagnostics", options);
      expect(response?.status).toBe(200);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      const text = await response!.text();
      expect(JSON.parse(text)).toEqual({
        schema: "ocx.link.diagnostics/1",
        files: [{ name: "diagnostics.jsonl.1", state: "absent", truncated: false }, { name: "diagnostics.jsonl", state: "read", truncated: false }],
        matched: 2,
        skipped: 1,
        records: [
          { event: "tunnel_transition", outcome: "hostkey", state: "failed", previousState: "connecting", attempt: 2, tunnelPort: 43110, timestamp: 10 },
          { event: "owner_lookup", outcome: "match", timestamp: 12 },
        ],
      });
      for (const leaked of ["private-host", "forged", "\\u001b", home]) expect(text).not.toContain(leaked);
    }
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  test("an absent file is an empty answer and creates nothing", async () => {
    const response = await call("/api/link/diagnostics", { principal: "admin-token" });
    expect(response?.status).toBe(200);
    expect((await response!.json()).records).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  test("requires the same authority as link status", async () => {
    seed();
    const refusals = [
      {},
      { principal: "admin-token" as const, trustedLoopback: false },
      { principal: "gui-session" as const, issuance: "tailscale-identity" as GuiSessionIssuance },
      { principal: "gui-session" as const, issuance: "loopback" as GuiSessionIssuance, paired: false, cfg: config("hub") },
    ];
    for (const options of refusals) {
      const response = await call("/api/link/diagnostics", options);
      expect(response?.status).toBe(403);
      expect(await response!.text()).not.toContain("tunnel_transition");
    }
  });

  test("bounds the limit and filters by since", async () => {
    seed();
    const one = await call("/api/link/diagnostics?limit=1", { principal: "admin-token" });
    expect((await one!.json()).records).toEqual([{ event: "owner_lookup", outcome: "match", timestamp: 12 }]);
    const since = await call("/api/link/diagnostics?since=11", { principal: "admin-token" });
    expect((await since!.json()).matched).toBe(1);
    for (const query of ["limit=0", "limit=1001", "limit=abc", "since=-1", "since=soon"]) {
      expect((await call("/api/link/diagnostics?" + query, { principal: "admin-token" }))?.status).toBe(400);
    }
  });

  test("has no write method", async () => {
    const path = seed();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await call("/api/link/diagnostics", { method, principal: "admin-token" });
      expect(response?.status).not.toBe(200);
    }
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(readdirSync(join(home, "link"))).toEqual(["diagnostics.jsonl"]);
  });
});

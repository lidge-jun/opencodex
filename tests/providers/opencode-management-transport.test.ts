import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as directHttp from "../../src/server/direct-local-http";
import * as liveness from "../../src/server/proxy-liveness";
import { buildOpencodeEnv, buildOpencodeProviderBlocksFromCatalog, cmdOpencode, fetchOpencodeProxyModels } from "../../src/cli/opencode";
import { OPENCODE_API_KEY_ENV } from "../../src/clients/config-export";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

const admin = `ocx_admin_${"a".repeat(43)}`;
const fileAdmin = `ocx_admin_${"b".repeat(43)}`;
const dataKey = "opencode-fixture-data-key";
const rows = [{ id: "model", provider: "fixture", namespaced: "fixture/model" }];
const touched = ["HOME", "USERPROFILE", "OPENCODEX_HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "OPENCODEX_ADMIN_AUTH_TOKEN",
  "OPENCODEX_API_AUTH_TOKEN", "OCX_API_TOKEN_FILE", "OPENCODE_CONFIG_CONTENT",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"] as const;
let previous: Map<string, string | undefined>;
let home: string;
let config: OcxConfig;

beforeEach(() => {
  previous = new Map(touched.map(key => [key, process.env[key]]));
  for (const key of touched) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), "ocx-opencode-transport-"));
  for (const name of ["home", "codex", "xdg"]) mkdirSync(join(home, name));
  process.env.HOME = join(home, "home"); process.env.USERPROFILE = process.env.HOME;
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = join(home, "codex"); process.env.XDG_CONFIG_HOME = join(home, "xdg");
  config = { port: 10123, hostname: "127.0.0.1", defaultProvider: "fixture", providers: {
    fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example.test/v1", models: ["model"], liveModels: false },
  }, apiKeys: [{ id: "one", name: "one", key: dataKey, createdAt: "2026-01-01" }] } as OcxConfig;
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
});
afterEach(() => {
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  removeTreeWithRetry(home);
});

test.each(["192.0.2.1", "example.test", "[2001:db8::1]", "user@127.0.0.1", "127.0.0.1/path"])(
  "rejects nonlocal or malformed catalog host %s before transport", async hostname => {
    let calls = 0;
    await expect(fetchOpencodeProxyModels({ hostname, port: 12345, pid: null, source: "config" }, admin, {
      fetchImpl: (async () => { calls++; return Response.json(rows); }) as typeof fetch,
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });

test.each([0, -1, 65536, 1.5])( "rejects invalid live port %i before transport", async port => {
  let calls = 0;
  await expect(fetchOpencodeProxyModels({ hostname: "127.0.0.1", port, pid: null, source: "config" }, admin, {
    fetchImpl: (async () => { calls++; return Response.json(rows); }) as typeof fetch,
  })).rejects.toThrow();
  expect(calls).toBe(0);
});

test.each(["http://user:secret@127.0.0.1:12345", "http://127.0.0.1:12345/path", "http://127.0.0.1:12345/?x=1", "https://127.0.0.1:12345"])(
  "validates an explicitly selected management origin: %s", async managementOrigin => {
    let calls = 0;
    await expect(fetchOpencodeProxyModels({ hostname: "127.0.0.1", port: 12345, pid: null, source: "config" }, admin, {
      managementOrigin, fetchImpl: (async () => { calls++; return Response.json(rows); }) as typeof fetch,
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });

test.each(["127.0.0.1", "localhost", "localhost.", "0.0.0.0", "::", "::1", "[::1]"])(
  "normalizes local host %s to numeric loopback", async hostname => {
    const result = await fetchOpencodeProxyModels({ hostname, port: 12345, pid: null, source: "config" }, admin, {
      fetchImpl: (async (input, init) => {
        expect(String(input)).toBe(`http://${hostname.includes("::1") ? "[::1]" : "127.0.0.1"}:12345/api/models`);
        expect(init?.redirect).toBe("error");
        return Response.json(rows);
      }) as typeof fetch,
    });
    expect(result).toEqual(rows);
  });

test("production catalog transport ignores proxy environment; its control reaches the proxy", async () => {
  let proxyRequests = 0;
  let catalogRequests = 0;
  const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { proxyRequests++; return new Response("proxy-control"); } });
  const local = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => {
    catalogRequests++; expect(req.headers.get("x-opencodex-api-key")).toBe(admin); return Response.json(rows);
  } });
  try {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) process.env[key] = proxy.url.origin;
    process.env.NO_PROXY = ""; process.env.no_proxy = "";
    expect(await fetchOpencodeProxyModels({ hostname: "127.0.0.1", port: local.port!, pid: null, source: "config" }, admin)).toEqual(rows);
    expect(catalogRequests).toBe(1);
    expect(proxyRequests).toBe(0);
  } finally { await local.stop(true); await proxy.stop(true); }
}, SERVER_BUDGET_MS);

test.each([301, 302, 307, 308])("production catalog refuses redirect %i without contacting its target", async status => {
  let targetRequests = 0;
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { targetRequests++; return Response.json(rows); } });
  const redirector = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status, headers: { location: target.url.href } }) });
  try {
    await expect(fetchOpencodeProxyModels({ hostname: "127.0.0.1", port: redirector.port!, pid: null, source: "config" }, admin)).rejects.toThrow("redirects are refused");
    expect(targetRequests).toBe(0);
  } finally { await redirector.stop(true); await target.stop(true); }
}, SERVER_BUDGET_MS);

test.each(["environment", "file", "missing", "unauthorized", "redirect", "ingress", "live-host"])(
  "launcher separates catalog credentials and child environment: %s", async mode => {
    if (mode !== "file" && mode !== "missing") process.env.OPENCODEX_ADMIN_AUTH_TOKEN = admin;
    if (mode !== "missing") writeFileSync(join(home, "admin-api-token"), fileAdmin);
    if (mode === "ingress") config = { ...config, runtimeRole: "hub", hostname: "192.0.2.1", hub: { managementIngress: { enabled: true, port: 10124 } } };
    if (mode === "live-host") config.hostname = "192.0.2.2";
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const finder = spyOn(liveness, "findLiveProxy").mockResolvedValue({ port: 10123, hostname: mode === "ingress" ? "192.0.2.1" : "127.0.0.1", pid: null, source: "config" });
    const request = spyOn(directHttp, "directLocalHttpFetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe(`http://127.0.0.1:${mode === "ingress" ? 10124 : 10123}/api/models`);
      expect(new Headers(init?.headers).get("x-opencodex-api-key")).toBe(mode === "file" ? fileAdmin : admin);
      return mode === "unauthorized" ? new Response(null, { status: 401 }) : mode === "redirect" ? new Response(null, { status: 302 }) : Response.json(rows);
    });
    let childEnv: NodeJS.ProcessEnv | undefined;
    const spawn = spyOn(childProcess, "spawn").mockImplementation((...args) => {
      const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
      childEnv = options?.env;
      const child = new childProcess.ChildProcess(); queueMicrotask(() => child.emit("exit", 0, null)); return child;
    });
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const refused = ["missing", "unauthorized", "redirect"].includes(mode);
      expect(await cmdOpencode([])).toBe(refused ? 1 : 0);
      expect(request).toHaveBeenCalledTimes(mode === "missing" ? 0 : 1);
      expect(spawn).toHaveBeenCalledTimes(refused ? 0 : 1);
      if (!refused) {
        expect(childEnv?.[OPENCODE_API_KEY_ENV]).toBe(dataKey);
        expect(childEnv?.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
        expect(childEnv?.OPENCODE_CONFIG_CONTENT).not.toContain(admin);
        expect(childEnv?.OPENCODE_CONFIG_CONTENT).not.toContain(fileAdmin);
        expect(childEnv?.OPENCODE_CONFIG_CONTENT).not.toContain(dataKey);
      }
    } finally { err.mockRestore(); spawn.mockRestore(); request.mockRestore(); finder.mockRestore(); }
  });

test("case-insensitive inherited admin names are removed without changing other child variables", () => {
  const blocks = buildOpencodeProviderBlocksFromCatalog(12345, [], undefined, config);
  const env = buildOpencodeEnv(blocks, dataKey, { opencodex_admin_auth_token: admin, KEEP: "value" });
  expect(env).not.toHaveProperty("opencodex_admin_auth_token");
  expect("error" in env).toBe(false);
  expect((env as Record<string, string | undefined>).KEEP).toBe("value");
});

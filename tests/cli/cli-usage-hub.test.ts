import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleObserveCommand } from "../../src/cli/observe";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let prior: string | undefined;
const token = "hub-client-usage-token";
const fingerprint = createHash("sha256").update(token).digest("hex");
const connection = () => ({ serverUrl: "https://hub.example.test", managementUrl: "https://manage.example.test",
  managementTransport: "direct", selectedClients: ["claude"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
  apiKeyId: "client-one", tokenFingerprint: fingerprint, protocolVersion: 1, connectedAt: "2026-09-01T00:00:00.000Z" });
function writeConfig(client: unknown = connection(), runtimeRole = "client") {
  writeFileSync(join(home, "config.json"), JSON.stringify({ port: 9, providers: {}, defaultProvider: "openai", runtimeRole, client }));
}
const report = () => ({ schemaVersion: 1, source: "hub", scope: "client", range: "all", surface: "all", since: null, generatedAt: 1,
  summary: { requests: 1, totalTokens: 3, inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, unpricedRequests: 1, unmeteredRequests: 0 },
  providers: [], models: [], days: [], filter: { provider: "fixture", model: null, matched: true, comboOverlap: false } });

beforeEach(() => {
  prior = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-cli-hub-usage-")); process.env.OPENCODEX_HOME = home;
  writeConfig(); writeFileSync(join(home, "service-api-token"), token);
});
afterEach(() => {
  if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
  removeTreeWithRetry(home);
});

test("connected usage reads data-plane hub and labels its scope without account advice", async () => {
  const out = spyOn(console, "log").mockImplementation(() => {});
  try {
    const code = await handleObserveCommand(["usage", "--range", "all"], { fetchImpl: (async (input, init) => {
      expect(String(input)).toBe("https://hub.example.test/v1/usage?range=all&surface=all");
      expect(new Headers(init?.headers).get("x-opencodex-api-key")).toBe(token);
      return Response.json(report());
    }) as typeof fetch });
    expect(code).toBe(0);
    const text = out.mock.calls.flat().join("\n");
    expect(text).toContain("Source: hub");
    expect(text).not.toContain("run without filters");
  } finally { out.mockRestore(); }
});

test("JSON and custom-window acknowledgment survive client routing", async () => {
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const args = ["usage", "--json", "--since", "10", "--until", "20"];
    const body = { ...report(), customWindow: true, since: 10, until: 20 };
    expect(await handleObserveCommand(args, { fetchImpl: (async () => Response.json(body)) as typeof fetch })).toBe(0);
    expect(JSON.parse(out.mock.calls.flat().join("\n"))).toEqual(body);
    expect(await handleObserveCommand(args, { fetchImpl: (async () => Response.json(report())) as typeof fetch })).not.toBe(0);
  } finally { out.mockRestore(); err.mockRestore(); }
});

test("invalid connection and mismatched token fail before any request", async () => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  let calls = 0;
  const deps = { fetchImpl: (async () => { calls++; return Response.json(report()); }) as typeof fetch };
  try {
    writeConfig({ broken: true });
    expect(await handleObserveCommand(["usage"], deps)).not.toBe(0);
    writeConfig(); writeFileSync(join(home, "service-api-token"), "different-token");
    expect(await handleObserveCommand(["usage"], deps)).not.toBe(0);
    expect(calls).toBe(0);
  } finally { err.mockRestore(); }
});

test("connection or token changes during the read discard the response", async () => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  const out = spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const changed of ["owner", "token"]) {
      writeConfig(); writeFileSync(join(home, "service-api-token"), token);
      const code = await handleObserveCommand(["usage", "--json"], { fetchImpl: (async () => {
        if (changed === "owner") writeConfig({ ...connection(), connectedAt: "2026-09-02T00:00:00.000Z" });
        else writeFileSync(join(home, "service-api-token"), "replacement");
        return Response.json(report());
      }) as typeof fetch });
      expect(code).not.toBe(0);
    }
    expect(out).not.toHaveBeenCalled();
  } finally { err.mockRestore(); out.mockRestore(); }
});

test("standalone usage keeps its local management path", async () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ port: 9, providers: {}, defaultProvider: "openai" }));
  const out = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await handleObserveCommand(["usage", "--json"], { baseUrl: "http://local.test", fetchImpl: (async input => {
      expect(String(input)).toBe("http://local.test/api/usage?range=30d&surface=all");
      return Response.json({ summary: { requests: 0 } });
    }) as typeof fetch })).toBe(0);
  } finally { out.mockRestore(); }
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTEGRATION_CAPABILITIES } from "../../src/cli/capabilities-integrations";
import { handleClientIntegrationCommand, handleClaudeConfigCommand, handleGrokCommand } from "../../src/cli/integrations";
import { handleClaudeDesktopCommand } from "../../src/cli/claude-desktop";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

let home: string;
let previous: Record<string, string | undefined>;
let output: ReturnType<typeof spyOn<typeof console, "log">>;
let errors: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-cap-integration-"));
  previous = { OPENCODEX_HOME: process.env.OPENCODEX_HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = join(home, "codex");
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "", port: 10100 }));
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  output.mockRestore(); errors.mockRestore();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(home);
});
type Recorded = { path: string; method: string; body: unknown };
function runtime(response: unknown = { ok: true }, status = 200) {
  const requests: Recorded[] = [];
  const deps: RuntimeApiDeps = { baseUrl: "http://fixture.invalid", findLiveProxy: async () => null,
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname + url.search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(response, { status });
    }) as typeof fetch,
  };
  return { requests, deps };
}
function leaf(key: string) {
  const capability = INTEGRATION_CAPABILITIES.find(row => row.command.join(" ") === key);
  expect(capability).toBeDefined(); return capability!;
}

describe("declared integration workflows", () => {
  test.each([
    { args: ["status", "--json"], path: "/api/client-integrations" },
    { args: ["status", "--client", "droid", "--json"], path: "/api/client-integrations/droid" },
    { args: ["status", "--client", "aside", "--json"], path: "/api/client-integrations/aside/profiles" },
    { args: ["status", "--client", "aside", "--profile", "2", "--json"], path: "/api/client-integrations/aside/profiles/2" },
  ])("client read selects $path", async ({ args, path }) => {
    expect(leaf("integration client status").mutates).toBe(false);
    const { requests, deps } = runtime({ clients: [] });
    expect(await handleClientIntegrationCommand(args, deps)).toBe(0);
    expect(requests).toEqual([{ path, method: "GET", body: null }]);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({ clients: [] });
  });

  test("ordinary client metadata includes its real template, not only Aside", () => {
    expect(leaf("integration client status").routes).toContainEqual({ method: "GET", path: "/api/client-integrations/{clientId}" });
    expect(leaf("integration client enable").routes).toContainEqual({ method: "PUT", path: "/api/client-integrations/{clientId}" });
  });

  test("explicit enable conflict waiver reaches only the selected Aside profile", async () => {
    const { requests, deps } = runtime({ ok: true, profileId: "2", state: "current" });
    expect(leaf("integration client enable").flags.find(f => f.name === "--overwrite-conflict")?.value).toBe("boolean");
    expect(await handleClientIntegrationCommand(["enable", "--client", "aside", "--profile", "2", "--overwrite-conflict", "--json"], deps)).toBe(0);
    expect(requests).toEqual([{ path: "/api/client-integrations/aside/profiles/2", method: "PUT", body: { enabled: true, overwriteConflict: true } }]);
  });

  test("disable rejects an overwrite waiver without writing", async () => {
    const { requests, deps } = runtime();
    expect(leaf("integration client disable").flags.some(f => f.name === "--overwrite-conflict")).toBe(false);
    expect(await handleClientIntegrationCommand(["disable", "--client", "droid", "--overwrite-conflict", "--json"], deps)).toBe(2);
    expect(requests).toEqual([]);
  });

  test("history uses the ordinary journal filter and returns expired snapshots", async () => {
    const payload = { operations: [{ opId: "fixture", snapshot: "expired" }] };
    const { requests, deps } = runtime(payload);
    expect(leaf("integration client history").routes).toContainEqual({ method: "GET", path: "/api/client-integrations/journal" });
    expect(await handleClientIntegrationCommand(["history", "--client", "droid", "--json"], deps)).toBe(0);
    expect(requests).toEqual([{ path: "/api/client-integrations/journal?client=droid", method: "GET", body: null }]);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual(payload);
  });

  test("restore keeps a server drift refusal and never auto-confirms or retries", async () => {
    const { requests, deps } = runtime({ error: "config_drift", hint: "Explicit drift confirmation required" }, 409);
    expect(leaf("integration client restore").routes).toContainEqual({ method: "POST", path: "/api/client-integrations/aside/profiles/{profileId}/restore" });
    expect(await handleClientIntegrationCommand(["restore", "--op", "fixture", "--client", "aside", "--profile", "2", "--json"], deps)).toBe(5);
    expect(requests).toEqual([{ path: "/api/client-integrations/aside/profiles/2/restore", method: "POST", body: { opId: "fixture", confirmDrift: false } }]);
    expect(output.mock.calls).toHaveLength(0);
    expect(errors.mock.calls.flat().join(" ")).toContain("config_drift");
  });

  test("first-party Claude settings remain an isolated write with warnings intact", async () => {
    const result = { ok: true, warnings: ["shared_proxy_retained"] };
    const { requests, deps } = runtime(result);
    expect(leaf("claude config set").flags.find(f => f.name === "--first-party")?.value).toBe("string");
    expect(await handleClaudeConfigCommand(["set", "--first-party", "off", "--json"], deps)).toBe(0);
    expect(requests).toEqual([{ path: "/api/claude-code", method: "PUT", body: { cliFirstParty: false } }]);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual(result);
    expect(await handleClaudeConfigCommand(["set", "--first-party", "on", "--enabled", "on", "--json"], deps)).toBe(2);
    expect(requests).toHaveLength(1);
  });

  test("Grok include reads existing exclusions; apply returns its skipped receipt", async () => {
    const { requests, deps } = runtime({ excluded: ["keep", "include-me"] });
    expect(leaf("grok include").routes).toEqual([{ method: "GET", path: "/api/grok" }, { method: "PUT", path: "/api/grok/selection" }]);
    expect(await handleGrokCommand(["include", "include-me", "--json"], deps)).toBe(0);
    expect(requests).toEqual([{ path: "/api/grok", method: "GET", body: null }, { path: "/api/grok/selection", method: "PUT", body: { excluded: ["keep"] } }]);
    const skipped = { ok: true, changed: false, skippedReason: "disabled" };
    const apply = runtime(skipped);
    expect(leaf("grok apply").routes).toEqual([{ method: "POST", path: "/api/grok/apply" }]);
    expect(await handleGrokCommand(["apply", "--json"], apply.deps)).toBe(0);
    expect(apply.requests).toEqual([{ path: "/api/grok/apply", method: "POST", body: null }]);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual(skipped);
  });

  test("Desktop apply rejects incompatible mode flags before any apply dependency", async () => {
    let calls = 0;
    expect(leaf("claude desktop apply").json).toBe("none");
    expect(await handleClaudeDesktopCommand(["apply", "--first-party", "--gateway"], {
      findLiveProxyImpl: async () => { calls++; return null; },
      postApplyImpl: async () => { calls++; return { ok: true }; },
    })).toBe(2);
    expect(calls).toBe(0);
  });

  test("Desktop local profile writers and export declare no fictitious HTTP or JSON flag", async () => {
    // Source proof avoids invoking catalog discovery, file overwrites, or trust operations.
    const source = await Bun.file(repoPath("src", "cli", "claude-desktop.ts")).text();
    for (const verb of ["move", "default", "export"]) {
      const declaration = leaf("claude desktop " + verb);
      expect(declaration.routes).toEqual([]); expect(declaration.json).toBe("none");
      const start = source.indexOf(`if (command === "${verb}")`);
      const end = source.indexOf('\n    if (command === ', start + 1);
      const block = source.slice(start, end);
      expect(start).toBeGreaterThan(0);
      expect(block).not.toContain("runtimeRequest(");
      expect(block).toContain(verb === "export" ? "writeFileSync(resolve(target)" : "saveLocalDesktopProfile(");
    }
  });
});

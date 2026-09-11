/**
 * `ocx status` on a connected client reports the HUB's state (#4236).
 *
 * The defect was not a missing field. `ocx status` printed a complete, internally consistent,
 * entirely local report — `xai ✗ not logged in`, no grok provider, five delegable models — on a
 * machine whose hub has xAI logged in and serves grok, and an agent reading it concluded the hub
 * could not serve grok. Nothing in the output said which machine it described except one buried
 * `Remote hub: connected (<url>)` line.
 *
 * So these cases are about WHERE the reader's eye lands: the banner is the first line, the hub's
 * providers and logins print above the local ones, the local block carries a heading that says
 * it is not in use, and the lines that are genuinely about this machine are tagged `(local)`. The
 * unreachable-hub case pins the other half — the report says "state unavailable" and names the
 * reason instead of silently presenting local state as the answer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectRemoteHubStatus,
  disconnectedRemoteHubStatus,
  remoteHubBannerLine,
  remoteHubStatusLines,
  type CliRemoteHubStatus,
} from "../../src/cli/status";
import type { HubStateDTO } from "../../src/remote/hub-state";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const FIXTURE_TOKEN = "status-hub-state-token";

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";

function hubState(overrides: Partial<HubStateDTO> = {}): HubStateDTO {
  return {
    schemaVersion: 1,
    runtimeRole: "hub",
    hubVersion: "2.51.0",
    origin: "https://hub.example.test:8443",
    providers: [
      { name: "xai", adapter: "openai-chat", authMode: "oauth", hasCredential: false, disabled: false },
      { name: "openai", adapter: "openai-responses", authMode: "key", hasCredential: true, disabled: false },
    ],
    oauth: [{ provider: "xai", loggedIn: true }, { provider: "anthropic", loggedIn: false }],
    subagentModels: ["xai/grok-4.6", "gpt-5.6-sol"],
    truncated: false,
    claudeCode: { enabled: true },
    ...overrides,
  };
}

function connectedConfig(serverUrl: string) {
  return {
    port: 9,
    defaultProvider: "openai",
    providers: {},
    codexAutoStart: false,
    runtimeRole: "client",
    client: {
      serverUrl,
      managementUrl: serverUrl,
      managementTransport: "direct",
      selectedClients: ["claude"],
      tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      apiKeyId: "status-hub-state",
      tokenFingerprint: createHash("sha256").update(FIXTURE_TOKEN).digest("hex"),
      protocolVersion: 1,
      connectedAt: "2026-09-06T00:00:00.000Z",
    },
  };
}

function writeConnectedHome(home: string, serverUrl: string): void {
  writeFileSync(join(home, "config.json"), JSON.stringify(connectedConfig(serverUrl)));
  writeFileSync(join(home, "service-api-token"), FIXTURE_TOKEN, { mode: 0o600 });
}

function jsonFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-status-hub-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

describe("collectRemoteHubStatus", () => {
  test("a connected client with a live hub reports the hub's facts", async () => {
    writeConnectedHome(testHome, "https://hub.example.test:8443");
    const remoteHub = await collectRemoteHubStatus(
      { state: "connected", serverUrl: "https://hub.example.test:8443", apiKeyId: "status-hub-state", connectedAt: "2026-09-06T00:00:00.000Z" },
      { fetchImpl: jsonFetch(hubState()) },
    );
    expect(remoteHub.connected).toBe(true);
    expect(remoteHub.stateSource).toBe("hub");
    expect(remoteHub.hubVersion).toBe("2.51.0");
    expect(remoteHub.oauth).toEqual([{ provider: "xai", loggedIn: true }, { provider: "anthropic", loggedIn: false }]);
    expect(remoteHub.subagentModels).toEqual(["xai/grok-4.6", "gpt-5.6-sol"]);
    expect(remoteHub.claudeCodeEnabled).toBe(true);
  });

  test("a client whose token file is missing is unavailable, not locally sourced", async () => {
    writeFileSync(join(testHome, "config.json"), JSON.stringify(connectedConfig("https://hub.example.test:8443")));
    const remoteHub = await collectRemoteHubStatus(
      { state: "connected", serverUrl: "https://hub.example.test:8443", apiKeyId: "status-hub-state", connectedAt: "2026-09-06T00:00:00.000Z" },
      { fetchImpl: jsonFetch(hubState()) },
    );
    expect(remoteHub.stateSource).toBe("unavailable");
    expect(remoteHub.providers).toEqual([]);
    expect(remoteHub.reason).toContain("data-plane token");
  });

  test("a disconnected machine asks the hub nothing", async () => {
    const remoteHub = await collectRemoteHubStatus({ state: "disconnected" });
    expect(remoteHub).toEqual(disconnectedRemoteHubStatus());
    expect(remoteHub.connected).toBe(false);
  });
});

describe("the hub banner and block", () => {
  const live: CliRemoteHubStatus = {
    connected: true,
    origin: "https://hub.example.test:8443",
    stateSource: "hub",
    hubVersion: "2.51.0",
    providers: hubState().providers,
    oauth: hubState().oauth,
    subagentModels: hubState().subagentModels,
    truncated: false,
    claudeCodeEnabled: true,
  };

  test("a live read leads with the hub origin and says the lines are the hub's", () => {
    const banner = remoteHubBannerLine(live);
    expect(banner).toContain("State from hub https://hub.example.test:8443");
    expect(banner).toContain("not this machine's");
  });

  test("an unreachable hub names the reason and warns the lines below are local", () => {
    const banner = remoteHubBannerLine({
      ...live, stateSource: "unavailable", reason: "the hub is unreachable",
      hubVersion: null, providers: [], oauth: [], subagentModels: [], claudeCodeEnabled: null,
    });
    expect(banner).toContain("state unavailable (the hub is unreachable)");
    expect(banner).toContain("LOCAL");
  });

  test("a cached read is labelled cached with its age, not presented as live", () => {
    const banner = remoteHubBannerLine({ ...live, stateSource: "cache", ageSeconds: 42, reason: "the hub is unreachable" });
    expect(banner).toContain("cached 42s ago");
  });

  test("a standalone machine gets no banner at all", () => {
    expect(remoteHubBannerLine(disconnectedRemoteHubStatus())).toBeNull();
  });

  test("the block names the hub on every heading and explains a keyless oauth provider", () => {
    const lines = remoteHubStatusLines(live);
    expect(lines[0]).toBe("OAuth logins (hub https://hub.example.test:8443):");
    expect(lines.join("\n")).toContain("xai        ✓ logged in");
    // The exact confusion being removed: no API key on an `oauth` provider is not "unconfigured".
    expect(lines.join("\n")).toContain("no API key (authMode oauth)");
    expect(lines.join("\n")).toContain("Delegable models (hub https://hub.example.test:8443): xai/grok-4.6, gpt-5.6-sol");
    expect(lines.join("\n")).toContain("Hub version: 2.51.0");
  });

  test("a truncated hub state says so instead of presenting a prefix as the whole list", () => {
    const lines = remoteHubStatusLines({ ...live, truncated: true }).join("\n");
    expect(lines).toContain("the hub truncated this state to fit its response caps");
    // And the honest case stays quiet: a note on every report would train the reader to skip it.
    expect(remoteHubStatusLines(live).join("\n")).not.toContain("truncated");
  });

  test("no hub state means no hub block, rather than an empty one that reads as 'nothing configured'", () => {
    expect(remoteHubStatusLines({ ...live, stateSource: "unavailable", providers: [], oauth: [], subagentModels: [] })).toEqual([]);
    expect(remoteHubStatusLines(disconnectedRemoteHubStatus())).toEqual([]);
  });
});

describe("ocx status end to end on a connected client", () => {
  async function runStatus(home: string, codexHome: string, json: boolean) {
    const child = Bun.spawn([process.execPath, cliPath, "status", ...(json ? ["--json"] : [])], {
      cwd: repoRoot,
      env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codexHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test("a live hub drives the banner, the hub block and the (local) tags", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-status-hub-live-"));
    const codexHome = join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    const hub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path !== "/v1/hub-state") return new Response("not found", { status: 404 });
        // Proof the client authenticates with its own data key and nothing else.
        if (request.headers.get("x-opencodex-api-key") !== FIXTURE_TOKEN) {
          return Response.json({ error: {} }, { status: 401 });
        }
        return Response.json(hubState());
      },
    });
    try {
      const origin = `http://127.0.0.1:${hub.port}`;
      writeConnectedHome(home, origin);
      const json = await runStatus(home, codexHome, true);
      expect({ exitCode: json.exitCode, stderr: json.stderr }).toEqual({ exitCode: 0, stderr: "" });
      const parsed = JSON.parse(json.stdout);
      // Additive by rule: the two new keys must not bump the schema.
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.runtimeRole).toBe("client");
      expect(parsed.remoteHub.connected).toBe(true);
      expect(parsed.remoteHub.stateSource).toBe("hub");
      expect(parsed.remoteHub.hubVersion).toBe("2.51.0");
      expect(parsed.remoteHub.origin).toBe("https://hub.example.test:8443");
      expect(parsed.remoteHub.subagentModels).toEqual(["xai/grok-4.6", "gpt-5.6-sol"]);
      expect(parsed.remoteHub.oauth).toEqual([{ provider: "xai", loggedIn: true }, { provider: "anthropic", loggedIn: false }]);
      // `remoteHub` describes the other end of the link, so it does not disturb the link's own
      // state. `connection` itself is no longer untouched — a connected client also reports a
      // local `readiness` verdict — so this asserts the one field `remoteHub` must not perturb
      // rather than claiming the whole block is unchanged.
      expect(parsed.connection.state).toBe("connected");

      const human = await runStatus(home, codexHome, false);
      expect(human.exitCode).toBe(0);
      const lines = human.stdout.split("\n");
      expect(lines[0]).toContain("State from hub");
      // The hub's logins print ABOVE the local block, which is labelled as unused.
      const hubHeading = lines.findIndex(line => line.includes("OAuth logins (hub"));
      const localHeading = lines.findIndex(line => line.includes("Local-only (not used for routing while connected)"));
      expect(hubHeading).toBeGreaterThanOrEqual(0);
      expect(localHeading).toBeGreaterThan(hubHeading);
      expect(human.stdout).toContain("xai        ✓ logged in");
      // Lines that really are about this machine say so.
      expect(human.stdout).toMatch(/Codex runtime: .*\(local\)/);
      expect(human.stdout).toMatch(/Service: .*\(local\)/);
    } finally {
      await hub.stop(true);
      removeTreeWithRetry(home);
    }
  }, SPAWN_BUDGET_MS);

  test("an unreachable hub degrades to unavailable instead of to local state", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-status-hub-down-"));
    const codexHome = join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    try {
      // Port 1 on loopback: nothing listens, and the refusal is immediate.
      writeConnectedHome(home, "http://127.0.0.1:1");
      const json = await runStatus(home, codexHome, true);
      expect(json.exitCode).toBe(0);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.runtimeRole).toBe("client");
      expect(parsed.remoteHub.stateSource).toBe("unavailable");
      expect(parsed.remoteHub.providers).toEqual([]);
      expect(typeof parsed.remoteHub.reason).toBe("string");

      const human = await runStatus(home, codexHome, false);
      expect(human.stdout).toContain("state unavailable");
      // The local credential block is still printed, but it is explicitly not the hub's.
      expect(human.stdout).toContain("Local-only credential state");
    } finally {
      removeTreeWithRetry(home);
    }
  }, SPAWN_BUDGET_MS);

  test("a standalone machine's report gains no banner and no (local) tags", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-status-standalone-"));
    const codexHome = join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: 9, providers: {}, codexAutoStart: false }));
      const json = await runStatus(home, codexHome, true);
      expect(json.exitCode).toBe(0);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.runtimeRole).toBe("standalone");
      expect(parsed.remoteHub).toEqual({
        connected: false,
        origin: null,
        stateSource: "unavailable",
        hubVersion: null,
        providers: [],
        oauth: [],
        subagentModels: [],
        truncated: false,
        claudeCodeEnabled: null,
      });
      const human = await runStatus(home, codexHome, false);
      expect(human.stdout).not.toContain("(local)");
      expect(human.stdout).not.toContain("State from hub");
      expect(human.stdout).toContain("OAuth logins:");
    } finally {
      removeTreeWithRetry(home);
    }
  }, SPAWN_BUDGET_MS);
});

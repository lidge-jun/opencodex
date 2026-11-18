/**
 * Antigravity ACP provider through the real server (plan 080): a loopback interactive turn reaches the
 * CLI and streams its answer; a subagent turn is refused by the pipeline preflight before any spawn.
 * The CLI is a fake (tests/fixtures/agy-acp/fake-agy.ts); no real agy runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fixturePath } from "../helpers/repo-root";

let testDir = "";
let previousHome: string | undefined;
let previousBin: string | undefined;
let previousArgsFile: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let argsFile = "";

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousBin = process.env.OPENCODEX_AGY_BIN;
  previousArgsFile = process.env.AGY_FAKE_ARGS_FILE;
  isolatedCodexHome = installIsolatedCodexHome("ocx-agy-acp-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-agy-acp-server-"));
  process.env.OPENCODEX_HOME = join(testDir, "home");
  argsFile = join(testDir, "args.jsonl");
  // The child gets a scoped environment, so the launch log path is baked into the wrapper; a variable
  // set on this process would (correctly) never reach it.
  process.env.AGY_FAKE_ARGS_FILE = "must-not-reach-the-child";
  const wrapper = join(testDir, "agy");
  writeFileSync(wrapper, `#!/bin/sh
AGY_FAKE_ARGS_FILE="${argsFile}" AGY_FAKE_VERSION_FILE="${join(testDir, "version.json")}" exec "${process.execPath}" "${fixturePath("agy-acp/fake-agy.ts")}" "$@"
`);
  chmodSync(wrapper, 0o755);
  process.env.OPENCODEX_AGY_BIN = wrapper;
});

afterEach(() => {
  for (const [key, value] of [["OPENCODEX_HOME", previousHome], ["OPENCODEX_AGY_BIN", previousBin], ["AGY_FAKE_ARGS_FILE", previousArgsFile]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "antigravity-acp",
    providers: {
      "antigravity-acp": { adapter: "agy-acp", baseUrl: "https://antigravity.google/docs/cli/acp", models: ["gemini-3.8-flash", "gemini-4-argon"], liveModels: false },
    },
  } as OcxConfig;
}

const body = JSON.stringify({ model: "antigravity-acp/gemini-4-argon", stream: true, input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] });

describe.skipIf(process.platform === "win32")("antigravity-acp through the server", () => {
  test.each([
    ["old version", "1.5.0\n", 0, "found 1.5.0"],
    ["unparseable version", "unknown\n", 0, "version could not be read"],
    ["version embedded in other text", "dependency 9.9.9\n", 0, "version could not be read"],
    ["nonzero exit", "1.5.10\n", 1, "version could not be read"],
  ])("refuses %s before launching ACP", async (_case, stdout, exitCode, diagnostic) => {
    writeFileSync(join(testDir, "version.json"), JSON.stringify({ stdout, exitCode }));
    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), { method: "POST", headers: { "content-type": "application/json" }, body });
      const text = await response.text();
      const launches = readFileSync(argsFile, "utf8").trim().split("\n").map(line => JSON.parse(line).args);
      expect(launches).toEqual([["--version"]]);
      expect(text).toContain("agy_acp_unavailable");
      expect(text).toContain(diagnostic);
    } finally {
      await server.stop(true);
    }
  });

  test("a loopback interactive turn streams the CLI's answer", async () => {
    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("fake acp answer");
      expect(text).toContain("response.completed");
      const launches = readFileSync(argsFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; cwd: string });
      expect(launches.map(l => l.args)).toEqual([["--version"], ["acp", "--sandbox"]]);
      // The session ran in a private workspace, not the proxy's home or cwd.
      expect(launches[1]!.cwd).toContain("ocx-agy-acp-");
      expect(launches[1]!.cwd.startsWith(process.env.OPENCODEX_HOME!)).toBe(false);
      // Removal after the reap is asserted deterministically in tests/adapters/agy-acp-adapter.test.ts.
    } finally {
      await server.stop(true);
    }
  });

  test.each([false, true])("a local WebSocket turn is classified by its frame body (spawned=%s)", async spawned => {
    saveConfig({ ...config(), websockets: true } as OcxConfig);
    const server = startServer(0);
    try {
      const socket = new WebSocket(new URL("/v1/responses", server.url).href.replace(/^http/, "ws"));
      let received = "";
      const completed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no terminal frame")), 15_000);
        socket.onmessage = event => {
          received += String(event.data);
          const frame = JSON.parse(String(event.data)) as { type?: string };
          if (frame.type === "response.completed" || frame.type === "response.failed" || frame.type === "error") { clearTimeout(timer); resolve(); }
        };
      });
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("websocket error")); });
      const clientMetadata = spawned
        ? { "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "thread_spawn" }) }
        : undefined;
      socket.send(JSON.stringify({ ...JSON.parse(body), type: "response.create", client_metadata: clientMetadata }));
      await completed;
      socket.close();
      if (spawned) {
        expect(received).toContain("agy_acp_interactive_only");
        expect(existsSync(argsFile)).toBe(false);
      } else {
        expect(received).toContain("fake acp answer");
        expect(received).toContain("response.completed");
        expect(received).not.toContain("agy_acp_local_only");
      }
    } finally {
      await server.stop(true);
    }
  });

  test("a subagent turn is refused with a 403 before the CLI starts", async () => {
    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-parent-thread-id": "parent-thread" },
        body,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { type: "permission_error", code: "agy_acp_interactive_only" } });
      expect(existsSync(argsFile)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("a request through a declared loopback reverse proxy is not local: HTTP and WebSocket are refused before the CLI starts", async () => {
    // The operator declares that loopback connections on the public listener come from a proxy, so the
    // listener path classifies this real request as remote end to end.
    saveConfig({ ...config(), websockets: true, dashboardTrustedProxy: { origin: "https://dash.example.test", proxyAddresses: ["127.0.0.1"] } } as OcxConfig);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { type: "permission_error", code: "agy_acp_local_only" } });

      const socket = new WebSocket(new URL("/v1/responses", server.url).href.replace(/^http/, "ws"));
      let received = "";
      const ended = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no terminal frame")), 15_000);
        socket.onmessage = event => {
          received += String(event.data);
          const frame = JSON.parse(String(event.data)) as { type?: string };
          if (frame.type === "response.completed" || frame.type === "response.failed" || frame.type === "error") { clearTimeout(timer); resolve(); }
        };
      });
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("websocket error")); });
      socket.send(JSON.stringify({ type: "response.create", model: "antigravity-acp/gemini-4-argon", input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] }));
      await ended;
      socket.close();
      expect(received).toContain("agy_acp_local_only");
      expect(received).not.toContain("fake acp answer");
      expect(existsSync(argsFile)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("a same-machine reverse proxy's forwarding headers make a loopback request remote: HTTP and WebSocket", async () => {
    saveConfig({ ...config(), websockets: true } as OcxConfig);
    const server = startServer(0);
    try {
      for (const header of [{ "X-Forwarded-For": "203.0.113.9" }, { "Tailscale-User-Login": "someone@example.test" }]) {
        const response = await fetch(new URL("/v1/responses", server.url), { method: "POST", headers: { "content-type": "application/json", ...header }, body });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: "agy_acp_local_only" } });
      }
      const socket = new WebSocket(new URL("/v1/responses", server.url).href.replace(/^http/, "ws"), { headers: { "CF-Connecting-IP": "203.0.113.9" } } as unknown as string[]);
      let received = "";
      const ended = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no terminal frame")), 15_000);
        socket.onmessage = event => {
          received += String(event.data);
          const frame = JSON.parse(String(event.data)) as { type?: string };
          if (frame.type === "response.completed" || frame.type === "response.failed" || frame.type === "error") { clearTimeout(timer); resolve(); }
        };
      });
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("websocket error")); });
      socket.send(JSON.stringify({ type: "response.create", model: "antigravity-acp/gemini-4-argon", input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] }));
      await ended;
      socket.close();
      expect(received).toContain("agy_acp_local_only");
      expect(existsSync(argsFile)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
});

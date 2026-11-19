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
import { readUsageEntries } from "../../src/usage/log";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fixturePath } from "../helpers/repo-root";

let testDir = "";
let previousHome: string | undefined;
let previousBin: string | undefined;
let previousArgsFile: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let argsFile = "";

const shellLiteral = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousBin = process.env.OPENCODEX_AGY_BIN;
  previousArgsFile = process.env.AGY_FAKE_ARGS_FILE;
  isolatedCodexHome = installIsolatedCodexHome("ocx-agy-acp-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-agy-acp-server-$fixture' space-"));
  process.env.OPENCODEX_HOME = join(testDir, "home");
  argsFile = join(testDir, "args.jsonl");
  // The child gets a scoped environment, so the launch log path is baked into the wrapper; a variable
  // set on this process would (correctly) never reach it.
  process.env.AGY_FAKE_ARGS_FILE = "must-not-reach-the-child";
  const wrapper = join(testDir, "agy");
  writeFileSync(wrapper, `#!/bin/sh
AGY_FAKE_ARGS_FILE=${shellLiteral(argsFile)} AGY_FAKE_VERSION_FILE=${shellLiteral(join(testDir, "version.json"))} exec ${shellLiteral(process.execPath)} ${shellLiteral(fixturePath("agy-acp/fake-agy.ts"))} "$@"
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

const model = "antigravity-acp/gemini-4-argon";
const responsesBody = { model, stream: true, input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] };
const body = JSON.stringify(responsesBody);
const turnMetadata = "x-codex-turn-metadata";
const memoryMetadata = JSON.stringify({ request_kind: "memory" });
const spawnMetadata = JSON.stringify({ subagent_kind: "thread_spawn" });
const compactionMetadata = (trigger: "auto" | "manual") => JSON.stringify({ request_kind: "compaction", compaction: { trigger } });
const interactiveOnlyError = { error: { type: "permission_error", code: "agy_acp_interactive_only" } };

function recordedLaunches(): string[][] {
  if (!existsSync(argsFile)) return [];
  return readFileSync(argsFile, "utf8").trim().split("\n").map(line => JSON.parse(line).args);
}

const WEBSOCKET_FRAME_TIMEOUT_MS = 15_000;
const WEBSOCKET_TEST_TIMEOUT_MS = 20_000;
const terminalFrameTypes = ["response.completed", "response.failed", "error"];

async function responsesWebSocketTurn(base: string | URL, payload: unknown, headers: Record<string, string> = {}) {
  const socket = new WebSocket(new URL("/v1/responses", base).href.replace(/^http/, "ws"), { headers } as unknown as string[]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let text = "";
  try {
    return await new Promise<{ text: string; terminal: { type: string } }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("no terminal frame")), WEBSOCKET_FRAME_TIMEOUT_MS);
      socket.onerror = () => reject(new Error("websocket error"));
      socket.onclose = () => reject(new Error("websocket closed before terminal frame"));
      socket.onopen = () => {
        try { socket.send(JSON.stringify(payload)); } catch (error) { reject(error); }
      };
      socket.onmessage = event => {
        try {
          const raw = String(event.data);
          text += raw;
          const terminal = JSON.parse(raw) as { type: string };
          if (terminalFrameTypes.includes(terminal.type)) resolve({ text, terminal });
        } catch (error) { reject(error); }
      };
    });
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}

describe.skipIf(process.platform === "win32")("antigravity-acp through the server", () => {
  test.each([
    ["old version", "1.5.2\n", 0, "found 1.5.2"],
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
      expect(text).toContain("fake acp answer for gemini-4-argon");
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

  test("an interactive turn publishes one attempt for its one guarded prompt send", async () => {
    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("fake acp answer for gemini-4-argon");
    } finally {
      await server.stop(true);
    }
    const deadline = Date.now() + 5_000;
    while (readUsageEntries().length === 0 && Date.now() < deadline) await Bun.sleep(25);
    const rows = readUsageEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toEqual([
      expect.objectContaining({ ordinal: 1, adapter: "agy-acp", sendCount: 1, status: 200, recoveryKinds: [] }),
    ]);
  });

  test("buffered reasoning arrives before an answer in the final output items", async () => {
    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...JSON.parse(body.replace("hello", "fixture reasoning first")), reasoning: { summary: "auto" },
        }),
      });
      const completed = (await response.text()).split("\n").filter(line => line.startsWith("data: {"))
        .map(line => JSON.parse(line.slice("data: ".length))).find(event => event.type === "response.completed");
      expect(completed?.response.output.map((item: { type: string }) => item.type)).toEqual(["reasoning", "message"]);
      expect(completed?.response.output[0]?.summary).toEqual([{ type: "summary_text", text: "o" }]);
      expect(completed?.response.output[1]?.content).toEqual([expect.objectContaining({ type: "output_text", text: "short answer." })]);
    } finally {
      await server.stop(true);
    }
  });

  test("an ACP refusal ends Responses streaming with a non-retryable error and usage", async () => {
    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: body.replace("hello", "fixture refusal"),
      });
      expect(response.status).toBe(200);
      const terminal = (await response.text()).split("\n").filter(line => line.startsWith("data: {"))
        .map(line => JSON.parse(line.slice("data: ".length)))
        .filter(event => ["response.failed", "response.incomplete", "response.completed"].includes(event.type));
      expect(terminal).toEqual([expect.objectContaining({
        type: "response.failed",
        response: expect.objectContaining({
          status: "failed", retryable: false,
          error: expect.objectContaining({ code: "invalid_prompt" }),
          usage: expect.objectContaining({ input_tokens: 7, output_tokens: 2 }),
        }),
      })]);
      expect(recordedLaunches()).toEqual([["--version"], ["acp", "--sandbox"]]);
    } finally {
      await server.stop(true);
    }
  });

  test.each(["ordinary", "spawned", "ordinary after spawned handshake"])("a local WebSocket frame is classified by its turn metadata (%s)", async scenario => {
    const spawned = scenario === "spawned";
    const stale = scenario === "ordinary after spawned handshake";
    const spawnMetadata = JSON.stringify({ subagent_kind: "thread_spawn" });
    saveConfig({ ...config(), websockets: true } as OcxConfig);
    const server = startServer(0);
    try {
      const clientMetadata = spawned
        ? { "x-codex-turn-metadata": spawnMetadata }
        : stale ? { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "user" }) } : undefined;
      const { text: received } = await responsesWebSocketTurn(server.url, {
        ...responsesBody, type: "response.create", client_metadata: clientMetadata,
      }, stale ? { "x-codex-turn-metadata": spawnMetadata } : {});
      if (spawned) {
        expect(received).toContain("agy_acp_interactive_only");
        expect(existsSync(argsFile)).toBe(false);
      } else {
        expect(received).toContain("fake acp answer for gemini-4-argon");
        expect(received).toContain("response.completed");
        expect(received).not.toContain("agy_acp_local_only");
      }
    } finally {
      await server.stop(true);
    }
  }, WEBSOCKET_TEST_TIMEOUT_MS);

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

  for (const path of ["/v1/chat/completions", "/v1/responses/compact", "/v1/responses"]) {
    const cases: Array<[string, { headers?: Record<string, string>; metadata?: string }]> = [
      ["memgen header", { headers: { "x-openai-memgen-request": "true" } }],
      ["memory-consolidation subagent header", { headers: { "x-openai-subagent": "memory_consolidation" } }],
      ["memory metadata header", { headers: { [turnMetadata]: memoryMetadata } }],
      ["thread-spawn metadata header", { headers: { [turnMetadata]: spawnMetadata } }],
      ["automatic-compaction metadata header", { headers: { [turnMetadata]: compactionMetadata("auto") } }],
      ["memory metadata in the body", { metadata: memoryMetadata }],
      ["thread-spawn metadata in the body", { metadata: spawnMetadata }],
      ["automatic-compaction metadata in the body", { metadata: compactionMetadata("auto") }],
    ];
    test.each(cases)(`${path} refuses unattended turns before starting agy (%s)`, async (_name, { headers, metadata }) => {
      saveConfig(config());
      const server = startServer(0);
      try {
        const payload = path === "/v1/chat/completions"
          ? { model, messages: [{ role: "user", content: "hello" }] }
          : responsesBody;
        const response = await fetch(new URL(path, server.url), {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ ...payload, ...(metadata ? { client_metadata: { [turnMetadata]: metadata } } : {}) }),
        });
        const responseBody = await response.text();
        expect({ status: response.status, launches: recordedLaunches() }).toEqual({ status: 403, launches: [] });
        expect(JSON.parse(responseBody)).toMatchObject(interactiveOnlyError);
      } finally {
        await server.stop(true);
      }
    });
  }

  describe("native Chat bridges", () => {
    const geminiBody = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
    const geminiRefusal = { error: { code: 403, message: "request not permitted", status: "PERMISSION_DENIED" } };
    const ollamaRefusal = { error: "request not permitted" };
    const ingresses = [
      { path: `/v1beta/models/${model}:generateContent`, payload: geminiBody, refusal: geminiRefusal },
      { path: `/v1beta/models/${model}:streamGenerateContent?alt=sse`, payload: geminiBody, refusal: geminiRefusal },
      { path: "/api/chat", payload: { model, messages: [{ role: "user", content: "hello" }], stream: false }, refusal: ollamaRefusal },
      { path: "/api/generate", payload: { model, prompt: "hello", stream: true }, refusal: ollamaRefusal },
    ];
    const metadataCases: Array<[string, string]> = [
      ["memory", memoryMetadata],
      ["memory consolidation", JSON.stringify({ request_kind: "turn", thread_source: "memory_consolidation" })],
      ["thread spawn", spawnMetadata],
      ["automatic compaction", compactionMetadata("auto")],
    ];
    const headerCases: Array<[string, Record<string, string>]> = [
      ["memgen header", { "x-openai-memgen-request": "true" }],
      ["memory-consolidation subagent header", { "x-openai-subagent": "memory_consolidation" }],
      ["collab-spawn subagent header", { "x-openai-subagent": "collab_spawn" }],
      ["parent-thread header", { "x-codex-parent-thread-id": "parent-thread" }],
      ...metadataCases.map(([name, metadata]): [string, Record<string, string>] => [
        `${name} metadata header`, { [turnMetadata]: metadata },
      ]),
    ];

    for (const { path, payload, refusal } of ingresses) {
      const gemini = path.startsWith("/v1beta/");
      const cases: Array<{ name: string; headers: Record<string, string>; body: unknown; status: number; refusal: unknown }> =
        headerCases.map(([name, headers]) => ({ name, headers, body: payload, status: 403, refusal }));
      // Gemini accepts extra top-level fields. Ollama rejects unknown request fields before routing.
      for (const [name, metadata] of metadataCases) {
        cases.push({
          name: `${name} body metadata`,
          headers: {},
          body: { ...payload, client_metadata: { [turnMetadata]: metadata } },
          status: gemini ? 403 : 400,
          refusal: gemini ? geminiRefusal : { error: "Unsupported request field" },
        });
      }
      const send = (base: URL, body: unknown, headers: Record<string, string> = {}) => fetch(new URL(path, base), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

      test.each(cases.map(item => [item.name, item] as const))(`${path} refuses %s before any agy invocation`, async (_name, item) => {
        saveConfig(config());
        const server = startServer(0);
        try {
          const response = await send(server.url, item.body, item.headers);
          const content = await response.text();
          expect({ status: response.status, launches: recordedLaunches() }).toEqual({ status: item.status, launches: [] });
          expect(JSON.parse(content)).toEqual(item.refusal);
        } finally {
          await server.stop(true);
        }
      });

      test(`${path} reaches agy for an interactive request`, async () => {
        saveConfig(config());
        const server = startServer(0);
        try {
          const response = await send(server.url, payload, {
            [turnMetadata]: JSON.stringify({ request_kind: "turn", thread_source: "user" }),
          });
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("fake acp answer for gemini-4-argon");
          expect(recordedLaunches()).toEqual([["--version"], ["acp", "--sandbox"]]);
        } finally {
          await server.stop(true);
        }
      });
    }
  });

  test("Responses WebSocket refuses frame-local automatic compaction before starting agy", async () => {
    saveConfig({ ...config(), websockets: true } as OcxConfig);
    const server = startServer(0);
    try {
      const { terminal } = await responsesWebSocketTurn(server.url, {
        ...responsesBody,
        type: "response.create",
        input: [...responsesBody.input, { type: "compaction_trigger" }],
        client_metadata: { [turnMetadata]: compactionMetadata("auto") },
      });
      expect(terminal).toMatchObject({ type: "error", status: 403, ...interactiveOnlyError });
      expect(recordedLaunches()).toEqual([]);
    } finally {
      await server.stop(true);
    }
  }, WEBSOCKET_TEST_TIMEOUT_MS);

  test("an unattended ACP Compact refusal never opens its reasoning archive", async () => {
    saveConfig({ ...config(), reasoningRetention: { enabled: true, maxTokens: 1 } });
    const archive = join(testDir, "home", "reasoning-archive");
    writeFileSync(archive, "fixture blocks archive creation");
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses/compact", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", [turnMetadata]: compactionMetadata("auto") },
        body: JSON.stringify({ ...responsesBody, input: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "fixture history ".repeat(100) }] },
          ...responsesBody.input,
        ] }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject(interactiveOnlyError);
      expect(readFileSync(archive, "utf8")).toBe("fixture blocks archive creation");
      expect(recordedLaunches()).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("Chat preserves the ACP locality refusal code for a relayed request", async () => {
    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { type: "permission_error", code: "agy_acp_local_only" } });
      expect(recordedLaunches()).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("routed manual compaction runs and returns the ACP summary", async () => {
    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses/compact", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", [turnMetadata]: compactionMetadata("manual") },
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("fake acp answer for gemini-4-argon");
      expect(recordedLaunches()).toEqual([["--version"], ["acp", "--sandbox"]]);
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

      const { text: received } = await responsesWebSocketTurn(server.url, {
        ...responsesBody, type: "response.create",
      });
      expect(received).toContain("agy_acp_local_only");
      expect(received).not.toContain("fake acp answer");
      expect(existsSync(argsFile)).toBe(false);
    } finally {
      await server.stop(true);
    }
  }, WEBSOCKET_TEST_TIMEOUT_MS);

  test("a same-machine reverse proxy's forwarding headers make a loopback request remote: HTTP and WebSocket", async () => {
    saveConfig({ ...config(), websockets: true } as OcxConfig);
    const server = startServer(0);
    try {
      for (const header of [{ "X-Forwarded-For": "203.0.113.9" }, { "Tailscale-User-Login": "someone@example.test" }]) {
        const response = await fetch(new URL("/v1/responses", server.url), { method: "POST", headers: { "content-type": "application/json", ...header }, body });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: "agy_acp_local_only" } });
      }
      const { text: received } = await responsesWebSocketTurn(server.url, {
        ...responsesBody, type: "response.create",
      }, { "CF-Connecting-IP": "203.0.113.9" });
      expect(received).toContain("agy_acp_local_only");
      expect(existsSync(argsFile)).toBe(false);
    } finally {
      await server.stop(true);
    }
  }, WEBSOCKET_TEST_TIMEOUT_MS);
});

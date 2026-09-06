import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import {
  GO_SIDECAR_BIN_ENV,
  activeGoSidecarBaseUrl,
  resetGoSidecarForTests,
} from "../src/server/go-sidecar";
import { HOT_PATH_RELAY_ENV, HOT_PATH_SEAM_ENV } from "../src/server/hot-path-seam";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * Non-streaming direct-relay differential for ticket #27 (devlog 036). With
 * the seam gate on and the relay gate off the sidecar's only data-plane
 * source is the private parent bridge; with both gates on a relay-safe
 * non-streaming request is answered DIRECTLY upstream by the Go sidecar
 * (status/content-type/retry-after/body, with the field backfill applied),
 * and everything else still takes the bridge.
 *
 * The two paths are told apart by the User-Agent the fixture upstream sees:
 * the Go http client sends `Go-http-client/1.1` and the in-process Bun fetch
 * does not. The client-visible bytes are the real assertion: server A runs
 * the pipeline in-process (the oracle), server B runs the same matrix with
 * the relay armed, and each response must match A byte-for-byte — sparse
 * upstream bodies included, because both sides repair them identically.
 *
 * Skipped where the Go toolchain is unavailable, like the #24 harness.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function goToolchainAvailable(): boolean {
  const probe = Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" });
  return probe.success;
}

function buildSidecarBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-sidecar-relay-"));
  const binPath = join(dir, process.platform === "win32" ? "ocx-sidecar.exe" : "ocx-sidecar");
  const build = Bun.spawnSync(
    ["go", "build", "-o", binPath, "./cmd/ocx-sidecar"],
    {
      cwd: join(repoRoot, "go"),
      env: { ...process.env, CGO_ENABLED: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (build.exitCode !== 0) {
    throw new Error(
      `go build ./cmd/ocx-sidecar failed (${build.exitCode}):\n${new TextDecoder().decode(build.stderr)}`,
    );
  }
  return binPath;
}

const goAvailable = goToolchainAvailable();
const sidecarBinary: string | null = goAvailable ? buildSidecarBinary() : null;

let upstream: ReturnType<typeof Bun.serve> | null = null;

interface RelayCase {
  name: string;
  body: unknown;
  direct: boolean;
}

const fnTool = {
  type: "function",
  name: "calc",
  description: "do arithmetic",
  parameters: { type: "object", properties: { x: { type: "number" } } },
};

const sparseMessage = (id: string, text: string) =>
  JSON.stringify({
    id,
    object: "response",
    status: "completed",
    model: "test-model",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
  });

const sparseMultiItem = JSON.stringify({
  id: "resp_tools",
  object: "response",
  status: "completed",
  output: [
    { type: "message", id: "msg_0", content: [{ type: "output_text", text: "calling the tool" }] },
    { type: "function_call", name: "calc", arguments: '{"x":1}' },
  ],
});

const relayCases: RelayCase[] = [
  { name: "plain", body: { model: "test-model", input: "plain" }, direct: true },
  {
    name: "tools",
    body: {
      model: "test-model",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "calc" }] }],
      tools: [fnTool],
    },
    direct: true,
  },
  { name: "reasoning", body: { model: "test-model", input: "reasoning", reasoning: { effort: "low" } }, direct: true },
  // An unlisted model falls back to defaultProvider, which is still the one
  // relay-safe provider: TS forwards it verbatim and so does the relay.
  { name: "default-provider", body: { model: "unlisted-model", input: "default" }, direct: true },
];

const streamCase: RelayCase = {
  name: "streaming-relays-directly",
  body: { model: "test-model", input: "stream", stream: true },
  direct: true,
};

const streamUpstreamReply =
  "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"fixture-s\",\"status\":\"in_progress\"}}\n\n" +
  "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\n\n" +
  "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\n\n" +
  "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"fixture-s\",\"status\":\"completed\"}}\n\n";

/** Stable sparse upstream reply per case marker, keyed by parsed input. */
function nonStreamReply(raw: string): string {
  let parsed: { input?: unknown; stream?: boolean } = {};
  try {
    parsed = JSON.parse(raw) as { input?: unknown; stream?: boolean };
  } catch {
    // fall through to the default reply
  }
  const replies: Record<string, string> = {
    plain: sparseMessage("resp_plain", "plain reply"),
    tools: sparseMultiItem,
    reasoning: sparseMessage("resp_reasoning", "low effort reply"),
    default: sparseMessage("resp_default", "default reply"),
  };
  const key = Array.isArray(parsed.input) ? "tools" : String(parsed.input ?? "");
  return replies[key] ?? sparseMessage("resp_other", "other");
}

interface UpstreamLog {
  ua: string;
  method: string;
  path: string;
  contentType: string | null;
  authorization: string | null;
  apiKey: string | null;
  providerHeader: string | null;
}

const upstreamLogs: UpstreamLog[] = [];

interface ResponseCapture {
  status: number;
  contentType: string | null;
  body: string;
}

function configFixture(upstreamPort: number, providerOverrides: Record<string, unknown> = {}) {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        disabled: false,
        models: ["test-model"],
        ...providerOverrides,
      },
    },
  };
}

const GO_UA = "Go-http-client/1.1";

async function postCase(
  server: { url: URL },
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<ResponseCapture> {
  const response = await fetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencodex-api-key": token, ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

const previousEnv: Record<string, string | undefined> = {};
let testHome = "";

function captureEnv(): void {
  for (const name of [GO_SIDECAR_BIN_ENV, HOT_PATH_SEAM_ENV, HOT_PATH_RELAY_ENV, "OPENCODEX_HOME", "OPENCODEX_API_AUTH_TOKEN"]) {
    previousEnv[name] = process.env[name];
  }
}

function setUpFixture(
  upstreamPort: number,
  providerOverrides?: Record<string, unknown>,
  configure?: (config: Record<string, unknown>) => void,
): void {
  testHome = mkdtempSync(join(tmpdir(), "ocx-hotpath-relay-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  const fixture = configFixture(upstreamPort, providerOverrides) as Record<string, unknown>;
  configure?.(fixture);
  saveConfig(fixture as Parameters<typeof saveConfig>[0]);
}

function tearDownFixture(): void {
  resetGoSidecarForTests();
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (testHome) {
    removeTreeWithRetry(testHome);
    testHome = "";
  }
}

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await Bun.sleep(50);
  }
}

function runFixtureTest(name: string, fn: () => Promise<void>): void {
  test(
    name,
    async () => {
      captureEnv();
      try {
        await fn();
      } finally {
        tearDownFixture();
      }
    },
    SERVER_BUDGET_MS,
  );
}

describe.skipIf(!goAvailable || sidecarBinary === null)("ocx-sidecar non-streaming relay differential (ADR-0008, ticket #27)", () => {
  beforeAll(() => {
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname !== "/v1/responses") return new Response("nf", { status: 404 });
        upstreamLogs.push({
          ua: req.headers.get("user-agent") ?? "",
          method: req.method,
          path: new URL(req.url).pathname,
          contentType: req.headers.get("content-type"),
          authorization: req.headers.get("authorization"),
          apiKey: req.headers.get("api-key"),
          providerHeader: req.headers.get("x-provider-batch"),
        });
        // The upstream body is the same bytes whichever path reached it (the
        // relay forwards the seam body verbatim, the bridge forwards the
        // in-process body verbatim), so the reply is keyed off markers the
        // cases carry distinctly.
        const raw = await req.text();
        let parsed: { input?: unknown; stream?: boolean } = {};
        try {
          parsed = JSON.parse(raw) as { input?: unknown; stream?: boolean };
        } catch {
          // fall through to the default reply
        }
        if (parsed.stream === true) {
          return new Response(streamUpstreamReply, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(nonStreamReply(raw), { headers: { "content-type": "application/json" } });
      },
    });
  });
  afterAll(() => {
    upstream?.stop(true);
    upstream = null;
  });

  test("the relay env gate is a declared constant", () => {
    expect(HOT_PATH_RELAY_ENV).toBe("OPENCODEX_GO_HOTPATH_RELAY");
  });

  runFixtureTest("armed relay answers relay-safe requests byte-identically and direct", async () => {
    const token = "data-secret";
    const port = upstream!.port;
    const allCases = [...relayCases, streamCase];

    // Server A: in-process pipeline, the oracle.
    setUpFixture(port);
    const serverA = startServer(0);
    const tsCaptures: ResponseCapture[] = [];
    try {
      for (const c of allCases) {
        tsCaptures.push(await postCase(serverA, token, c.body));
      }
    } finally {
      await serverA.stop(true);
    }
    // The oracle itself must have hit the fixture upstream through Bun, never
    // through a Go http client.
    expect(upstreamLogs.slice(0, allCases.length).every((log) => log.ua !== GO_UA)).toBe(true);

    // Server B: seam on AND relay on.
    process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
    process.env[HOT_PATH_SEAM_ENV] = "1";
    process.env[HOT_PATH_RELAY_ENV] = "1";
    const serverB = startServer(0);
    const goCaptures: ResponseCapture[] = [];
    try {
      await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
      for (const c of allCases) {
        goCaptures.push(await postCase(serverB, token, c.body));
      }
    } finally {
      await serverB.stop(true);
    }

    for (let i = 0; i < allCases.length; i++) {
      const c = allCases[i]!;
      expect(goCaptures[i]!.status, `${c.name} status`).toBe(tsCaptures[i]!.status);
      expect(goCaptures[i]!.contentType, `${c.name} content-type`).toBe(tsCaptures[i]!.contentType);
      expect(goCaptures[i]!.body, `${c.name} body must match the in-process oracle`).toBe(tsCaptures[i]!.body);
    }

    // Path proof: the fixture upstream must have seen the Go http client for
    // every relay-admitted case, including the narrow stream subset.
    const goLogs = upstreamLogs.slice(allCases.length);
    expect(goLogs.length).toBe(allCases.length);
    for (let i = 0; i < allCases.length; i++) {
      const c = allCases[i]!;
      if (c.direct) {
        expect(goLogs[i]!.ua, `${c.name} should be a direct Go relay`).toBe(GO_UA);
      } else {
        expect(goLogs[i]!.ua, `${c.name} should stay on the bridge`).not.toBe(GO_UA);
      }
    }
    // The upstream outbound path is the canonical responses URL every time.
    expect(goLogs.every((log) => log.method === "POST" && log.path === "/v1/responses")).toBe(true);
    // Non-vacuous: the client-visible bytes really were repaired by whoever
    // answered. The tools fixture already carries a message id, so its
    // synthesized id names the function_call item at output index 1; every
    // other sparse fixture synthesizes msg_ocx_0.
    for (let i = 0; i < relayCases.length; i++) {
      const name = relayCases[i]!.name;
      const id = name === "tools" ? '"id":"fc_ocx_1"' : "msg_ocx_0";
      expect(goCaptures[i]!.body, `${name} id backfill`).toContain(id);
      expect(goCaptures[i]!.body, `${name} annotations backfill`).toContain('"annotations":[]');
    }
    expect(activeGoSidecarBaseUrl()).toBeNull();
  });

  runFixtureTest("relay gate off keeps the bridge for every request", async () => {
    const token = "data-secret";
    const port = upstream!.port;
    const cases = relayCases;

    setUpFixture(port);
    const serverA = startServer(0);
    const tsCaptures: ResponseCapture[] = [];
    try {
      for (const c of cases) tsCaptures.push(await postCase(serverA, token, c.body));
    } finally {
      await serverA.stop(true);
    }
    const aStart = upstreamLogs.length;

    // Server C: seam on, relay gate OFF. Every request must reach the
    // upstream through the Bun bridge.
    process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
    process.env[HOT_PATH_SEAM_ENV] = "1";
    delete process.env[HOT_PATH_RELAY_ENV];
    const serverC = startServer(0);
    const bridgeCaptures: ResponseCapture[] = [];
    try {
      await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
      for (const c of cases) bridgeCaptures.push(await postCase(serverC, token, c.body));
    } finally {
      await serverC.stop(true);
    }

    const cLogs = upstreamLogs.slice(aStart);
    expect(cLogs.length).toBe(cases.length);
    for (let i = 0; i < cases.length; i++) {
      expect(cLogs[i]!.ua, `${cases[i]!.name} must take the bridge with the relay gate off`).not.toBe(GO_UA);
      expect(bridgeCaptures[i]!.status, `${cases[i]!.name} status`).toBe(tsCaptures[i]!.status);
      expect(bridgeCaptures[i]!.body, `${cases[i]!.name} body must match the oracle`).toBe(tsCaptures[i]!.body);
    }
  });

  runFixtureTest("provider adapter matrix matches the TS oracle and proves direct Go ownership", async () => {
    const token = "data-secret";
    const port = upstream!.port;
    const cases = [
      {
        name: "openai-responses",
        provider: {
          apiKey: "responses-key",
          headers: { "api-key": "static-key", "X-Provider-Batch": "responses" },
        },
        authorization: "Bearer responses-key",
        apiKey: "static-key",
        providerHeader: "responses",
      },
      ...(["azure", "azure-openai"] as const).map(adapter => ({
        name: adapter,
        provider: {
          adapter,
          apiKey: "azure-key",
          headers: { "api-key": "static-key", "X-Provider-Batch": adapter },
        },
        authorization: null,
        apiKey: "azure-key",
        providerHeader: adapter,
      })),
    ];

    for (const fixture of cases) {
      // Server A is the TypeScript adapter oracle for this exact provider row.
      resetGoSidecarForTests();
      delete process.env[GO_SIDECAR_BIN_ENV];
      delete process.env[HOT_PATH_SEAM_ENV];
      delete process.env[HOT_PATH_RELAY_ENV];
      setUpFixture(port, fixture.provider);
      const serverA = startServer(0);
      let tsCapture: ResponseCapture;
      const oracleStart = upstreamLogs.length;
      try {
        tsCapture = await postCase(serverA, token, { model: "test-model", input: "plain" });
      } finally {
        await serverA.stop(true);
      }
      const oracleLog = upstreamLogs[oracleStart]!;
      expect(oracleLog.ua, fixture.name + " oracle must use Bun").not.toBe(GO_UA);

      // Server B uses the same persisted row with the hot-path relay armed.
      process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
      process.env[HOT_PATH_SEAM_ENV] = "1";
      process.env[HOT_PATH_RELAY_ENV] = "1";
      const serverB = startServer(0);
      const relayStart = upstreamLogs.length;
      let goCapture: ResponseCapture;
      try {
        await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
        goCapture = await postCase(serverB, token, { model: "test-model", input: "plain" });
      } finally {
        await serverB.stop(true);
        resetGoSidecarForTests();
      }
      const goLog = upstreamLogs[relayStart]!;

      expect(goCapture!.status, fixture.name + " status").toBe(tsCapture!.status);
      expect(goCapture!.contentType, fixture.name + " content-type").toBe(tsCapture!.contentType);
      expect(goCapture!.body, fixture.name + " client bytes").toBe(tsCapture!.body);
      expect(goLog.ua, fixture.name + " must be Go-owned").toBe(GO_UA);
      expect(goLog.method).toBe(oracleLog.method);
      expect(goLog.path).toBe(oracleLog.path);
      expect(goLog.contentType).toBe(oracleLog.contentType);
      expect(goLog.authorization).toBe(fixture.authorization);
      expect(goLog.apiKey).toBe(fixture.apiKey);
      expect(goLog.providerHeader).toBe(fixture.providerHeader);
      expect(goLog.authorization).toBe(oracleLog.authorization);
      expect(goLog.apiKey).toBe(oracleLog.apiKey);
      expect(goLog.providerHeader).toBe(oracleLog.providerHeader);
    }
  });

  runFixtureTest("every remaining relay refusal stays byte-identical on the TypeScript bridge", async () => {
    const token = "data-secret";
    const port = upstream!.port;
    type RefusalCase = {
      name: string;
      body: unknown;
      provider?: Record<string, unknown>;
      headers?: Record<string, string>;
      configure?: (config: Record<string, unknown>) => void;
    };
    const cases: RefusalCase[] = [
      {
        name: "combos use the TypeScript picker",
        body: { model: "test-model", input: "plain" },
        configure: config => {
          config.combos = { only: { targets: [{ provider: "test", model: "test-model" }] } };
        },
      },
      {
        name: "routing profiles use the TypeScript policy engine",
        body: { model: "test-model", input: "plain" },
        configure: config => {
          config.routingProfiles = { only: { candidates: [{ provider: "test", model: "test-model" }] } };
        },
      },
      {
        name: "blocked model redirects rewrite before routing",
        body: { model: "blocked", input: "plain" },
        configure: config => { config.blockedModelRedirects = { blocked: "test-model" }; },
      },
      {
        name: "shadow intercept rewrites before routing",
        body: { model: "source-model", input: "plain" },
        configure: config => {
          config.shadowCallIntercept = { enabled: true, model: "test-model", sourceModels: ["source-model"] };
        },
      },
      { name: "oauth providers remain on the TypeScript credential path", body: { model: "test-model", input: "plain" }, provider: { authMode: "oauth" } },
      { name: "keychain API keys remain on the TypeScript credential path", body: { model: "test-model", input: "plain" }, provider: { apiKey: "keychain:relay-differential" } },
      { name: "custom responses paths remain on the TypeScript adapter path", body: { model: "test-model", input: "plain" }, provider: { responsesPath: "/custom-responses" } },
      { name: "stateless streaming responses keep TypeScript stream repair", body: { model: "test-model", input: "stream", stream: true }, provider: { statelessResponses: true } },
      { name: "reasoning-preserving streams keep TypeScript stream repair", body: { model: "test-model", input: "stream", stream: true }, provider: { preserveReasoningContentModels: ["test-model"] } },
      {
        name: "reserved OpenAI family rows remain on the native TypeScript path",
        body: { model: "test-model", input: "plain" },
        configure: config => {
          const providers = config.providers as Record<string, unknown>;
          providers.openai = providers.test!;
          delete providers.test;
          config.defaultProvider = "openai";
        },
      },
      { name: "grok surface remains on the TypeScript surface path", body: { model: "test-model", input: "plain" }, headers: { "x-opencodex-grok": "1" } },
      { name: "compaction markers remain on the TypeScript compaction path", body: { model: "test-model", input: "plain", compaction_trigger: true } },
      {
        name: "encrypted input remains on the TypeScript encrypted-payload path",
        body: { model: "test-model", input: [{ type: "message", role: "user", encrypted_content: "ciphertext" }] },
      },
      { name: "namespaced model selectors remain on the TypeScript router", body: { model: "test/test-model", input: "plain" } },
      { name: "previous response continuations remain on the TypeScript state path", body: { model: "test-model", input: "plain", previous_response_id: "resp_unknown" } },
      {
        name: "namespaced tools remain on the TypeScript tool bridge",
        body: { model: "test-model", input: "plain", tools: [{ type: "function", name: "calc", namespace: "mcp" }] },
      },
    ];

    for (const fixture of cases) {
      resetGoSidecarForTests();
      delete process.env[GO_SIDECAR_BIN_ENV];
      delete process.env[HOT_PATH_SEAM_ENV];
      delete process.env[HOT_PATH_RELAY_ENV];
      setUpFixture(port, fixture.provider, fixture.configure);

      const oracleStart = upstreamLogs.length;
      const serverA = startServer(0);
      let oracle: ResponseCapture;
      try {
        oracle = await postCase(serverA, token, fixture.body, fixture.headers);
      } finally {
        await serverA.stop(true);
      }
      const oracleLogs = upstreamLogs.slice(oracleStart);
      expect(oracleLogs.every(log => log.ua !== GO_UA), fixture.name + " oracle uses Bun").toBe(true);

      process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
      process.env[HOT_PATH_SEAM_ENV] = "1";
      process.env[HOT_PATH_RELAY_ENV] = "1";
      const relayStart = upstreamLogs.length;
      const serverB = startServer(0);
      let armed: ResponseCapture;
      try {
        await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
        armed = await postCase(serverB, token, fixture.body, fixture.headers);
      } finally {
        await serverB.stop(true);
        resetGoSidecarForTests();
      }
      const armedLogs = upstreamLogs.slice(relayStart);

      expect(armed!.status, fixture.name + " status").toBe(oracle!.status);
      expect(armed!.contentType, fixture.name + " content-type").toBe(oracle!.contentType);
      expect(armed!.body, fixture.name + " client bytes").toBe(oracle!.body);
      // Every fixture above intentionally exercises a refusal predicate. If it
      // reaches an upstream, that request must still be sent by Bun through
      // the parent bridge rather than directly by the Go relay. Some credential
      // and encrypted fixtures fail before an upstream call, which is equally
      // valid evidence of bridge ownership.
      expect(armedLogs.every(log => log.ua !== GO_UA), fixture.name + " must not be Go-owned").toBe(true);
    }
  });
});

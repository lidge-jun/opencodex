import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync } from "node:fs";
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
 * End-to-end differential for ticket #29's direct streaming relay. Every
 * input comes from the committed Responses SSE corpus: server A is the TS
 * oracle, server B is the armed Go relay, and server C proves a stream-time
 * provider feature returns to the Bun bridge. The fixture observes the
 * upstream User-Agent, while clients compare the exact SSE bytes.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface ResponsesSSEGolden {
  name: string;
  upstream: string;
  client: string;
  status: number;
  contentType: string;
  upstreamBody: string;
}

const goldens = JSON.parse(
  readFileSync(join(repoRoot, "go/internal/sidecar/testdata/responses-sse-goldens.json"), "utf8"),
) as ResponsesSSEGolden[];

if (goldens.length === 0) throw new Error("Responses SSE golden corpus must not be empty");

function goToolchainAvailable(): boolean {
  const probe = Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" });
  return probe.success;
}

function buildSidecarBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-sidecar-stream-relay-"));
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
const GO_UA = "Go-http-client/1.1";

interface UpstreamLog {
  ua: string;
  method: string;
  path: string;
  contentType: string | null;
  body: string;
}

interface ResponseCapture {
	status: number;
	contentType: string | null;
	body: string;
	chunks: string[];
}

const upstreamLogs: UpstreamLog[] = [];
let upstream: ReturnType<typeof Bun.serve> | null = null;
const previousEnv: Record<string, string | undefined> = {};
let testHome = "";

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

async function postCase(server: { url: URL }, token: string, body: string): Promise<ResponseCapture> {
  const response = await fetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencodex-api-key": token },
    body,
  });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) chunks.push(tail);
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body: chunks.join(""), chunks };
}

function splitSseFrames(body: string): string[] {
  return body.split(/(?<=\n\n)|(?<=\n\r\n)|(?<=\r\n\n)|(?<=\r\n\r\n)/).filter(Boolean);
}

function streamFixture(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 7, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
      // Split each corpus event through real network-facing pulls rather than
      // treating a fixture string as one transport chunk.
      await Bun.sleep(1);
    },
  });
}

function captureEnv(): void {
  for (const name of [GO_SIDECAR_BIN_ENV, HOT_PATH_SEAM_ENV, HOT_PATH_RELAY_ENV, "OPENCODEX_HOME", "OPENCODEX_API_AUTH_TOKEN"]) {
    previousEnv[name] = process.env[name];
  }
}

function setUpFixture(upstreamPort: number, providerOverrides?: Record<string, unknown>): void {
  testHome = mkdtempSync(join(tmpdir(), "ocx-hotpath-stream-relay-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  saveConfig(configFixture(upstreamPort, providerOverrides));
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
  test(name, async () => {
    captureEnv();
    try {
      await fn();
    } finally {
      tearDownFixture();
    }
  }, SERVER_BUDGET_MS);
}

describe.skipIf(!goAvailable || sidecarBinary === null)("ocx-sidecar streaming relay differential (ADR-0008, ticket #29)", () => {
  beforeAll(() => {
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname !== "/v1/responses") return new Response("nf", { status: 404 });
        const body = await req.text();
        upstreamLogs.push({
          ua: req.headers.get("user-agent") ?? "",
          method: req.method,
          path: new URL(req.url).pathname,
          contentType: req.headers.get("content-type"),
          body,
        });
        const golden = goldens.find((row) => row.upstreamBody === body);
        if (!golden) return new Response("unknown SSE golden request", { status: 400 });
        return new Response(streamFixture(golden.upstream), { status: golden.status, headers: { "content-type": golden.contentType } });
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

  runFixtureTest("armed relay matches every Responses SSE golden and sends them direct", async () => {
    const token = "data-secret";
    const port = upstream!.port;

    // Server A: the in-process TS oracle.
    setUpFixture(port);
    const serverA = startServer(0);
    const tsCaptures: ResponseCapture[] = [];
    try {
      for (const golden of goldens) tsCaptures.push(await postCase(serverA, token, golden.upstreamBody));
    } finally {
      await serverA.stop(true);
    }
    const tsLogs = upstreamLogs.slice(-goldens.length);
    expect(tsLogs).toHaveLength(goldens.length);
    for (let index = 0; index < goldens.length; index++) {
      const golden = goldens[index]!;
      const capture = tsCaptures[index]!;
      expect(tsLogs[index]!.ua, `${golden.name} oracle path`).not.toBe(GO_UA);
      expect(tsLogs[index]!.body, `${golden.name} oracle request bytes`).toBe(golden.upstreamBody);
      expect(capture.status, `${golden.name} oracle status`).toBe(golden.status);
      expect(capture.contentType, `${golden.name} oracle content type`).toBe(golden.contentType);
      expect(capture.body, `${golden.name} oracle must match its committed SSE golden`).toBe(golden.client);
    }

    // Server B: seam and streaming relay armed. Its upstream user agent is
    // the direct-path proof; client-visible bytes must stay identical to A.
    process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
    process.env[HOT_PATH_SEAM_ENV] = "1";
    process.env[HOT_PATH_RELAY_ENV] = "1";
    const serverB = startServer(0);
    const goCaptures: ResponseCapture[] = [];
    try {
      await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
      for (const golden of goldens) goCaptures.push(await postCase(serverB, token, golden.upstreamBody));
    } finally {
      await serverB.stop(true);
    }
    const goLogs = upstreamLogs.slice(-goldens.length);
    expect(goLogs).toHaveLength(goldens.length);
    for (let index = 0; index < goldens.length; index++) {
      const golden = goldens[index]!;
      const capture = goCaptures[index]!;
      expect(goLogs[index]!.ua, `${golden.name} must be a direct Go relay`).toBe(GO_UA);
      expect(goLogs[index]!.method, `${golden.name} method`).toBe("POST");
      expect(goLogs[index]!.path, `${golden.name} path`).toBe("/v1/responses");
      expect(goLogs[index]!.contentType, `${golden.name} content type`).toBe("application/json");
      expect(goLogs[index]!.body, `${golden.name} direct request bytes`).toBe(golden.upstreamBody);
      expect(capture.status, `${golden.name} direct status`).toBe(tsCaptures[index]!.status);
      expect(capture.contentType, `${golden.name} direct content type`).toBe(tsCaptures[index]!.contentType);
      expect(capture.body, `${golden.name} direct bytes must match the TS oracle`).toBe(tsCaptures[index]!.body);
      expect(splitSseFrames(capture.body), `${golden.name} direct frame sequence`).toEqual(splitSseFrames(tsCaptures[index]!.body));
      expect(capture.chunks.length, `${golden.name} client observed stream output`).toBeGreaterThan(0);
    }

    // These rows exercise stream repair. If the upstream bytes already equal
    // the client bytes, equality above would not prove the rewriter ran.
    for (const golden of goldens) {
      expect(golden.client, `${golden.name} must contain a non-vacuous mutation`).not.toBe(golden.upstream);
      const frames = splitSseFrames(golden.client);
      expect(frames.length, `${golden.name} has multiple ordered client frames`).toBeGreaterThan(1);
      expect(frames.slice(1).join(""), `${golden.name} dropping a frame differs`).not.toBe(golden.client);
      expect([...frames].reverse().join(""), `${golden.name} reordering frames differs`).not.toBe(golden.client);
      expect([...frames, frames[0]!].join(""), `${golden.name} duplicating a frame differs`).not.toBe(golden.client);
    }

    // Server C: this enabled stream-time repair is deliberately outside the
    // direct relay subset, so the same requests must return through Bun.
    saveConfig(configFixture(port, { responsesItemIdRepair: { repairInvalidIds: true } }));
    const serverC = startServer(0);
    try {
      await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
      for (const golden of goldens) await postCase(serverC, token, golden.upstreamBody);
    } finally {
      await serverC.stop(true);
    }
    const fallbackLogs = upstreamLogs.slice(-goldens.length);
    expect(fallbackLogs).toHaveLength(goldens.length);
    for (let index = 0; index < goldens.length; index++) {
      const golden = goldens[index]!;
      expect(fallbackLogs[index]!.ua, `${golden.name} config gate must use the Bun bridge`).not.toBe(GO_UA);
      expect(fallbackLogs[index]!.body, `${golden.name} fallback request bytes`).toBe(golden.upstreamBody);
    }
    expect(activeGoSidecarBaseUrl()).toBeNull();
  });
});

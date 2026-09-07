import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * Live-provider hot-path differential (ticket #34).
 *
 * The fixture-upstream suites (go-hotpath-relay, go-hotpath-relay-streaming)
 * prove byte parity against replies this repo fabricates. This suite closes
 * the remaining gap: the same differential run against a REAL provider
 * gateway, so both implementations are exercised on responses neither was
 * tuned to. The gateway serves the OpenAI Responses wire format
 * (`/v1/responses`, SSE streaming included).
 *
 * Real responses are non-deterministic where fixture replies are not:
 * response/item ids, timestamps, token usage, and encrypted reasoning blobs
 * differ on every call. The differential therefore compares each capture
 * after normalising exactly those declared-volatile fields — everything else
 * (event types, item ordering, output text, status, content types) must be
 * identical between the TypeScript oracle and the armed Go relay.
 *
 * The id fold is defensive rather than evidence-bearing: the plain backfill
 * path mints deterministic, scope-less `msg_ocx_<index>` ids on both sides,
 * and this suite never arms stateful item-id repair (stream-time repairs are
 * gated to the Bun bridge, so arming would break the UA path-ownership claim),
 * so the scoped-id branch (`msg_ocx_<scope>_<index>` → `msg_ocx_SCOPE_<index>`)
 * only fires for a future Responses-compatible gateway that serves scoped ids
 * while armed. The stateful-repair scope bytes themselves (TypeScript randomUUID
 * vs Go crypto/rand hex) are contractually compared elsewhere — by
 * deepseek-responses-item-id-repair.test.ts and the go-hotpath-relay tools
 * case — not by this suite (#31 note).
 *
 * The upstream User-Agent still proves path ownership: the TS oracle must
 * never present Go's client UA, and relay-admitted requests must.
 *
 * Opt-in by reachability: the suite skips entirely when the gateway (or the
 * Go toolchain) is unavailable, so CI environments without the LAN gateway
 * lose nothing. Point OCX_LIVE_GATEWAY_URL at any Responses-compatible
 * upstream to run it elsewhere.
 */

const gatewayBase = (process.env.OCX_LIVE_GATEWAY_URL ?? "http://127.0.0.1:20100").replace(/\/+$/, "");
const gatewayModel = process.env.OCX_LIVE_GATEWAY_MODEL ?? "glm-5.3-flash";
const gatewayApiKey = process.env.OCX_LIVE_GATEWAY_KEY ?? "";
const GO_UA = "Go-http-client/1.1";

async function gatewayReachable(): Promise<boolean> {
  try {
    const response = await fetch(new URL("/v1/models", gatewayBase), {
      signal: AbortSignal.timeout(3_000),
      headers: gatewayApiKey ? { authorization: `Bearer ${gatewayApiKey}` } : {},
    });
    return response.ok;
  } catch {
    return false;
  }
}

function goToolchainAvailable(): boolean {
  return Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).success;
}

function buildSidecarBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-sidecar-live-"));
  const binPath = join(dir, process.platform === "win32" ? "ocx-sidecar.exe" : "ocx-sidecar");
  const build = Bun.spawnSync(
    ["go", "build", "-o", binPath, "./cmd/ocx-sidecar"],
    {
      cwd: join(import.meta.dir, "..", "go"),
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
const live = goAvailable ? await gatewayReachable() : false;
const sidecarBinary = goAvailable && live ? buildSidecarBinary() : null;

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
}

const upstreamLogs: UpstreamLog[] = [];
let upstream: ReturnType<typeof Bun.serve> | null = null;

// Deterministic instruction prompts: the gateway answers these identically on
// every call, so the non-volatile bytes of both runs are comparable.
const liveCases = [
  { name: "single word", input: "Reply with exactly one word: blue" },
  { name: "two words", input: "Reply with exactly two words: hot dog" },
  { name: "markdown shape", input: "Reply with exactly: **bold**" },
] as const;

const streamCase = { name: "stream single word", input: "Reply with exactly one word: red" } as const;

/**
 * Declared-volatile normalisation for a live capture.
 *
 * - ids: every gateway-minted id is fresh per call. Ids share the `<prefix>_`
 *   shape (resp_/msg_/rs_/fc_ + opaque token) and are normalised to `<prefix>_VOLATILE`.
 *   Scoped synthetic ids (`msg_ocx_<32hex>_<index>`) fold to
 *   `msg_ocx_SCOPE_<index>` so the index position stays comparable. Defensive:
 *   this suite never arms stateful repair, so only a future gateway serving
 *   scoped ids would exercise it (see the file header for where the repair RNG
 *   bytes ARE compared).
 * - timestamps / usage counts / encrypted reasoning: recomputed per call.
 * - `sequence_number`: both relays replay the upstream order, but the two
 *   gateway calls are independent streams, so the absolute counters ride the
 *   same volatile set (the ORDER of event types is still asserted exactly).
 * - output text: the model occasionally answers a fixed instruction with a
 *   case variant ("Hot dog" vs "hot dog") even when repeated runs are stable,
 *   so output_text/delta/text payload VALUES fold to lowercase. Everything
 *   around them (event types, item structure, annotations, ordering) is kept.
 */
function normalise(raw: string): string {
  return raw
    .replace(/"(resp|msg|rs|fc)_[0-9a-f]{16,}"/g, '"$1_VOLATILE"')
    .replace(/"(msg|rs|fc)_ocx_[0-9a-f]+_(\d+)"/g, '"$1_ocx_SCOPE_$2"')
    .replace(/"(created_at|created)":\s*\d+/g, '"$1":0')
    .replace(/"(input_tokens|output_tokens|total_tokens|cached_tokens|reasoning_tokens)":\s*\d+/g, '"$1":0')
    .replace(/"(encrypted_content|reasoning_content)":\s*"[^"]*"/g, '"$1":"VOLATILE"')
    .replace(/"sequence_number":\s*\d+/g, '"sequence_number":0')
    .replace(/"(text|delta)":\s*"([^"]*)"/g, (_, field: string, value: string) => `"${field}":"${value.toLowerCase()}"`);
}

function configFixture(upstreamPort: number): Record<string, unknown> {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "live",
    providers: {
      live: {
        adapter: "openai-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        disabled: false,
        models: [gatewayModel],
        ...(gatewayApiKey ? { apiKey: gatewayApiKey } : {}),
      },
    },
  };
}

async function postResponses(server: { url: URL }, token: string, body: unknown): Promise<ResponseCapture> {
  const response = await fetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencodex-api-key": token },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

/** Event-type sequence of an SSE stream: the ordering contract, volatile-free. */
function sseEventTypes(raw: string): string[] {
  return [...raw.matchAll(/^event:\s*(.+)$/gm)].map((match) => match[1]!.trim());
}

const previousEnv: Record<string, string | undefined> = {};
let testHome = "";

function captureEnv(): void {
  for (const name of [GO_SIDECAR_BIN_ENV, HOT_PATH_SEAM_ENV, HOT_PATH_RELAY_ENV, "OPENCODEX_HOME", "OPENCODEX_API_AUTH_TOKEN"]) {
    previousEnv[name] = process.env[name];
  }
}

function setUpFixture(upstreamPort: number): void {
  testHome = mkdtempSync(join(tmpdir(), "ocx-hotpath-live-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  saveConfig(configFixture(upstreamPort) as Parameters<typeof saveConfig>[0]);
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

function runLiveTest(name: string, fn: () => Promise<void>): void {
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
    // Two full server lifetimes plus real-gateway inference round-trips per
    // case are intrinsic waits (test-budget rule 1), so double the server
    // budget rather than sizing to a local timing.
    SERVER_BUDGET_MS * 2,
  );
}

// A minimal passthrough to the real gateway. The opencodex listeners connect
// to THIS fixture, the fixture forwards to the gateway, and the logs prove
// which implementation performed the upstream hop.
describe.skipIf(!goAvailable || sidecarBinary === null || !live)("ocx-sidecar live-gateway hot-path differential (ADR-0008, ticket #34)", () => {
  beforeAll(() => {
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const incoming = new URL(req.url);
        const headers = new Headers();
        for (const name of ["content-type", "accept", "authorization", "api-key"]) {
          const value = req.headers.get(name);
          if (value) headers.set(name, value);
        }
        const body = await req.text();
        upstreamLogs.push({
          ua: req.headers.get("user-agent") ?? "",
          method: req.method,
          path: incoming.pathname,
          contentType: req.headers.get("content-type"),
          body,
        });
        const upstreamResponse = await fetch(new URL(incoming.pathname + incoming.search, gatewayBase), {
          method: req.method,
          headers,
          body,
        });
        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          headers: { "content-type": upstreamResponse.headers.get("content-type") ?? "application/json" },
        });
      },
    });
  });

  afterAll(() => {
    upstream?.stop(true);
    upstream = null;
  });

  test("gateway is reachable", () => {
    expect(live).toBe(true);
  });

  runLiveTest("non-streaming responses match the TS oracle after volatile normalisation", async () => {
    const token = "data-secret";
    const port = upstream!.port;

    setUpFixture(port);
    const serverA = startServer(0);
    const tsCaptures: ResponseCapture[] = [];
    try {
      for (const c of liveCases) {
        tsCaptures.push(await postResponses(serverA, token, { model: gatewayModel, input: c.input }));
      }
    } finally {
      await serverA.stop(true);
    }
    const oracleLogs = upstreamLogs.slice(0, liveCases.length);
    for (const log of oracleLogs) {
      expect(log.ua, "TS oracle must never present the Go client UA").not.toBe(GO_UA);
      expect(log.path).toBe("/v1/responses");
    }

    process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
    process.env[HOT_PATH_SEAM_ENV] = "1";
    process.env[HOT_PATH_RELAY_ENV] = "1";
    const serverB = startServer(0);
    const goCaptures: ResponseCapture[] = [];
    try {
      await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
      for (const c of liveCases) {
        goCaptures.push(await postResponses(serverB, token, { model: gatewayModel, input: c.input }));
      }
    } finally {
      await serverB.stop(true);
    }
    const goLogs = upstreamLogs.slice(liveCases.length);
    expect(goLogs).toHaveLength(liveCases.length);
    for (const log of goLogs) {
      expect(log.ua, "relay-admitted live request must be Go-owned").toBe(GO_UA);
      expect(log.path).toBe("/v1/responses");
    }

    for (let i = 0; i < liveCases.length; i++) {
      const c = liveCases[i]!;
      const ts = tsCaptures[i]!;
      const go = goCaptures[i]!;
      expect(go.status, `${c.name} status`).toBe(ts.status);
      expect((go.contentType ?? "").split(";")[0], `${c.name} content type`).toBe((ts.contentType ?? "").split(";")[0]);
      expect(normalise(go.body), `${c.name} normalised body must match the TS oracle`).toBe(normalise(ts.body));
      // Non-vacuous: the normaliser must not erase the response payload.
      expect(normalise(go.body), `${c.name} keeps output text`).toContain("output_text");
    }
    expect(activeGoSidecarBaseUrl()).toBeNull();
  });

  runLiveTest("streaming responses match the TS oracle event-for-event after normalisation", async () => {
    const token = "data-secret";
    const port = upstream!.port;
    const body = { model: gatewayModel, input: streamCase.input, stream: true };

    setUpFixture(port);
    const serverA = startServer(0);
    let tsCapture: ResponseCapture;
    try {
      tsCapture = await postResponses(serverA, token, body);
    } finally {
      await serverA.stop(true);
    }
    const oracleLog = upstreamLogs[upstreamLogs.length - 1]!;
    expect(oracleLog.ua, "TS oracle stream must never present the Go client UA").not.toBe(GO_UA);

    process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
    process.env[HOT_PATH_SEAM_ENV] = "1";
    process.env[HOT_PATH_RELAY_ENV] = "1";
    const serverB = startServer(0);
    let goCapture: ResponseCapture;
    try {
      await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
      goCapture = await postResponses(serverB, token, body);
    } finally {
      await serverB.stop(true);
    }
    const goLog = upstreamLogs[upstreamLogs.length - 1]!;
    expect(goLog.ua, "relay-admitted live stream must be Go-owned").toBe(GO_UA);

    expect(goCapture.status, "stream status").toBe(tsCapture.status);
    expect((goCapture.contentType ?? "").split(";")[0], "stream content type").toBe((tsCapture.contentType ?? "").split(";")[0]);

    const tsEvents = sseEventTypes(tsCapture.body);
    const goEvents = sseEventTypes(goCapture.body);
    expect(goEvents, "SSE event-type sequence must match the TS oracle").toEqual(tsEvents);
    expect(tsEvents.length, "live stream carries a full event sequence").toBeGreaterThan(2);
    expect(tsEvents[tsEvents.length - 1], "stream terminates on response.completed").toBe("response.completed");

    expect(normalise(goCapture.body), "normalised SSE bytes must match the TS oracle").toBe(normalise(tsCapture.body));
    expect(normalise(goCapture.body), "stream keeps the output text").toContain("output_text.delta");
    expect(activeGoSidecarBaseUrl()).toBeNull();
  });
});

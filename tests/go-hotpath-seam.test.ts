import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
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
import { HOT_PATH_SEAM_ENV, HOT_PATH_SEAM_PATH } from "../src/server/hot-path-seam";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * Streaming differential harness for the ADR-0008 hot-path seam (ticket #24,
 * devlog 034). The TypeScript pipeline is the live oracle, exactly as it is for
 * the management surface: server A runs the data plane in-process, server B
 * runs the same request through the Go seam (front door → sidecar → private
 * bridge → in-process pipeline), and the harness compares the client-visible
 * ordered SSE frame sequence.
 *
 * The declared volatile set is DATA, mirroring `go.volatileFields` on the
 * management side. For this fixture it is empty (raw frame identity) plus the
 * per-request `x-request-id` response header, which every front door mints per
 * request and therefore legitimately differs between A and B. Nothing else is
 * forgiven: a dropped, reordered, duplicated or rewritten frame fails the
 * differential, and the harness proves the failure mode on a deliberately
 * mutated capture.
 *
 * Skipped where the Go toolchain is unavailable (same guard as
 * `go-sidecar-parity.test.ts`); CI installs Go and runs the oracle.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function goToolchainAvailable(): boolean {
  const probe = Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" });
  return probe.success;
}

function buildSidecarBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-sidecar-"));
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

const upstreamSse =
  "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"fixture-1\",\"status\":\"in_progress\"}}\n\n" +
  "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\n\n" +
  "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\n\n" +
  "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"fixture-1\",\"status\":\"completed\"}}\n\n";

let upstream: ReturnType<typeof Bun.serve> | null = null;

/**
 * Split a client-visible SSE wire body into ordered frames. A frame is one
 * event block terminated by a blank line; the trailing `data: [DONE]` marker
 * is its own frame (as the TS relay emits it). This is the comparison unit of
 * the differential — never a JSON re-parse, which would forgive the reorder
 * and duplication classes this harness exists to catch.
 */
function parseSseFrames(raw: string): string[] {
  const frames = raw.split("\n\n");
  // A trailing separator after [DONE] produces a final empty element.
  if (frames.length > 0 && frames[frames.length - 1] === "") frames.pop();
  return frames;
}

/**
 * Declared volatile normalisation. Body volatile fields: NONE for this
 * fixture (raw frame identity). Three response headers are legitimately
 * request/server-scoped and are normalised exactly like the management
 * oracle's pid/uptime: the per-request trace id, the Date header (two
 * requests land at different instants), and the CORS origin echo, which names
 * the responding server's own listener.
 */
const volatileResponseHeaders = [
  "x-opencodex-request-id",
  "date",
  "access-control-allow-origin",
] as const;
const volatileBodyFields: readonly string[] = [];

function normaliseBody(raw: string): string {
  let out = raw;
  for (const field of volatileBodyFields) {
    out = out.replace(new RegExp(`"${field}":(-?\\d+(?:\\.\\d+)?|[^,}\\]]+)`, "g"), `"${field}":0`);
  }
  return out;
}

function normaliseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    if ((volatileResponseHeaders as readonly string[]).includes(name)) {
      out[name] = "<volatile>";
    } else {
      out[name] = value;
    }
  }
  return out;
}

const previousEnv: Record<string, string | undefined> = {};
let testHome = "";

function configFixture(upstreamPort: number) {
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
      },
    },
  };
}

function captureEnv(): void {
  for (const name of [GO_SIDECAR_BIN_ENV, HOT_PATH_SEAM_ENV, "OPENCODEX_HOME", "OPENCODEX_API_AUTH_TOKEN"]) {
    previousEnv[name] = process.env[name];
  }
}

function setUpFixture(upstreamPort: number): void {
  testHome = mkdtempSync(join(tmpdir(), "ocx-hotpath-seam-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  saveConfig(configFixture(upstreamPort));
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

interface DataPlaneCapture {
  status: number;
  contentType: string | null;
  headers: Record<string, string>;
  frames: string[];
}

async function postResponses(server: { url: URL }, token: string): Promise<DataPlaneCapture> {
  const response = await fetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencodex-api-key": token },
    body: JSON.stringify({ model: "test-model", input: "ping", stream: true }),
  });
  const raw = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    headers: normaliseHeaders(response.headers),
    frames: parseSseFrames(normaliseBody(raw)),
  };
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

describe.skipIf(!goAvailable || sidecarBinary === null)("ocx-sidecar hot-path seam differential (ADR-0008, ticket #24)", () => {
  beforeAll(() => {
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname !== "/v1/responses") return new Response("nf", { status: 404 });
        return new Response(upstreamSse, { headers: { "content-type": "text/event-stream" } });
      },
    });
  });
  afterAll(() => {
    upstream?.stop(true);
    upstream = null;
  });

  test("the seam data is declared before the oracle runs", () => {
    // The harness must prove a declared surface: if the seam route marker or
    // its gate ever disappears the differential compares nothing. The declared
    // volatile set for this fixture is the per-request response header only.
    expect(HOT_PATH_SEAM_PATH).toBe("/v1/responses");
    expect(volatileBodyFields).toEqual([]);
    expect([...volatileResponseHeaders]).toEqual([
      "x-opencodex-request-id",
      "date",
      "access-control-allow-origin",
    ]);
  });

  runFixtureTest("seam-served stream equals the in-process stream frame-for-frame", async () => {
    const token = "data-secret";
    const port = upstream!.port;

    // Server A: the in-process pipeline is the live oracle.
    setUpFixture(port);
    const serverA = startServer(0);
    let tsCapture: DataPlaneCapture;
    try {
      tsCapture = await postResponses(serverA, token);
      expect(tsCapture.status).toBe(200);
      expect(tsCapture.contentType).toBe("text/event-stream");
      expect(tsCapture.frames.length).toBeGreaterThanOrEqual(4);
    } finally {
      await serverA.stop(true);
    }

    // Server B: same config and fixture upstream, seam env on, sidecar attached.
    process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
    process.env[HOT_PATH_SEAM_ENV] = "1";
    const serverB = startServer(0);
    let goCapture: DataPlaneCapture;
    try {
      await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
      goCapture = await postResponses(serverB, token);
      expect(goCapture.status).toBe(200);
      expect(goCapture.contentType).toBe("text/event-stream");
    } finally {
      await serverB.stop(true);
    }

    // The client-visible frame sequence must be identical in order and bytes.
    // The two requests land on the same fixture, and the seam is a pure
    // transport, so an empty body volatile set is the honest contract here.
    expect(goCapture.frames).toEqual(tsCapture.frames);
    // Only the declared volatile header legitimately differs.
    expect(goCapture.headers).toEqual(tsCapture.headers);
    expect(activeGoSidecarBaseUrl()).toBeNull();
  });

  runFixtureTest("a mutated frame fails the differential (non-vacuous harness)", async () => {
    const token = "data-secret";
    const port = upstream!.port;
    setUpFixture(port);
    const serverA = startServer(0);
    try {
      const capture = await postResponses(serverA, token);
      // Reorder two frames: the harness must treat that as a divergence.
      const reordered = [...capture.frames];
      const first = reordered.shift()!;
      reordered.splice(1, 0, first);
      expect(reordered).not.toEqual(capture.frames);
      // A dropped frame must also diverge.
      expect(capture.frames.slice(1)).not.toEqual(capture.frames);
    } finally {
      await serverA.stop(true);
    }
  });

  runFixtureTest("a seam-on server refuses unclaimed sidecar requests and seam-off serves in-process", async () => {
    const token = "data-secret";
    const port = upstream!.port;
    setUpFixture(port);
    process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
    process.env[HOT_PATH_SEAM_ENV] = "1";
    const server = startServer(0);
    try {
      const sidecarUrl = await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
      // A direct call to the sidecar's data-plane surface without the parent
      // request token must answer 404: the sidecar invents no public listener.
      const direct = await fetch(new URL(HOT_PATH_SEAM_PATH, sidecarUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", input: "ping", stream: true }),
      });
      expect(direct.status).toBe(404);
    } finally {
      await server.stop(true);
    }
    expect(activeGoSidecarBaseUrl()).toBeNull();

    // Same config, seam env off: the seam gate stays closed and the data
    // plane is served in-process exactly as a build without the seam.
    delete process.env[HOT_PATH_SEAM_ENV];
    process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
    const serverB = startServer(0);
    try {
      await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
      const capture = await postResponses(serverB, token);
      expect(capture.status).toBe(200);
      expect(capture.frames[0]).toContain("response.created");
    } finally {
      await serverB.stop(true);
    }
  });
});

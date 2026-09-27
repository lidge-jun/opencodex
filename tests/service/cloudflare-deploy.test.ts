import { afterEach, describe, expect, test } from "bun:test";

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideLease, isHolder, LEASE_STALE_MS, LeaseState, type LeaseStorage } from "../../deploy/cloudflare/src/lease";
import { handleStateRequest, sweepOrphans, type StateBucket } from "../../deploy/cloudflare/src/state-routes";
import { containerEnv, edgeDecision, envFingerprint } from "../../deploy/cloudflare/src/container-env";
import { applySnapshot, classifyFile, seedBootstrapConfig, stageSnapshot, Supervisor, type StateRoot } from "../../docker/cloudflare-supervisor";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SQLITE = "SQLite format 3\0";
const created: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-cf-test-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) await removeTreeWithRetry(dir);
});

describe("cloudflare state lease", () => {
  const a = "a".repeat(32);
  const b = "b".repeat(32);

  test("grants a free lease and renews it for its holder", () => {
    expect(decideLease(undefined, a, 1000)).toEqual({ granted: true, lease: { bootId: a, heartbeatAt: 1000 } });
    expect(decideLease({ bootId: a, heartbeatAt: 1000 }, a, 5000)).toEqual({ granted: true, lease: { bootId: a, heartbeatAt: 5000 } });
  });

  test("makes a second container wait until the holder's heartbeat is stale", () => {
    const held = { bootId: a, heartbeatAt: 0 };
    expect(decideLease(held, b, LEASE_STALE_MS - 30_000)).toEqual({ granted: false, retryAfterSeconds: 30 });
    expect(decideLease(held, b, LEASE_STALE_MS)).toEqual({ granted: true, lease: { bootId: b, heartbeatAt: LEASE_STALE_MS } });
    expect(isHolder({ bootId: b, heartbeatAt: 0 }, a)).toBe(false);
  });
});

describe("cloudflare supervisor snapshots", () => {
  test("classifies databases by header, never by extension", () => {
    expect(classifyFile("usage.sqlite", SQLITE)).toBe("sqlite");
    expect(classifyFile("state", SQLITE)).toBe("sqlite");
    expect(classifyFile("notes.sqlite", "{\"a\":1}")).toBe("copy");
    expect(classifyFile("usage.sqlite-wal", "")).toBe("skip");
    expect(classifyFile("usage.sqlite-shm", "")).toBe("skip");
    expect(classifyFile("spend-ledger-owner.sqlite", SQLITE)).toBe("skip");
    expect(classifyFile("config-mutation.sqlite", SQLITE)).toBe("skip");
    expect(classifyFile(".opencodex-native-main.claim.sqlite", SQLITE)).toBe("skip");
    expect(classifyFile("admin-api-token", "0123")).toBe("skip");
  });

  test("round-trips a live WAL database, files, modes, and symlinks, skipping locks", async () => {
    const home = scratch();
    const ocx = join(home, "ocx");
    const codex = join(home, "codex");
    mkdirSync(join(ocx, "nested"), { recursive: true });
    mkdirSync(codex);
    writeFileSync(join(ocx, "config.json"), "{\"port\":10100}\n", { mode: 0o600 });
    writeFileSync(join(ocx, "nested", "note.txt"), "kept");
    symlinkSync("config.json", join(ocx, "link.json"));
    writeFileSync(join(codex, "auth.json"), "{}", { mode: 0o600 });

    // Held open with uncheckpointed WAL rows, as the running proxy would leave it.
    const live = new Database(join(ocx, "usage.sqlite"));
    live.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('row')");
    const lock = new Database(join(ocx, "spend-ledger-owner.sqlite"));
    lock.exec("CREATE TABLE owner (pid INTEGER)");

    const roots: StateRoot[] = [{ prefix: "opencodex", dir: ocx }, { prefix: "codex", dir: codex }];
    const staging = join(scratch(), "tree");
    const digest = await stageSnapshot(roots, staging);
    expect(await stageSnapshot(roots, join(scratch(), "again"))).toBe(digest);
    live.close();
    lock.close();

    expect(existsSync(join(staging, "opencodex", "usage.sqlite-wal"))).toBe(false);
    expect(existsSync(join(staging, "opencodex", "spend-ledger-owner.sqlite"))).toBe(false);

    const restored = scratch();
    const target: StateRoot[] = [
      { prefix: "opencodex", dir: join(restored, "ocx") },
      { prefix: "codex", dir: join(restored, "codex") },
    ];
    await applySnapshot(target, staging);
    const copy = new Database(join(restored, "ocx", "usage.sqlite"), { readonly: true });
    expect(copy.query("SELECT v FROM t").get()).toEqual({ v: "row" });
    copy.close();
    expect(readFileSync(join(restored, "ocx", "nested", "note.txt"), "utf8")).toBe("kept");
    expect(readFileSync(join(restored, "ocx", "link.json"), "utf8")).toBe("{\"port\":10100}\n");
    expect(statSync(join(restored, "codex", "auth.json")).mode & 0o777).toBe(0o600);
  });

  test("a changed file changes the digest so the next interval uploads", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "config.json"), "{}");
    const roots = [{ prefix: "opencodex", dir }];
    const before = await stageSnapshot(roots, join(scratch(), "a"));
    writeFileSync(join(dir, "config.json"), "{\"x\":1}");
    expect(await stageSnapshot(roots, join(scratch(), "b"))).not.toBe(before);
  });

  test("seeds the bootstrap config only from a JSON object, bound where the Worker can reach it", () => {
    const home = scratch();
    expect(seedBootstrapConfig(home, {})).toBe(false);
    expect(() => seedBootstrapConfig(home, { OCX_BOOTSTRAP_CONFIG_JSON: "[1]" })).toThrow("JSON object");
    // ocx defaults to 127.0.0.1, which the Worker cannot reach: an omitted bind address is filled in.
    expect(seedBootstrapConfig(home, { OCX_BOOTSTRAP_CONFIG_JSON: "{\"defaultProvider\":\"demo\"}" })).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual({ defaultProvider: "demo", hostname: "0.0.0.0", port: 10100 });
    expect(statSync(join(home, "config.json")).mode & 0o777).toBe(0o600);
    expect(() => seedBootstrapConfig(home, { OCX_BOOTSTRAP_CONFIG_JSON: "{\"hostname\":\"127.0.0.1\"}" })).toThrow("0.0.0.0");
    expect(() => seedBootstrapConfig(home, { OCX_BOOTSTRAP_CONFIG_JSON: "{\"port\":10200}" })).toThrow("10100");
  });
});

function memoryStorage(): LeaseStorage {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key, value) => { map.set(key, value); },
    delete: async key => map.delete(key),
  };
}

function memoryBucket(onPut?: () => Promise<void>): StateBucket & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    get: async key => (objects.has(key) ? new Response(objects.get(key)).body : null),
    put: async (key, body) => {
      await onPut?.();
      objects.set(key, await new Response(body).text());
    },
    delete: async key => { objects.delete(key); },
    list: async (prefix, limit) => [...objects.keys()].filter(key => key.startsWith(prefix)).slice(0, limit),
  };
}

function stateRequest(method: string, path: string, bootId: string, body?: string): Request {
  const headers: Record<string, string> = { "x-ocx-boot-id": bootId };
  if (body !== undefined) headers["content-length"] = String(body.length);
  return new Request(`http://state.ocx.internal${path}`, { method, headers, body });
}

describe("cloudflare state routes", () => {
  const oldBoot = "a".repeat(32);
  const newBoot = "b".repeat(32);

  test("a holder's upload replaces its previous snapshot and is what the next boot restores", async () => {
    const hub = new LeaseState(memoryStorage(), () => 0);
    const bucket = memoryBucket();
    expect((await handleStateRequest(stateRequest("POST", "/lease", oldBoot), hub, bucket)).status).toBe(204);
    expect((await handleStateRequest(stateRequest("PUT", "/snapshot", oldBoot, "one"), hub, bucket)).status).toBe(204);
    expect((await handleStateRequest(stateRequest("PUT", "/snapshot", oldBoot, "two"), hub, bucket)).status).toBe(204);
    expect([...bucket.objects.values()]).toEqual(["two"]);
    await handleStateRequest(stateRequest("DELETE", "/lease", oldBoot), hub, bucket);

    expect((await handleStateRequest(stateRequest("POST", "/lease", newBoot), hub, bucket)).status).toBe(204);
    expect(await (await handleStateRequest(stateRequest("GET", "/snapshot", newBoot), hub, bucket)).text()).toBe("two");
  });

  test("a fenced container's late upload cannot overwrite or delete the snapshot the new holder restored", async () => {
    let now = 0;
    const hub = new LeaseState(memoryStorage(), () => now);
    let takeOverDuringUpload = false;
    const bucket = memoryBucket(async () => {
      if (!takeOverDuringUpload) return;
      // The old container passed the lease check, then went quiet long enough to be declared dead.
      now += LEASE_STALE_MS;
      expect((await hub.acquireLease(newBoot)).granted).toBe(true);
    });
    await handleStateRequest(stateRequest("POST", "/lease", oldBoot), hub, bucket);
    await handleStateRequest(stateRequest("PUT", "/snapshot", oldBoot, "committed"), hub, bucket);

    takeOverDuringUpload = true;
    const late = await handleStateRequest(stateRequest("PUT", "/snapshot", oldBoot, "stale"), hub, bucket);
    expect(late.status).toBe(409);
    expect([...bucket.objects.values()]).toEqual(["committed"]);
    expect(await (await handleStateRequest(stateRequest("GET", "/snapshot", newBoot), hub, bucket)).text()).toBe("committed");
  });

  test("rejects a missing boot id, a missing length, and a non-holder upload", async () => {
    const hub = new LeaseState(memoryStorage(), () => 0);
    const bucket = memoryBucket();
    expect((await handleStateRequest(stateRequest("POST", "/lease", "../x"), hub, bucket)).status).toBe(400);
    await handleStateRequest(stateRequest("POST", "/lease", oldBoot), hub, bucket);
    const noLength = new Request("http://state.ocx.internal/snapshot", { method: "PUT", headers: { "x-ocx-boot-id": oldBoot } });
    expect((await handleStateRequest(noLength, hub, bucket)).status).toBe(411);
    expect((await handleStateRequest(stateRequest("PUT", "/snapshot", newBoot, "x"), hub, bucket)).status).toBe(409);
    expect((await handleStateRequest(stateRequest("GET", "/snapshot", oldBoot), hub, bucket)).status).toBe(404);
  });
});

describe("cloudflare state route guards", () => {
  const holder = "c".repeat(32);
  const other = "d".repeat(32);

  test("only the lease holder can download the snapshot", async () => {
    const hub = new LeaseState(memoryStorage(), () => 0);
    const bucket = memoryBucket();
    await handleStateRequest(stateRequest("POST", "/lease", holder), hub, bucket);
    await handleStateRequest(stateRequest("PUT", "/snapshot", holder, "secret-state"), hub, bucket);
    expect((await handleStateRequest(stateRequest("GET", "/snapshot", other), hub, bucket)).status).toBe(409);
  });

  test("a committed pointer to a missing object is an error, not a first boot", async () => {
    const hub = new LeaseState(memoryStorage(), () => 0);
    const bucket = memoryBucket();
    await handleStateRequest(stateRequest("POST", "/lease", holder), hub, bucket);
    await handleStateRequest(stateRequest("PUT", "/snapshot", holder, "state"), hub, bucket);
    bucket.objects.clear();
    expect((await handleStateRequest(stateRequest("GET", "/snapshot", holder), hub, bucket)).status).toBe(500);
  });
});

describe("cloudflare worker edge", () => {
  const token = { OPENCODEX_API_AUTH_TOKEN: "data" };
  const request = (path: string, headers: Record<string, string> = {}) => new Request(`https://hub.example${path}`, { headers });

  test("forwards named string secrets only, and the fixed names win", () => {
    const env = {
      ...token,
      OCX_PASSTHROUGH_SECRETS: "ANTHROPIC_API_KEY, STATE ,lower,OPENCODEX_API_AUTH_TOKEN,MISSING",
      ANTHROPIC_API_KEY: "anthropic",
      STATE: { get() {} },
      lower: "x",
    };
    expect(containerEnv(env)).toEqual({ ANTHROPIC_API_KEY: "anthropic", OPENCODEX_API_AUTH_TOKEN: "data" });
  });

  test("the fingerprint changes when a secret rotates and ignores key order", async () => {
    const before = await envFingerprint({ A: "1", B: "2" });
    expect(await envFingerprint({ B: "2", A: "1" })).toBe(before);
    expect(await envFingerprint({ A: "1", B: "3" })).not.toBe(before);
    const withSecret = await envFingerprint({ TOKEN: "zz-secret-value" });
    expect(withSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(withSecret).not.toContain("zz-secret-value");
  });

  test("fails closed without a data token and turns away credential-less requests", () => {
    expect(edgeDecision(request("/v1/models", { authorization: "Bearer x" }), {})).toMatchObject({ forward: false, status: 503 });
    expect(edgeDecision(request("/v1/models"), token)).toMatchObject({ forward: false, status: 401 });
    expect(edgeDecision(request("/healthz", { "x-opencodex-api-key": "k" }), token)).toEqual({ forward: true });
    expect(edgeDecision(request("/v1/messages", { "x-api-key": "k" }), token)).toEqual({ forward: true });
    expect(edgeDecision(request("/v1/audio/transcriptions/stream", {
      "sec-websocket-protocol": "opencodex-audio.v1, opencodex-key.aw", upgrade: "websocket",
    }), token)).toEqual({ forward: true });
    // Preflights never reach the container, and the Worker grants no CORS.
    const preflight = new Request("https://hub.example/v1/responses", { method: "OPTIONS", headers: { "access-control-request-method": "POST", authorization: "Bearer x" } });
    expect(edgeDecision(preflight, token)).toEqual({ forward: false, status: 204, message: "" });
  });

  test("keeps the management API closed unless the operator opts in with their own admin token", () => {
    const withKey = { authorization: "Bearer admin" };
    expect(edgeDecision(request("/api/config", withKey), token)).toMatchObject({ forward: false, status: 404 });
    expect(edgeDecision(request("/api/config", withKey), { ...token, OCX_EXPOSE_MANAGEMENT_API: "1" })).toMatchObject({ status: 404 });
    expect(edgeDecision(request("/api/config", withKey), { ...token, OCX_EXPOSE_MANAGEMENT_API: "1", OPENCODEX_ADMIN_AUTH_TOKEN: "admin" })).toEqual({ forward: true });
    expect(edgeDecision(request("/apiary", withKey), token)).toEqual({ forward: true });
  });
});

describe("cloudflare lease renewal", () => {
  const a = "e".repeat(32);
  const b = "f".repeat(32);

  test("a renewal never re-takes a released or reassigned lease", async () => {
    let now = 0;
    const hub = new LeaseState(memoryStorage(), () => now);
    const bucket = memoryBucket();
    await handleStateRequest(stateRequest("POST", "/lease", a), hub, bucket);
    expect((await handleStateRequest(stateRequest("PUT", "/lease", a), hub, bucket)).status).toBe(204);
    await handleStateRequest(stateRequest("DELETE", "/lease", a), hub, bucket);
    expect((await handleStateRequest(stateRequest("PUT", "/lease", a), hub, bucket)).status).toBe(409);

    // Stale, taken over by b, released by b: a's late renewal must still fail.
    await handleStateRequest(stateRequest("POST", "/lease", a), hub, bucket);
    now += LEASE_STALE_MS;
    await handleStateRequest(stateRequest("POST", "/lease", b), hub, bucket);
    await handleStateRequest(stateRequest("DELETE", "/lease", b), hub, bucket);
    expect((await handleStateRequest(stateRequest("PUT", "/lease", a), hub, bucket)).status).toBe(409);
  });
});

describe("cloudflare state reset and cleanup", () => {
  const holder = "1".repeat(32);

  test("a boot that takes the lease sweeps orphaned snapshot objects but keeps the committed one", async () => {
    const hub = new LeaseState(memoryStorage(), () => 0);
    const bucket = memoryBucket();
    await handleStateRequest(stateRequest("POST", "/lease", holder), hub, bucket);
    await handleStateRequest(stateRequest("PUT", "/snapshot", holder, "kept"), hub, bucket);
    bucket.objects.set("snapshots/dead/orphan.tar.gz", "orphan");
    await handleStateRequest(stateRequest("DELETE", "/lease", holder), hub, bucket);
    expect((await handleStateRequest(stateRequest("POST", "/lease", holder), hub, bucket)).status).toBe(204);
    expect([...bucket.objects.values()]).toEqual(["kept"]);
    expect(await sweepOrphans(hub, bucket)).toBe(0);
  });

  test("discarding the saved state makes the next boot a first boot", async () => {
    const hub = new LeaseState(memoryStorage(), () => 0);
    const bucket = memoryBucket();
    await handleStateRequest(stateRequest("POST", "/lease", holder), hub, bucket);
    await handleStateRequest(stateRequest("PUT", "/snapshot", holder, "unbootable"), hub, bucket);
    const discarded = await hub.discardSnapshot();
    expect(discarded).toStartWith("snapshots/");
    expect(await hub.holdsLease(holder)).toBe(false);
    const next = "2".repeat(32);
    expect((await handleStateRequest(stateRequest("POST", "/lease", next), hub, bucket)).status).toBe(204);
    expect((await handleStateRequest(stateRequest("GET", "/snapshot", next), hub, bucket)).status).toBe(404);
  });
});

type FakeState = {
  origin: string;
  events: string[];
  snapshot: () => Uint8Array | null;
  maxConcurrentUploads: () => number;
  stop: () => void;
};

function fakeStateServer(overrides: Record<string, (req: Request) => Response | Promise<Response>> = {}, uploadDelayMs = 0): FakeState {
  const events: string[] = [];
  let snapshot: Uint8Array | null = null;
  let uploading = 0;
  let maxUploading = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const key = `${req.method} ${new URL(req.url).pathname}`;
      events.push(key);
      const override = overrides[key];
      if (override) return override(req);
      if (key === "GET /snapshot") return snapshot ? new Response(snapshot) : new Response("none", { status: 404 });
      if (key === "PUT /snapshot") {
        uploading++;
        maxUploading = Math.max(maxUploading, uploading);
        const body = new Uint8Array(await req.arrayBuffer());
        if (uploadDelayMs) await Bun.sleep(uploadDelayMs);
        snapshot = body;
        uploading--;
      }
      return new Response(null, { status: 204 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    events,
    snapshot: () => snapshot,
    maxConcurrentUploads: () => maxUploading,
    stop: () => server.stop(true),
  };
}

function recordingExit() {
  let resolve!: (code: number) => void;
  const code = new Promise<number>(r => { resolve = r; });
  // Parks the caller the way process.exit would end it.
  const exit = (value: number) => { resolve(value); return new Promise<never>(() => {}); };
  return { code, exit };
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(20);
  }
}

async function readArchive(bytes: Uint8Array, file: string): Promise<string> {
  const dir = scratch();
  writeFileSync(join(dir, "s.tar.gz"), bytes);
  mkdirSync(join(dir, "x"));
  expect(Bun.spawnSync(["tar", "-xzf", join(dir, "s.tar.gz"), "-C", join(dir, "x")]).exitCode).toBe(0);
  return readFileSync(join(dir, "x", file), "utf8");
}

// Stands in for ocx: runs until signalled.
const IDLE_CHILD = ["bun", "-e", "setInterval(() => {}, 1000)"];

describe("cloudflare supervisor lifecycle", () => {
  test("a clean shutdown stops ocx, uploads the final state, then releases the lease", async () => {
    const state = fakeStateServer();
    const home = scratch();
    writeFileSync(join(home, "config.json"), "{}");
    const { code, exit } = recordingExit();
    const supervisor = new Supervisor({ roots: [{ prefix: "opencodex", dir: home }], intervalMs: 60_000, port: 0, stateOrigin: state.origin, exit, handleSignals: false });
    void supervisor.main(IDLE_CHILD);
    try {
      await until(() => state.events.includes("GET /snapshot"));
      await Bun.sleep(200);
      writeFileSync(join(home, "config.json"), "{\"final\":true}");
      void supervisor.shutdown("SIGTERM");
      expect(await code).toBe(0);
      const upload = state.events.lastIndexOf("PUT /snapshot");
      expect(upload).toBeGreaterThan(-1);
      // Released exactly once, and only after the final upload: releasing earlier would let a new
      // boot restore the state from before this shutdown.
      expect(state.events.filter(event => event === "DELETE /lease")).toHaveLength(1);
      expect(state.events.indexOf("DELETE /lease")).toBeGreaterThan(upload);
      expect(await readArchive(state.snapshot()!, "opencodex/config.json")).toBe("{\"final\":true}");
    } finally {
      state.stop();
    }
  });

  test("a lost lease fences: nothing is uploaded after the renewal is refused", async () => {
    const state = fakeStateServer({ "PUT /lease": () => new Response("lost", { status: 409 }) });
    const home = scratch();
    writeFileSync(join(home, "config.json"), "{}");
    const { code, exit } = recordingExit();
    const supervisor = new Supervisor({ roots: [{ prefix: "opencodex", dir: home }], intervalMs: 150, port: 0, stateOrigin: state.origin, exit, handleSignals: false });
    void supervisor.main(IDLE_CHILD);
    try {
      expect(await code).toBe(1);
      const atFence = state.events.length;
      await Bun.sleep(500);
      // Anything already in flight is aborted; nothing new starts, and a fenced boot never releases.
      expect(state.events.slice(atFence).filter(event => event === "PUT /snapshot")).toEqual([]);
      expect(state.events).not.toContain("DELETE /lease");
    } finally {
      state.stop();
    }
  });

  test("a failed restore releases the lease and never starts ocx", async () => {
    const state = fakeStateServer({ "GET /snapshot": () => new Response("object missing", { status: 500 }) });
    const home = scratch();
    const marker = join(home, "started");
    const { exit } = recordingExit();
    const supervisor = new Supervisor({ roots: [{ prefix: "opencodex", dir: home }], intervalMs: 60_000, port: 0, stateOrigin: state.origin, exit, handleSignals: false });
    try {
      await expect(supervisor.main(["bun", "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`])).rejects.toThrow("state restore failed");
      expect(state.events).toContain("DELETE /lease");
      await Bun.sleep(300);
      expect(existsSync(marker)).toBe(false);
    } finally {
      state.stop();
    }
  });

  test("uploads never overlap, and the final one carries the latest state", async () => {
    const state = fakeStateServer({}, 400);
    const home = scratch();
    writeFileSync(join(home, "config.json"), "{\"v\":1}");
    const { code, exit } = recordingExit();
    const supervisor = new Supervisor({ roots: [{ prefix: "opencodex", dir: home }], intervalMs: 100, port: 0, stateOrigin: state.origin, exit, handleSignals: false });
    void supervisor.main(IDLE_CHILD);
    try {
      await until(() => state.events.includes("PUT /snapshot"));
      writeFileSync(join(home, "config.json"), "{\"v\":2}");
      void supervisor.shutdown("SIGTERM");
      expect(await code).toBe(0);
      expect(state.maxConcurrentUploads()).toBe(1);
      expect(await readArchive(state.snapshot()!, "opencodex/config.json")).toBe("{\"v\":2}");
    } finally {
      state.stop();
    }
  });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogVerdict, createCatalogPullRecorder, createCatalogRevisionMonitor, type CatalogRevision } from "../../src/link/child-catalog-freshness";
import { CHILD_OBSERVATIONS_SCHEMA, readChildObservations } from "../../src/link/child-observations";
import { childObservationsPath, linkStorePath } from "../../src/link/paths";
import { ConfigMutationLockError } from "../../src/config/mutation-lock";
import { catalogEtag } from "../../src/server/catalog-download";
import type { LinkCatalogServed } from "../../src/server/index/link-relay-sessions";
import { chunkedResponse, relayHarness } from "../helpers/link-relay-harness";

const A = "lnk_0123456789abcdef", B = "lnk_fedcba9876543210";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function configDir(): string { const dir = mkdtempSync(join(tmpdir(), "ocx-catalog-fresh-")); dirs.push(dir); return dir; }
function writeLinks(dir: string, ids: string[]): void {
  mkdirSync(join(dir, "link"), { recursive: true });
  writeFileSync(linkStorePath(dir), JSON.stringify({ version: 1, listenerPort: null, links: ids.map(id => ({ id, alias: "host-" + id.slice(-4),
    direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz012345", tunnelPort: 41000, apiKeyId: "key-" + id.slice(-4), createdAt: "2026-11-11T00:00:00.000Z" })) }));
}
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe("catalog pull recorder", () => {
  test("records pulls by key id", async () => {
    const dir = configDir(); writeLinks(dir, [A, B]);
    const writes: string[] = [];
    const recorder = createCatalogPullRecorder({ storePath: linkStorePath(dir), now: () => 50, write: id => { writes.push(id); } });
    recorder.record({ linkId: null, keyId: "key-cdef", etag: "\"e1\"" });
    recorder.record({ linkId: B, keyId: null, etag: "\"e2\"" });
    expect(recorder.pulled(A)).toEqual({ at: 50, etag: "\"e1\"" });
    expect(recorder.pulledAt(B)).toBe(50);
    await tick();
    expect(writes.sort()).toEqual([A, B]);
  });

  test("a key no link holds, an unknown link and a damaged store record nothing", async () => {
    const dir = configDir(); writeLinks(dir, [A]);
    const writes: string[] = [];
    const recorder = createCatalogPullRecorder({ storePath: linkStorePath(dir), write: id => { writes.push(id); } });
    recorder.record({ linkId: null, keyId: "key-unknown", etag: "\"e\"" });
    recorder.record({ linkId: null, keyId: null, etag: "\"e\"" });
    recorder.record({ linkId: B, keyId: null, etag: "\"e\"" });
    writeFileSync(linkStorePath(dir), "{ damaged");
    recorder.record({ linkId: A, keyId: null, etag: "\"e\"" });
    await tick();
    expect(recorder.pulled(A)).toBeNull();
    expect(recorder.pulled(B)).toBeNull();
    expect(writes).toEqual([]);
  });

  test("writes at most once per 30 s and retries a failed write", async () => {
    const dir = configDir(); writeLinks(dir, [A]);
    let clock = 0;
    const writes: Array<{ at: number; etag: string }> = [];
    let failNext = false;
    const recorder = createCatalogPullRecorder({ storePath: linkStorePath(dir), now: () => clock, write: (_id, pull) => {
      if (failNext) { failNext = false; throw new ConfigMutationLockError("busy"); }
      writes.push(pull);
    } });
    recorder.record({ linkId: A, keyId: null, etag: "\"e1\"" });
    await tick();
    clock = 10_000;
    recorder.record({ linkId: A, keyId: null, etag: "\"e2\"" });
    await tick();
    expect(writes).toEqual([{ at: 0, etag: "\"e1\"" }]);
    expect(recorder.pulled(A)).toEqual({ at: 10_000, etag: "\"e2\"" });
    clock = 31_000;
    failNext = true;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      recorder.record({ linkId: A, keyId: null, etag: "\"e3\"" });
      await tick();
      expect(writes).toHaveLength(1);
      expect(warn.mock.calls.map(call => String(call[0]))).toEqual(["[link] catalog pull write failed linkId=" + A + " error=ConfigMutationLockError"]);
    } finally { warn.mockRestore(); }
    recorder.flush();
    expect(writes).toEqual([{ at: 0, etag: "\"e1\"" }, { at: 31_000, etag: "\"e3\"" }]);
    recorder.flush();
    expect(writes).toHaveLength(2);
  });

  test("a pull write keeps observedAt", async () => {
    const dir = configDir(); writeLinks(dir, [A]);
    const path = childObservationsPath(dir);
    writeFileSync(path, JSON.stringify({ schema: CHILD_OBSERVATIONS_SCHEMA, homeCatalog: null, children: { [A]: {
      observedAt: "2026-11-01T00:00:00.000Z", source: "plan", installedVersion: "2.97.0", installKind: "bun", runtimeOwner: "service",
      updateRoute: "none", updateReason: "up-to-date", targetVersion: "2.97.0", catalogPulledAt: null, lastOperation: null, suppressedTarget: null,
      catalogPulledEtag: null, catalogSyncedEtag: null, autoUpdateAttempts: null, updateInFlight: false, pendingUpdateRecovery: null } } }));
    const recorder = createCatalogPullRecorder({ storePath: linkStorePath(dir), now: () => 1_800_000_000_000 });
    recorder.record({ linkId: A, keyId: null, etag: "\"e9\"" });
    await tick();
    expect(readChildObservations(path).children[A]).toMatchObject({ observedAt: "2026-11-01T00:00:00.000Z", catalogPulledAt: 1_800_000_000_000, catalogPulledEtag: "\"e9\"" });
  });
});

describe("catalog revision monitor", () => {
  function monitorFor(path: string, options: { now?: () => number; stored?: CatalogRevision | null; persist?: (revision: CatalogRevision) => void } = {}) {
    const reads: string[] = [];
    const persisted: CatalogRevision[] = [];
    const monitor = createCatalogRevisionMonitor({
      catalogPath: () => path,
      read: target => { reads.push(target); try { return readFileSync(target, "utf8"); } catch { return null; } },
      load: () => options.stored ?? null,
      persist: options.persist ?? (revision => { persisted.push(revision); }),
      now: options.now ?? (() => 9_999_999_999_999),
    });
    return { monitor, reads, persisted };
  }

  test("hashes only on size/mtime change; changedAt is the mtime", () => {
    const dir = configDir();
    const path = join(dir, "catalog.json");
    writeFileSync(path, "{\"models\":[]}");
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    const { monitor, reads, persisted } = monitorFor(path);
    const first = monitor.current();
    expect(first).toEqual({ etag: catalogEtag("{\"models\":[]}"), changedAt: 1_700_000_000_000 });
    expect(monitor.current()).toEqual(first);
    expect(reads).toHaveLength(1);
    expect(persisted).toEqual([first!]);
    writeFileSync(path, "{\"models\":[1]}");
    utimesSync(path, 1_700_000_100, 1_700_000_100);
    expect(monitor.current()).toEqual({ etag: catalogEtag("{\"models\":[1]}"), changedAt: 1_700_000_100_000 });
    expect(reads).toHaveLength(2);
    expect(persisted).toHaveLength(2);
  });

  test("a stored revision with the same etag is kept and not persisted again", () => {
    const dir = configDir();
    const path = join(dir, "catalog.json");
    writeFileSync(path, "{}");
    const stored = { etag: catalogEtag("{}"), changedAt: 5 };
    const { monitor, persisted } = monitorFor(path, { stored });
    expect(monitor.current()).toEqual(stored);
    expect(persisted).toEqual([]);
  });

  test("changedAt never lies in the future", () => {
    const dir = configDir();
    const path = join(dir, "catalog.json");
    writeFileSync(path, "{}");
    utimesSync(path, 2_000_000_000, 2_000_000_000);
    expect(monitorFor(path, { now: () => 1_000 }).monitor.current()).toEqual({ etag: catalogEtag("{}"), changedAt: 1_000 });
  });

  test("restored file with an older mtime reads behind", () => {
    const dir = configDir();
    const path = join(dir, "catalog.json");
    writeFileSync(path, "{\"v\":2}");
    utimesSync(path, 1_700_000_200, 1_700_000_200);
    const { monitor } = monitorFor(path);
    const newer = monitor.current()!;
    const pulledEtag = newer.etag;
    expect(catalogVerdict(pulledEtag, null, newer)).toBe("current");
    // The operator restores an older catalog whose preserved mtime is older than the pull.
    writeFileSync(path, "{\"v\":1}");
    utimesSync(path, 1_600_000_000, 1_600_000_000);
    const restored = monitor.current()!;
    expect(restored.etag).not.toBe(pulledEtag);
    expect(catalogVerdict(pulledEtag, null, restored)).toBe("behind");
  });

  test("unreadable catalog is unknown", () => {
    const dir = configDir();
    const { monitor } = monitorFor(join(dir, "missing.json"));
    expect(monitor.current()).toBeNull();
    expect(catalogVerdict("\"e\"", null, monitor.current())).toBe("unknown");
  });

  test("a held config lock keeps the revision in memory and the next read persists it", () => {
    const dir = configDir();
    const path = join(dir, "catalog.json");
    writeFileSync(path, "{}");
    let busy = true;
    const saved: CatalogRevision[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { monitor } = monitorFor(path, { persist: revision => { if (busy) throw new ConfigMutationLockError("busy"); saved.push(revision); } });
      const revision = monitor.current();
      expect(revision?.etag).toBe(catalogEtag("{}"));
      expect(saved).toEqual([]);
      busy = false;
      expect(monitor.current()).toEqual(revision);
      expect(saved).toEqual([revision!]);
    } finally { warn.mockRestore(); }
  });

  test("verdicts current/behind/unknown", () => {
    const revision = { etag: "\"now\"", changedAt: 10 };
    expect(catalogVerdict(null, null, revision)).toBe("unknown");
    expect(catalogVerdict("\"now\"", null, null)).toBe("unknown");
    expect(catalogVerdict("\"now\"", null, revision)).toBe("current");
    expect(catalogVerdict("\"old\"", "\"now\"", revision)).toBe("current");
    expect(catalogVerdict("\"old\"", null, revision)).toBe("behind");
    expect(catalogVerdict(null, "\"old\"", revision)).toBe("behind");
  });
});

describe("relay catalog pull hook", () => {
  const body = ["{\"models\":[{\"slug\":", "\"a\"}]}"];
  function harness() {
    const served: LinkCatalogServed[] = [];
    const h = relayHarness({ catalogServed: value => { served.push(value); } });
    return { h, served };
  }

  test("a completed body reports the session link and catalogEtag(body)", async () => {
    const { h, served } = harness();
    const nonce = await h.session(A);
    const response = await h.dispatch(h.request("/v1/catalog", { nonce }), async () => chunkedResponse(body, { status: 200 }));
    expect(await response.text()).toBe(body.join(""));
    expect(served).toEqual([{ linkId: A, keyId: null, etag: catalogEtag(body.join("")) }]);
  });

  test("cancel mid-body, HEAD, a query and a 404 report nothing", async () => {
    const { h, served } = harness();
    const cancelled = await h.dispatch(h.request("/v1/catalog", { nonce: await h.session(A) }), async () => chunkedResponse(body, { status: 200 }));
    const reader = cancelled.body!.getReader();
    await reader.read();
    await reader.cancel();
    await (await h.dispatch(h.request("/v1/catalog", { method: "HEAD", nonce: await h.session(A) }), async () => new Response(null, { status: 200 }))).text();
    await (await h.dispatch(h.request("/v1/catalog?x=1", { nonce: await h.session(A) }), async () => chunkedResponse(body, { status: 200 }))).text();
    await (await h.dispatch(h.request("/v1/catalog", { nonce: await h.session(A) }), async () => chunkedResponse(["missing"], { status: 404 }))).text();
    expect(served).toEqual([]);
  });

  test("aborted body records nothing", async () => {
    const { h, served } = harness();
    const controller = new AbortController();
    const response = await h.dispatch(h.request("/v1/catalog", { nonce: await h.session(A), signal: controller.signal }),
      async () => chunkedResponse(body, { status: 200 }, async index => { if (index === 1) await new Promise(resolve => setTimeout(resolve, 10)); }));
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.read().catch(() => undefined);
    expect(served).toEqual([]);
  });

  test("legacy admission reports the x-opencodex-key-id key and a null link", async () => {
    const { h, served } = harness();
    const response = await h.dispatch(h.request("/v1/catalog"), async () => chunkedResponse(body, { status: 200, headers: { "x-opencodex-key-id": "key-cdef" } }));
    await response.text();
    expect(served).toEqual([{ linkId: null, keyId: "key-cdef", etag: catalogEtag(body.join("")) }]);
  });

  test("a recorder that throws or returns a never-settling promise still closes the stream and releases the session", async () => {
    for (const catalogServed of [() => { throw new Error("boom"); }, () => { void new Promise(() => {}); }]) {
      const h = relayHarness({ catalogServed });
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const response = await h.dispatch(h.request("/v1/catalog", { nonce: await h.session(A) }), async () => chunkedResponse(body, { status: 200 }));
        expect(await response.text()).toBe(body.join(""));
        await h.sessions.drain();
      } finally { warn.mockRestore(); }
    }
  });

  test("the relay etag equals catalogEtag of the serialized catalog bytes", async () => {
    const catalog = { models: [{ slug: "gpt-x", display_name: "Ünïcode ✓" }] };
    const serialized = JSON.stringify(catalog);
    const { h, served } = harness();
    const bytes = new TextEncoder().encode(serialized);
    const response = await h.dispatch(h.request("/v1/catalog", { nonce: await h.session(A) }), async () =>
      new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 7)); controller.enqueue(bytes.slice(7)); controller.close(); } }), { status: 200 }));
    await response.arrayBuffer();
    expect(served[0]?.etag).toBe(catalogEtag(serialized));
  });
});

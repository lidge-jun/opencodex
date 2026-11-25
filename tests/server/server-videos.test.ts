/**
 * Public OpenAI Videos routes (#9110): `POST /v1/videos`, `GET /v1/videos/{id}` and `/content`.
 * Handler-level cases on a fake resolver and pinned transport; nothing opens a socket and a raw
 * fetch fails the test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoOutboundDependencies } from "../../src/images/xai-video-client";
import { resolvePublicAddresses } from "../../src/lib/destination-policy";
import { MODEL_NOT_ALLOWED_FOR_KEY } from "../../src/server/admission-model-scope";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { RequestLogContext } from "../../src/server/request-log";
import { setVideoHandleKeyForTests } from "../../src/server/video-handle";
import { matchVideoRoute } from "../../src/lib/video-routes";
import { handleVideos, setVideoCreateBodyTimeoutForTests, setVideoOutboundDependenciesForTests } from "../../src/server/videos";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import type { AdmissionLease } from "../../src/lib/admission";

const HOST = "videos.relay.example";
const KEY = "synthetic-video-row-key";
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 9, 9, 9, 9]);
const ALICE: DataPlaneAdmission = { kind: "configured", keyId: "alice", source: "bearer" };
const BOB: DataPlaneAdmission = { kind: "configured", keyId: "bob", source: "bearer" };
const ALICE_SECRET = "ocx_data_" + "a".repeat(40);
const BOB_SECRET = "ocx_data_" + "b".repeat(40);
const secretFor = (admission: DataPlaneAdmission) => admission === BOB ? BOB_SECRET : ALICE_SECRET;

type Sent = { method: string; url: string; address: string; authorization: string | null; body?: Record<string, unknown> };
let sent: Sent[] = [];
let answer: (entry: Sent) => Response = () => Response.json({});
let rawFetches: string[] = [];
const realFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home = "";

const deps: VideoOutboundDependencies = {
  resolveAddresses: async (url, options) => {
    const target = new URL(url);
    if (target.hostname !== HOST) throw new Error("unexpected DNS lookup for " + target.hostname);
    target.hostname = "93.184.216.34";
    return { ...(await resolvePublicAddresses(target.toString(), options)), hostname: HOST };
  },
  pinnedPost: async (url, pinned, body, _signal, options) => {
    const entry = { method: "POST", url, address: pinned.address, authorization: new Headers(options?.headers).get("authorization"), body: JSON.parse(body) };
    sent.push(entry);
    return answer(entry);
  },
  pinnedGet: async (url, pinned, _signal, options) => {
    const entry = { method: "GET", url, address: pinned.address, authorization: new Headers(options?.headers).get("authorization") };
    sent.push(entry);
    return answer(entry);
  },
};

beforeEach(() => {
  sent = [];
  rawFetches = [];
  home = mkdtempSync(join(tmpdir(), "ocx-videos-route-"));
  process.env.OPENCODEX_HOME = home;
  globalThis.fetch = (async (input: string | URL | Request) => {
    rawFetches.push(String(input instanceof Request ? input.url : input));
    return Response.json({ id: "leaked" });
  }) as typeof fetch;
  setVideoOutboundDependenciesForTests(deps);
  setVideoHandleKeyForTests(Buffer.alloc(32, 7));
});
afterEach(() => {
  setVideoOutboundDependenciesForTests(undefined);
  setVideoHandleKeyForTests(undefined);
  globalThis.fetch = realFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
});

const videoRow = (overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig => ({
  adapter: "openai-chat", baseUrl: "https://" + HOST + "/v1", apiKey: KEY, authMode: "key", noProxy: HOST, videoApi: "openai", ...overrides,
} as OcxProviderConfig);

function config(overrides: Partial<OcxConfig> = {}, rows: Record<string, OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 0, hostname: "127.0.0.1", defaultProvider: "aistudio",
    providers: { aistudio: videoRow(), plain: videoRow({ videoApi: undefined }), ...rows },
    apiKeys: [
      { id: "alice", name: "a", key: ALICE_SECRET, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "bob", name: "b", key: BOB_SECRET, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    ...overrides,
  } as OcxConfig;
}

const logContext = (): RequestLogContext => ({ model: "video", provider: "unknown" } as RequestLogContext);

async function call(cfg: OcxConfig, method: string, path: string, body?: BodyInit, admission = ALICE, headers: Record<string, string> = { "content-type": "application/json" }, secret = secretFor(admission)) {
  const url = new URL("http://localhost" + path);
  headers = { ...headers, authorization: "Bearer " + secret };
  const route = matchVideoRoute(method, url.pathname);
  if (!route) throw new Error("no video route for " + method + " " + path);
  const logCtx = logContext();
  const req = new Request(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const response = await handleVideos(req, url, cfg, route, logCtx, admission);
  return { response, logCtx };
}

async function create(cfg: OcxConfig, body: Record<string, unknown>, admission = ALICE) {
  answer = () => Response.json({ id: "video_up_1", object: "video", status: "queued", model: "gemini-omni-1.1-flash", progress: 0 });
  return call(cfg, "POST", "/v1/videos", JSON.stringify(body), admission);
}

describe("POST /v1/videos", () => {
  test("<provider>/<model> selects the row; the upstream gets the bare model and the row key; the id becomes a handle", async () => {
    const { response, logCtx } = await create(config(), { model: "aistudio/gemini-omni-1.1-flash", prompt: "a fox", seconds: "8" });
    expect(response.status).toBe(200);
    const job = await response.json() as { id: string; status: string };
    expect(job.status).toBe("queued");
    expect(job.id.startsWith("video_ocx_")).toBe(true);
    expect(job.id).not.toContain("video_up_1");
    expect(sent).toEqual([{
      method: "POST", url: "https://" + HOST + "/v1/videos", address: "93.184.216.34", authorization: "Bearer " + KEY,
      body: { model: "gemini-omni-1.1-flash", prompt: "a fox", seconds: "8" },
    }]);
    expect(logCtx).toMatchObject({ provider: "aistudio", model: "gemini-omni-1.1-flash" });
    expect(rawFetches).toEqual([]);
  });

  test("a bare model goes to images.videoProvider", async () => {
    const { response } = await create(config({ images: { videoProvider: "aistudio" } }), { model: "veo-like", prompt: "p" });
    expect(response.status).toBe(200);
    expect(sent[0]!.body).toEqual({ model: "veo-like", prompt: "p" });
  });

  test("refusals are final and send nothing: no provider, a row without videoApi openai, a registry row, a disabled row", async () => {
    const cases: Array<[OcxConfig, Record<string, unknown>, string]> = [
      [config(), { model: "unprefixed", prompt: "p" }, "no video provider"],
      [config({ images: { videoProvider: "aistudio" } }), { model: "aistudoi/m", prompt: "p" }, "names no configured provider"],
      [config(), { model: "aistudio/" + "m".repeat(300), prompt: "p" }, "at most 256 bytes"],
      [config(), { model: "plain/m", prompt: "p" }, 'set "videoApi": "openai"'],
      [config({}, { xai: videoRow({ baseUrl: "https://api.x.ai/v1" }) }), { model: "xai/grok-imagine-video-1.5", prompt: "p" }, "OpenAI Videos API"],
      [config({}, { aistudio: videoRow({ disabled: true }) }), { model: "aistudio/m", prompt: "p" }, "is disabled"],
      [config({}, { aistudio: videoRow({ baseUrl: "http://127.0.0.1:2048/v1" }) }), { model: "aistudio/m", prompt: "p" }, "allowPrivateNetwork"],
    ];
    for (const [cfg, body, message] of cases) {
      const { response } = await create(cfg, body);
      expect(response.status).toBe(400);
      expect((await response.json() as { error: { message: string } }).error.message).toContain(message);
    }
    expect(sent).toEqual([]);
    expect(rawFetches).toEqual([]);
  });

  test("a missing prompt and a non-object body are refused before any send", async () => {
    expect((await create(config(), { model: "aistudio/m" })).response.status).toBe(400);
    expect((await call(config(), "POST", "/v1/videos", "[1]")).response.status).toBe(400);
    expect(sent).toEqual([]);
  });

  test("a key scoped away from the row is refused before the paid create", async () => {
    const cfg = config();
    cfg.apiKeys![0] = { ...cfg.apiKeys![0]!, allowedProviders: ["somewhere-else"] };
    const { response } = await create(cfg, { model: "aistudio/m", prompt: "p" });
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { type: string } }).error.type).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
    expect(sent).toEqual([]);
  });

  test("an upstream rejection keeps its 4xx status without reflecting upstream text", async () => {
    answer = () => Response.json({ error: { message: "secret-ish upstream detail" } }, { status: 400 });
    const { response } = await call(config(), "POST", "/v1/videos", JSON.stringify({ model: "aistudio/m", prompt: "p" }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("secret-ish");
  });

  test("multipart create (the OpenAI Python SDK shape) becomes JSON with the reference image as a data URL", async () => {
    const form = new FormData();
    form.set("model", "aistudio/m");
    form.set("prompt", "animate this");
    form.set("seconds", "4");
    form.set("input_reference", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "ref.png", { type: "image/png" }));
    answer = () => Response.json({ id: "video_up_2", status: "queued" });
    const req = new Request("http://localhost/v1/videos", { method: "POST", body: form });
    // Bun reports a FormData request's content-type only before its body is read.
    const contentType = req.headers.get("content-type")!;
    const { response } = await call(config(), "POST", "/v1/videos", await req.arrayBuffer(), ALICE, { "content-type": contentType });
    expect(response.status).toBe(200);
    expect(sent[0]!.body).toEqual({ model: "m", prompt: "animate this", seconds: "4", input_reference: { image_url: "data:image/png;base64,iVBORw==" } });
  });
});

describe("GET /v1/videos/{id} and /content", () => {
  async function handleFor(cfg = config(), admission = ALICE): Promise<string> {
    const { response } = await create(cfg, { model: "aistudio/gemini-omni-1.1-flash", prompt: "p" }, admission);
    sent = [];
    return (await response.json() as { id: string }).id;
  }

  test("retrieve returns to the row that created the job, with its key, and keeps the handle as id", async () => {
    const handle = await handleFor();
    answer = () => Response.json({ id: "video_up_1", status: "completed", progress: 100, error: null });
    const { response, logCtx } = await call(config(), "GET", "/v1/videos/" + handle);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: handle, status: "completed" });
    expect(sent).toEqual([{ method: "GET", url: "https://" + HOST + "/v1/videos/video_up_1", address: "93.184.216.34", authorization: "Bearer " + KEY }]);
    expect(logCtx).toMatchObject({ provider: "aistudio", model: "gemini-omni-1.1-flash" });
  });

  test("another key, an edited handle and an unknown id all read as not found and send nothing", async () => {
    const handle = await handleFor();
    const edited = handle.slice(0, -2) + (handle.endsWith("AA") ? "AB" : "AA");
    for (const [path, admission] of [["/v1/videos/" + handle, BOB], ["/v1/videos/" + edited, ALICE], ["/v1/videos/video_up_1", ALICE], ["/v1/videos/" + handle + "/content", BOB]] as const) {
      const { response } = await call(config(), "GET", path, undefined, admission);
      expect(response.status).toBe(404);
    }
    expect(sent).toEqual([]);
  });

  test("a row disabled after the create is refused on poll; nothing falls back", async () => {
    const handle = await handleFor();
    const { response } = await call(config({}, { aistudio: videoRow({ disabled: true }) }), "GET", "/v1/videos/" + handle);
    expect(response.status).toBe(400);
    expect(sent).toEqual([]);
  });

  test("content streams the upstream bytes with a fixed media type and nosniff", async () => {
    const handle = await handleFor();
    answer = () => new Response(MP4, { headers: { "content-type": "video/mp4", "content-length": String(MP4.byteLength) } });
    const { response } = await call(config(), "GET", "/v1/videos/" + handle + "/content");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP4);
    expect(sent).toEqual([{ method: "GET", url: "https://" + HOST + "/v1/videos/video_up_1/content", address: "93.184.216.34", authorization: "Bearer " + KEY }]);
  });

  test("content never relays an active media type and passes only known variants", async () => {
    const handle = await handleFor();
    answer = () => new Response("<script>x</script>", { headers: { "content-type": "text/html" } });
    const { response } = await call(config(), "GET", "/v1/videos/" + handle + "/content?variant=thumbnail");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(sent[0]!.url).toBe("https://" + HOST + "/v1/videos/video_up_1/content?variant=thumbnail");
    sent = [];
    expect((await call(config(), "GET", "/v1/videos/" + handle + "/content?variant=../x")).response.status).toBe(400);
    expect(sent).toEqual([]);
  });

  test("a declared oversized asset is refused", async () => {
    const handle = await handleFor();
    answer = () => new Response(MP4, { headers: { "content-type": "video/mp4", "content-length": String(500 * 1024 * 1024) } });
    const { response } = await call(config(), "GET", "/v1/videos/" + handle + "/content");
    expect(response.status).toBe(502);
  });
});

describe("review regressions", () => {
  test("a slash-containing model reaches images.videoProvider only when written behind its provider", async () => {
    const { response } = await create(config({ images: { videoProvider: "aistudio" } }), { model: "aistudio/google/veo-like", prompt: "p" });
    expect(response.status).toBe(200);
    expect(sent[0]!.body).toEqual({ model: "google/veo-like", prompt: "p" });
  });

  test("an unusable handle key refuses the create before the paid request", async () => {
    setVideoHandleKeyForTests(undefined);
    writeFileSync(join(home, "video-handle-key"), "not-a-key\n", { mode: 0o600 });
    const { response } = await create(config(), { model: "aistudio/m", prompt: "p" });
    expect(response.status).toBe(500);
    expect(sent).toEqual([]);
  });

  test("an upstream that echoes the row key or free text in any job field hands none of it to the caller", async () => {
    answer = () => Response.json({
      id: "video_up_1", object: KEY, status: KEY, model: KEY, seconds: KEY, size: KEY, prompt: KEY, debug: { auth: "Bearer " + KEY },
      remixed_from_video_id: KEY, progress: 10, created_at: 1700000000,
      error: { code: KEY, message: "upstream said " + KEY, param: KEY, type: KEY },
    });
    const { response } = await call(config(), "POST", "/v1/videos", JSON.stringify({ model: "aistudio/m", prompt: "p" }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(KEY);
    const job = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(job).sort()).toEqual(["created_at", "error", "id", "model", "object", "progress"]);
    expect(job).toMatchObject({ object: "video", model: "m", progress: 10, error: { message: "video generation failed" } });
  });

  test("a secret shaped like a status, error code or job id is never reflected, not even inside the handle", async () => {
    const secret = "synthetic_secret_123abc";
    answer = () => Response.json({ id: secret, status: "synthetic_secret", error: { code: secret, message: secret } });
    const { response } = await call(config(), "POST", "/v1/videos", JSON.stringify({ model: "aistudio/m", prompt: "p" }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("synthetic_secret");
    const job = JSON.parse(text) as { id: string; status?: string; error?: { code?: string } };
    expect(job.status).toBeUndefined();
    expect(job.error?.code).toBeUndefined();
    expect(Buffer.from(job.id.slice("video_ocx_".length), "base64url").toString("latin1")).not.toContain(secret);
  });

  test("a replacement secret on the same key id does not open the previous holder's handle", async () => {
    const { response } = await create(config(), { model: "aistudio/m", prompt: "p" });
    const handle = (await response.json() as { id: string }).id;
    sent = [];
    const replaced = config();
    replaced.apiKeys![0] = { ...replaced.apiKeys![0]!, key: "ocx_data_" + "z".repeat(40) };
    const poll = await call(replaced, "GET", "/v1/videos/" + handle, undefined, ALICE, {}, "ocx_data_" + "z".repeat(40));
    expect(poll.response.status).toBe(404);
    expect(sent).toEqual([]);
    expect((await call(config(), "GET", "/v1/videos/" + handle, undefined, ALICE, {})).response.status).not.toBe(404);
  });
});

describe("turn lease and listener timeout", () => {
  test("shutdown aborts the in-flight paid create through the turn lease and answers 503", async () => {
    let bound: AbortController | undefined;
    const lease = { bindAbortController(ac: AbortController) { bound = ac; } } as unknown as AdmissionLease;
    let started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    setVideoOutboundDependenciesForTests({
      ...deps,
      pinnedPost: async (url, pinned, body, signal) => {
        sent.push({ method: "POST", url, address: pinned.address, authorization: null, body: JSON.parse(body) });
        started();
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const url = new URL("http://localhost/v1/videos");
    const req = new Request(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + ALICE_SECRET }, body: JSON.stringify({ model: "aistudio/m", prompt: "p" }) });
    const pending = handleVideos(req, url, config(), { kind: "create" }, logContext(), ALICE, { lease });
    await sending;
    expect(bound).toBeDefined();
    bound!.abort(new Error("shutdown"));
    const response = await pending;
    expect(response.status).toBe(503);
    expect((await response.json() as { error: { message: string } }).error.message).toBe("video create stopped during shutdown");
    expect(sent).toHaveLength(1);
  });

  test("a create body that keeps trickling is cut off at the whole-body deadline and never reaches upstream", async () => {
    setVideoCreateBodyTimeoutForTests(80);
    let cancelled = false;
    let tick: ReturnType<typeof setInterval> | undefined;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"model":"aistudio/m","prompt":"'));
        // A byte every 10 ms: never idle long enough for an inactivity timeout, never finished.
        tick = setInterval(() => { try { controller.enqueue(encoder.encode("p")); } catch { clearInterval(tick); } }, 10);
      },
      cancel() { cancelled = true; clearInterval(tick); },
    });
    try {
      const url = new URL("http://localhost/v1/videos");
      const req = new Request(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + ALICE_SECRET }, body, duplex: "half" } as RequestInit);
      const events: string[] = [];
      const response = await handleVideos(req, url, config(), { kind: "create" }, logContext(), ALICE, { onRequestBodyRead: () => events.push("body-read") });
      expect(response.status).toBe(408);
      expect(cancelled).toBe(true);
      expect(events).toEqual([]);
      expect(sent).toEqual([]);
    } finally {
      clearInterval(tick);
      setVideoCreateBodyTimeoutForTests(undefined);
    }
  });

  test("the listener timeout is lifted only after the create body was read", async () => {
    const events: string[] = [];
    answer = () => { events.push("upstream"); return Response.json({ id: "video_up_9", status: "queued" }); };
    const url = new URL("http://localhost/v1/videos");
    const headers = { "content-type": "application/json", authorization: "Bearer " + ALICE_SECRET };
    const ok = await handleVideos(new Request(url, { method: "POST", headers, body: JSON.stringify({ model: "aistudio/m", prompt: "p" }) }),
      url, config(), { kind: "create" }, logContext(), ALICE, { onRequestBodyRead: () => events.push("body-read") });
    expect(ok.status).toBe(200);
    expect(events).toEqual(["body-read", "upstream"]);
    events.length = 0;
    const bad = await handleVideos(new Request(url, { method: "POST", headers, body: "{not json" }),
      url, config(), { kind: "create" }, logContext(), ALICE, { onRequestBodyRead: () => events.push("body-read") });
    expect(bad.status).toBe(400);
    expect(events).toEqual([]);
  });
});

test("the loopback listener hands /v1/videos paths to the same matcher and nothing broader", async () => {
  const source = await Bun.file(repoPath("src", "server", "index.ts")).text();
  const start = source.indexOf("function loopbackRouteAllowed");
  const gate = source.slice(start, source.indexOf("\n  }", start));
  expect(gate).toContain('if (path === "/v1/videos" || path.startsWith("/v1/videos/")) return matchVideoRoute(req.method, path) !== undefined;');
  // The one gate line names the bare path and its subtree, and delegates both to matchVideoRoute.
  expect(gate.match(/\/v1\/videos/g)?.length).toBe(2);
});

test("route matching admits only the three documented shapes", () => {
  expect(matchVideoRoute("POST", "/v1/videos")).toEqual({ kind: "create" });
  expect(matchVideoRoute("GET", "/v1/videos/abc")).toEqual({ kind: "retrieve", handle: "abc" });
  expect(matchVideoRoute("GET", "/v1/videos/abc/content")).toEqual({ kind: "content", handle: "abc" });
  for (const [method, path] of [["GET", "/v1/videos"], ["DELETE", "/v1/videos/abc"], ["POST", "/v1/videos/abc/remix"], ["GET", "/v1/videos/a/b"], ["GET", "/v1/videos/%E0%A4%A"]]) {
    expect(matchVideoRoute(method!, path!)).toBeUndefined();
  }
});

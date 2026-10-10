import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { en } from "../src/i18n/en";
import { interpolate, type TFn } from "../src/i18n/shared";
import { useAutoReviewSettings, type AutoReviewSettingsController } from "../src/pages/use-auto-review-settings";

const t: TFn = (key, vars) => interpolate(en[key], vars);
const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let win: Window;
let host: HTMLElement;
let root: Root;
let controller: AutoReviewSettingsController;
let requests: Array<{ url: string; init?: RequestInit }>;
let feedback: Array<[boolean, string]>;
let respond: (url: string, init?: RequestInit) => Promise<Response>;

function response(payload: unknown, status = 200): Response { return Response.json(payload, { status }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function Harness({ apiBase }: { apiBase: string }) {
  controller = useAutoReviewSettings(apiBase, t, (ok, message) => feedback.push([ok, message]));
  return null;
}
async function paint(apiBase: string) {
  await act(async () => { root.render(<Harness apiBase={apiBase} />); });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  requests = []; feedback = [];
  respond = async () => response({ enabled: false, model: "" });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return respond(String(input), init);
  } });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await win.happyDOM.close();
});

test("A-to-B-to-A ignores the first base's late GET result", async () => {
  const abandoned = deferred<Response>();
  const currentA = deferred<Response>();
  let aReads = 0;
  respond = async url => {
    if (url.startsWith("/a/")) return ++aReads === 1 ? abandoned.promise : currentA.promise;
    return response({ enabled: false, model: "server-b/model" });
  };

  await paint("/a");
  let abandonedRead!: Promise<void>;
  await act(async () => { abandonedRead = controller.load(); });
  const oldSignal = requests[0]!.init!.signal!;
  await paint("/b");
  expect(oldSignal.aborted).toBe(true);
  await act(async () => { await controller.load(); });
  expect(controller.data).toEqual({ enabled: false, model: "server-b/model" });

  await paint("/a");
  let freshRead!: Promise<void>;
  await act(async () => { freshRead = controller.load(); });
  expect(controller.data).toBeNull();
  await act(async () => { abandoned.resolve(response({ enabled: true, model: "stale-a/model" })); await abandonedRead; });
  expect(controller.data).toBeNull();
  await act(async () => { currentA.resolve(response({ enabled: false, model: "fresh-a/model" })); await freshRead; });
  expect(controller.data).toEqual({ enabled: false, model: "fresh-a/model" });
});

test("failed save reloads the confirmed server value and reports the error", async () => {
  let reads = 0;
  respond = async (_url, init) => {
    if (init?.method === "PUT") return response({ error: "save rejected" }, 500);
    reads++;
    return response({ enabled: false, model: reads === 1 ? "initial/model" : "current-on-server/model" });
  };
  await paint("/a");
  await act(async () => { await controller.load(); });
  await act(async () => { await controller.save({ enabled: true }); });
  expect(controller.data).toEqual({ enabled: false, model: "current-on-server/model" });
  expect(feedback).toEqual([[false, "save rejected"]]);
});

test("failed save keeps the confirmed value when reconciliation also fails", async () => {
  let reads = 0;
  respond = async (_url, init) => {
    if (init?.method === "PUT") return response({ error: "save rejected" }, 500);
    reads++;
    return reads === 1
      ? response({ enabled: false, model: "confirmed/model" })
      : response({ error: "offline" }, 503);
  };
  await paint("/a");
  await act(async () => { await controller.load(); });
  await act(async () => { await controller.save({ enabled: true }); });
  expect(controller.data).toEqual({ enabled: false, model: "confirmed/model" });
  expect(feedback).toEqual([[false, "save rejected"]]);
});

test("saved settings report an uncommitted catalog refresh", async () => {
  respond = async (_url, init) => init?.method === "PUT"
    ? response({ ok: true, enabled: true, model: "router/reviewer", catalogRefresh: { status: "skipped" } })
    : response({ enabled: false, model: "" });
  await paint("/a");
  await act(async () => { await controller.load(); });
  await act(async () => { await controller.save({ enabled: true, model: "router/reviewer" }); });
  expect(controller.data).toEqual({ enabled: true, model: "router/reviewer" });
  expect(feedback).toEqual([[false, en["codexAuth.catalogRefreshPending"]]]);
});

test("a stale save response after a proxy change cannot overwrite the new proxy", async () => {
  const write = deferred<Response>();
  respond = async (url, init) => {
    if (url.startsWith("/a/") && init?.method === "PUT") return write.promise;
    if (url.startsWith("/b/")) return response({ enabled: false, model: "server-b/model" });
    return response({ enabled: false, model: "server-a/model" });
  };
  await paint("/a");
  await act(async () => { await controller.load(); });
  let pendingSave!: Promise<void>;
  await act(async () => { pendingSave = controller.save({ enabled: true, model: "server-a/reviewer" }); });
  const signal = requests.find(request => request.init?.method === "PUT")!.init!.signal!;

  await paint("/b");
  expect(signal.aborted).toBe(true);
  await act(async () => { await controller.load(); });
  await act(async () => {
    write.resolve(response({ ok: true, enabled: true, model: "server-a/reviewer", catalogRefresh: { status: "committed" } }));
    await pendingSave;
  });
  expect(controller.data).toEqual({ enabled: false, model: "server-b/model" });
  expect(feedback).toHaveLength(0);
});

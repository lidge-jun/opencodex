import { describe, expect, test } from "bun:test";
import { deepSeekImageFileBody, needsDeepSeekImageFiles } from "../../src/server/responses/deepseek-image-files";
import type { AdapterRequest } from "../../src/adapters/base";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, setProviderRequestPacingRuntimeForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { handleResponses } from "../../src/server/responses/core";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const optIn = { allowedModels: ["deepseek-flash"] };
const image = `data:image/png;base64,${Buffer.alloc(20 * 1024 * 1024, 7).toString("base64")}`;
/** Build an oversized, credential-scoped replay without sending real image data upstream. */
function request(key: string): AdapterRequest {
  return {
    url: "https://api.deepseek.com/responses", method: "POST",
    headers: { authorization: `Bearer test-image-${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "keep this text" }, { type: "input_image", image_url: image }] },
      { type: "custom_tool_call_output", call_id: "call1", output: [{ type: "input_image", image_url: image, detail: "original" }] },
    ] }),
  };
}

describe("DeepSeek image request body limits", () => {

  test("uploads require owner opt-in and can allow any explicitly compatible model", async () => {
    let sends = 0;
    const upload = (async () => { sends++; return Response.json({ id: "file-api-custom" }); }) as typeof fetch;
    const original = request("opt-in");
    expect(await deepSeekImageFileBody(original, upload)).toBeUndefined();
    const custom = { ...original, body: original.body.replace('"deepseek-flash"', '"deepseek-future-vision"') };
    expect(await deepSeekImageFileBody(custom, upload, undefined, optIn)).toBeUndefined();
    expect(sends).toBe(0);
    const budget = createTranslatorBudget();
    try {
      expect(await deepSeekImageFileBody(custom, upload, undefined, {
        allowedModels: ["deepseek-future-vision"], budget,
      })).toContain("file-api-custom");
      expect(budget.snapshot().highWaterBytes).toBeGreaterThan(Buffer.byteLength(custom.body) * 2);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { budget.dispose(); }
    expect(sends).toBe(1);
  });

  test("failed uploads release copy/multipart observations and allow a safe retry", async () => {
    const budget = createTranslatorBudget();
    const original = request("accounting-failure");
    try {
      await expect(deepSeekImageFileBody(original, (async () => new Response(null, { status: 503 })) as typeof fetch,
        undefined, { ...optIn, budget })).rejects.toThrow("HTTP 503");
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(await deepSeekImageFileBody(original, (async () => Response.json({ id: "file-api-retry" })) as typeof fetch,
        undefined, { ...optIn, budget })).toContain("file-api-retry");
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { budget.dispose(); }
  });

  test("uploads identical image bytes with expiry, preserves history, and reuses only same-account files", async () => {
    const original = request("reuse");
    const source = original.body;
    let sends = 0;
    const upload = (async (url, init) => {
      sends++;
      expect(url).toBe("https://api.deepseek.com/files");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("content-type")).toBeNull();
      const form = init!.body as FormData;
      expect(form.get("purpose")).toBe("user_data");
      expect(form.get("expires_after[seconds]")).toBe("3600");
      expect(Buffer.from(await (form.get("file") as Blob).arrayBuffer())).toEqual(Buffer.alloc(20 * 1024 * 1024, 7));
      return Response.json({ id: `file-api-upload${sends}`, expires_at: Date.now() / 1000 + 3600 });
    }) as typeof fetch;
    const built = await deepSeekImageFileBody(original, upload, undefined, optIn);
    expect(Buffer.byteLength(built!)).toBeLessThan(32 * 1024 * 1024);
    const body = JSON.parse(built!);
    expect(body.input[0].content[0].text).toBe("keep this text");
    expect(body.input[0].content[1]).toEqual({ type: "input_image", file_id: "file-api-upload1" });
    expect(body.input[1].output[0].image_url).toBe(image);
    expect(original.body).toBe(source);
    await deepSeekImageFileBody(original, upload, undefined, optIn);
    expect(sends).toBe(1);
    await deepSeekImageFileBody(request("other-account"), upload, undefined, optIn);
    expect(sends).toBe(2);
  });

  test("small requests, foreign destinations and unlisted models are untouched", async () => {
    let sends = 0;
    const upload = (async () => { sends++; throw new Error("must not send"); }) as typeof fetch;
    const large = request("scope");
    for (const url of ["https://api.openai.com/v1/responses", "http://api.deepseek.com/responses", "https://api.deepseek.com.evil.invalid/responses", "https://gateway.example/responses"]) {
      const other = { ...large, url };
      expect(needsDeepSeekImageFiles(other)).toBe(false);
      expect(await deepSeekImageFileBody(other, upload, undefined, optIn)).toBeUndefined();
    }
    expect(await deepSeekImageFileBody({ ...large, body: '{"model":"deepseek-flash","input":"hello"}' }, upload, undefined, optIn)).toBeUndefined();
    expect(await deepSeekImageFileBody({ ...large, body: large.body.replace('"deepseek-flash"', '"deepseek-v4-flash"') }, upload, undefined, optIn)).toBeUndefined();
    expect(sends).toBe(0);
  });

  test("upload refusal never drops an image or follows a redirect", async () => {
    const original = request("refusal");
    const source = original.body;
    let sends = 0;
    const upload = (async () => { sends++; return new Response("private upstream body", { status: 302, headers: { location: "https://elsewhere.invalid" } }); }) as typeof fetch;
    await expect(deepSeekImageFileBody(original, upload, undefined, optIn)).rejects.toThrow("HTTP 302");
    expect(sends).toBe(1);
    expect(original.body).toBe(source);
  });

  test("caller cancellation prevents uploads", async () => {
    const controller = new AbortController(); controller.abort();
    let sends = 0;
    const upload = (async () => { sends++; throw new Error("unexpected upload"); }) as typeof fetch;
    await expect(deepSeekImageFileBody(request("abort"), upload, controller.signal, optIn)).rejects.toThrow();
    expect(sends).toBe(0);
  });

  test("malformed file ids are not cached or forwarded", async () => {
    const upload = (async () => Response.json({ id: "untrusted\nreference" })) as typeof fetch;
    await expect(deepSeekImageFileBody(request("bad-id"), upload, undefined, optIn)).rejects.toThrow("invalid file reference");
  });

  test("provider expiry bounds cache reuse", async () => {
    let calls = 0;
    const upload = (async () => Response.json({ id: `file-api-expiry${++calls}`, expires_at: Date.now() / 1000 + 30 })) as typeof fetch;
    await deepSeekImageFileBody(request("expiry"), upload, undefined, optIn);
    await deepSeekImageFileBody(request("expiry"), upload, undefined, optIn);
    expect(calls).toBe(2);
  });

  test("only two bounded preparations can allocate upload workspace at once", async () => {
    let entered = 0;
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const upload = (async () => { entered++; await waiting; return Response.json({ id: "file-api-limited" }); }) as typeof fetch;
    const original = request("concurrency");
    const first = deepSeekImageFileBody(original, upload, undefined, optIn);
    const second = deepSeekImageFileBody(original, upload, undefined, optIn);
    try {
      expect(entered).toBe(2);
      await expect(deepSeekImageFileBody(original, upload, undefined, optIn)).rejects.toThrow("preparation is busy");
    } finally { finish(); await Promise.all([first, second]); }
    expect(await deepSeekImageFileBody(original, upload, undefined, optIn)).toContain("file-api-limited");
  });

  test("partial upload failure preserves history and retry reuses only successful files", async () => {
    const original = request("partial");
    const body = JSON.parse(original.body);
    body.input[1].output[0].image_url = image.replace("BwcH", "CAgI");
    body.input.push({ type: "message", role: "user", content: [{ type: "input_image", image_url: image.replace("BwcH", "CQkJ") }] });
    original.body = JSON.stringify(body);
    const source = original.body;
    let calls = 0;
    const upload = (async () => {
      calls++;
      return calls === 2 ? new Response(null, { status: 503 }) : Response.json({ id: `file-api-partial${calls}` });
    }) as typeof fetch;
    await expect(deepSeekImageFileBody(original, upload, undefined, optIn)).rejects.toThrow("HTTP 503");
    expect(original.body).toBe(source);
    expect(await deepSeekImageFileBody(original, upload, undefined, optIn)).toContain("file-api-partial1");
    expect(calls).toBe(3);
  });

  test("explicit low detail remains inline", async () => {
    const original = request("low");
    const body = JSON.parse(original.body);
    body.input[0].content[1].detail = "low";
    body.input[1].output[0].detail = "low";
    original.body = JSON.stringify(body);
    expect(await deepSeekImageFileBody(original, (async () => { throw new Error("unexpected upload"); }) as typeof fetch,
      undefined, optIn)).toBeUndefined();
  });

  test("images in roles DeepSeek rejects are never uploaded", async () => {
    for (const role of ["system", "assistant"]) {
      const original = request(role);
      const body = JSON.parse(original.body);
      body.input[0].role = role;
      body.input[1].output[0].detail = "low";
      original.body = JSON.stringify(body);
      expect(await deepSeekImageFileBody(original, (async () => { throw new Error("unexpected upload"); }) as typeof fetch,
        undefined, optIn)).toBeUndefined();
    }
  });

  test("credential changes while uploads queue prevent stale physical sends", async () => {
    const restoreFetch = globalThis.fetch;
    const releaseSpend = acquireOwnedSpendHome();
    resetProviderRequestPacingForTest();
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "test-queued-old",
      modelCapabilities: { "deepseek-flash": { deepseekImageFiles: true } }, requestPacing: { enabled: true, maxConcurrentRequests: 1 } };
    const config = { providers: { deepseek: provider } } as OcxConfig;
    const slot = await waitForProviderRequestSlot("deepseek", provider, "deepseek-flash");
    const seen: string[] = [];
    globalThis.fetch = (async (url, init) => {
      seen.push(`${String(url)}:${new Headers(init?.headers).get("authorization")}`);
      expect((providerRequestPacingStatus("deepseek", provider).inFlight ?? 0)).toBeLessThanOrEqual(1);
      return String(url).endsWith("/files") ? Response.json({ id: "file-api-queued" })
        : Response.json({ id: "resp_queued", object: "response", status: "completed", output: [] });
    }) as typeof fetch;
    const abort = AbortSignal.timeout(4_000);
    try {
      const pending = handleResponses(new Request("http://localhost/v1/responses", { method: "POST", signal: abort,
        headers: { "content-type": "application/json" }, body: request("queued").body }), config, { model: "", provider: "" });
      void pending.catch(() => {});
      const deadline = Date.now() + 2_000;
      while (!providerRequestPacingStatus("deepseek", provider).queued) {
        if (Date.now() > deadline) throw new Error("upload never queued");
        await Bun.sleep(5);
      }
      provider.apiKey = "test-queued-new";
      slot?.release();
      await expect(pending).rejects.toThrow("Credential selection changed before image upload");
      expect(seen).toEqual([]);
    } finally { slot?.release(); globalThis.fetch = restoreFetch; resetProviderRequestPacingForTest(); releaseSpend(); }
  });

  test("revoking the opt-in while an upload queues prevents the physical upload", async () => {
    const restoreFetch = globalThis.fetch;
    const releaseSpend = acquireOwnedSpendHome();
    resetProviderRequestPacingForTest();
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "test-consent",
      modelCapabilities: { "deepseek-flash": { deepseekImageFiles: true } }, requestPacing: { enabled: true, maxConcurrentRequests: 1 } };
    const config = { providers: { deepseek: provider } } as OcxConfig;
    const slot = await waitForProviderRequestSlot("deepseek", provider, "deepseek-flash");
    const seen: string[] = [];
    globalThis.fetch = (async url => {
      seen.push(String(url));
      return String(url).endsWith("/files") ? Response.json({ id: "file-api-revoked" })
        : Response.json({ id: "resp_revoked", object: "response", status: "completed", output: [] });
    }) as typeof fetch;
    const abort = AbortSignal.timeout(4_000);
    try {
      const pending = handleResponses(new Request("http://localhost/v1/responses", { method: "POST", signal: abort,
        headers: { "content-type": "application/json" }, body: request("consent").body }), config, { model: "", provider: "" });
      void pending.catch(() => {});
      const deadline = Date.now() + 2_000;
      while (!providerRequestPacingStatus("deepseek", provider).queued) {
        if (Date.now() > deadline) throw new Error("upload never queued");
        await Bun.sleep(5);
      }
      provider.modelCapabilities["deepseek-flash"].deepseekImageFiles = false;
      slot?.release();
      await expect(pending).rejects.toThrow("DeepSeek image file consent changed before image upload");
      expect(seen.filter(url => url.endsWith("/files"))).toEqual([]);
    } finally { slot?.release(); globalThis.fetch = restoreFetch; resetProviderRequestPacingForTest(); releaseSpend(); }
  });

  test("unlisted models bypass occupied image preparation slots", async () => {
    const restoreFetch = globalThis.fetch;
    const releaseSpend = acquireOwnedSpendHome();
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    let entered = 0;
    const upload = (async () => { entered++; await waiting; return Response.json({ id: "file-api-blocked-model-gate" }); }) as typeof fetch;
    const first = deepSeekImageFileBody(request("model-gate-first"), upload, undefined, optIn);
    const second = deepSeekImageFileBody(request("model-gate-second"), upload, undefined, optIn);
    let sends = 0;
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("https://api.deepseek.com/responses");
      expect(JSON.parse(String(init?.body)).model).toBe("deepseek-flash");
      sends++;
      return Response.json({ id: "resp_unlisted", object: "response", status: "completed", output: [] });
    }) as typeof fetch;
    try {
      expect(entered).toBe(2);
      const provider = { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "test-unlisted-model",
        modelCapabilities: { "deepseek-pro": { deepseekImageFiles: true } } };
      const body = JSON.stringify({ model: "deepseek-flash", input: [{ type: "message", role: "user", content: [
        { type: "input_image", image_url: `data:image/png;base64,${Buffer.alloc(31 * 1024 * 1024, 9).toString("base64")}` },
      ] }] });
      expect(Buffer.byteLength(body)).toBeGreaterThan(40 * 1024 * 1024);
      expect(Buffer.byteLength(body)).toBeLessThan(48 * 1024 * 1024);
      const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
        headers: { "content-type": "application/json" }, body }), { providers: { deepseek: provider } } as OcxConfig,
        { model: "", provider: "" });
      await response.text();
      expect(response.status).toBe(200);
      expect(sends).toBe(1);
    } finally { finish(); await Promise.all([first, second]); globalThis.fetch = restoreFetch; releaseSpend(); }
  });

  test("credential change after upload rebuilds safely inside the held inference lease", async () => {
    const restoreFetch = globalThis.fetch;
    const releaseSpend = acquireOwnedSpendHome();
    resetProviderRequestPacingForTest();
    let pacingNow = 0;
    setProviderRequestPacingRuntimeForTest({
      now: () => pacingNow,
      setTimer: (callback, delayMs) => setTimeout(() => { pacingNow += delayMs; callback(); }, 0),
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
      enqueueMicrotask: callback => queueMicrotask(callback),
    });
    const uploadTimes: number[] = [];
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "test-rebuild-old",
      modelCapabilities: { "deepseek-flash": { deepseekImageFiles: true } }, requestPacing: { enabled: true, maxConcurrentRequests: 1, minIntervalMs: 1000 } };
    const config = { providers: { deepseek: provider } } as OcxConfig;
    const seen: string[] = [];
    globalThis.fetch = (async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      seen.push(`${String(url)}:${auth}`);
      expect(providerRequestPacingStatus("deepseek", provider).inFlight).toBe(1);
      if (String(url).endsWith("/files")) {
        uploadTimes.push(pacingNow);
        provider.apiKey = "test-rebuild-new";
        return Response.json({ id: auth?.endsWith("old") ? "file-api-old" : "file-api-new" });
      }
      expect(auth).toBe("Bearer test-rebuild-new");
      expect(String(init?.body)).toContain("file-api-new");
      expect(String(init?.body)).not.toContain("file-api-old");
      return Response.json({ id: "resp_rebuilt", object: "response", status: "completed", output: [] });
    }) as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
        signal: AbortSignal.timeout(4_000), headers: { "content-type": "application/json" }, body: request("rebuild").body }),
        config, { model: "", provider: "" });
      await response.text();
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(3);
      // Initial upload, inference lease, then a distinct interval for the rebuilt upload.
      expect(uploadTimes).toEqual([0, 2000]);
    } finally { globalThis.fetch = restoreFetch; resetProviderRequestPacingForTest(); releaseSpend(); }
  });

  test("the real Responses route shrinks a >48 MiB replay and preserves reported token usage", async () => {
    const restoreFetch = globalThis.fetch;
    const releaseSpend = acquireOwnedSpendHome();
    let uploads = 0; let generations = 0;
    globalThis.fetch = (async (url, init) => {
      if (String(url) === "https://api.deepseek.com/files") {
        uploads++;
        return Response.json({ id: "file-api-endtoend" });
      }
      expect(String(url)).toBe("https://api.deepseek.com/responses");
      expect(Buffer.byteLength(String(init!.body))).toBeLessThan(48 * 1024 * 1024);
      const body = JSON.parse(String(init!.body));
      expect(body.input[0].content[1].file_id).toBe("file-api-endtoend");
      generations++;
      return Response.json({ id: "resp_files", object: "response", status: "completed", output: [],
        usage: { input_tokens: 332507, output_tokens: 10, total_tokens: 332517 } });
    }) as typeof fetch;
    try {
      const source = request("route").body;
      expect(Buffer.byteLength(source)).toBeGreaterThan(48 * 1024 * 1024);
      const config = { providers: { deepseek: { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "test-route-key", modelCapabilities: { "deepseek-flash": { deepseekImageFiles: true } } } } } as OcxConfig;
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, body: source,
      }), config, { model: "", provider: "" });
      const result = await response.json() as { usage?: { input_tokens: number } };
      expect(response.status).toBe(200);
      expect(result.usage?.input_tokens).toBe(332507);
      expect(uploads).toBe(1); expect(generations).toBe(1);
    } finally { globalThis.fetch = restoreFetch; releaseSpend(); }
  });
});

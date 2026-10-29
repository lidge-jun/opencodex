import { expect, test } from "bun:test";
import { isAntigravityModelNotFoundRefusal } from "../../src/server/responses/antigravity-validation-refusal";
import { fetchAntigravityWithRetry } from "../../src/adapters/google-http";

const model = "gemini-3.8-flash";
async function normalized(body: string | ReadableStream<Uint8Array>, status = 404): Promise<Response> {
  return fetchAntigravityWithRetry({ url: "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    method: "POST", headers: {}, body: JSON.stringify({ model }) }, {
    executor: (async () => new Response(body, { status })) as typeof fetch,
  });
}
const envelope = (message = "Requested entity was not found.", resourceName = `models/${model}`) => JSON.stringify({
  error: { code: 404, status: "NOT_FOUND", message, details: [{ "@type": "type.googleapis.com/google.rpc.ResourceInfo", resourceName }] },
});

test("CCA model 404 classification requires original model-specific evidence", async () => {
  const text = "Requested entity was not found.";
  const accepted = await normalized(envelope());
  expect(await isAntigravityModelNotFoundRefusal(accepted)).toBe(true);
  expect(await accepted.text()).toContain(text);
  for (const status of [400, 401, 403, 404, 429, 500])
    expect(await isAntigravityModelNotFoundRefusal(new Response(text, { status }))).toBe(false);
  for (const body of ["not found", "Requested entity is missing", "x".repeat(4097) + text, text + "x".repeat(4097)])
    expect(await isAntigravityModelNotFoundRefusal(await normalized(body))).toBe(false);
  expect(await isAntigravityModelNotFoundRefusal(await normalized(envelope()), AbortSignal.abort())).toBe(false);
});

test("ambiguous and mismatched original resource errors cannot authorize model denial", async () => {
  for (const body of [JSON.stringify({ error: { status: "NOT_FOUND", message: "Requested entity was not found." } }),
    envelope("Requested entity was not found.", "projects/synthetic-project"),
    envelope("Requested entity was not found.", "models/other-model"),
    envelope("Requested entity was not found.", `projects/synthetic-project/models/${model}`),
    envelope(`Model '${model}' was not found.`, "projects/synthetic-project")])
    expect(await isAntigravityModelNotFoundRefusal(await normalized(body))).toBe(false);
});

test("incidental model mentions without ResourceInfo cannot authorize model denial", async () => {
  for (const message of [
    `Project projects/p was not found while resolving models/${model}`,
    `Model 'other-model' was not found while resolving models/${model}`,
    `models/other-model not found; requested models/${model}`,
    `Model '${model}' was not found.`,
  ]) {
    const response = await normalized(JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message } }));
    expect(response.status).toBe(404);
    expect(await isAntigravityModelNotFoundRefusal(response)).toBe(false);
  }
});

test("a 5 KiB original JSON model 404 cannot become trusted after Google normalization", async () => {
  const payload = JSON.parse(envelope());
  payload.error.filler = "x".repeat(5000);
  const result = await normalized(JSON.stringify(payload));
  expect(await isAntigravityModelNotFoundRefusal(result)).toBe(false);
  expect(await result.text()).toBe("Antigravity invalid request: HTTP 404");
});

test("the original refusal ceiling counts UTF-8 bytes and admits exactly 4096", async () => {
  const payload = JSON.parse(envelope());
  payload.error.filler = "";
  payload.error.filler = "x".repeat(4096 - Buffer.byteLength(JSON.stringify(payload), "utf8"));
  expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBe(4096);
  expect(await isAntigravityModelNotFoundRefusal(await normalized(JSON.stringify(payload)))).toBe(true);
  payload.error.filler += "é";
  expect(await isAntigravityModelNotFoundRefusal(await normalized(JSON.stringify(payload)))).toBe(false);
});

test("an incomplete original model 404 stream cannot authorize rotation", async () => {
  const response = await normalized(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(envelope())); },
    cancel() {},
  }));
  expect(await isAntigravityModelNotFoundRefusal(response)).toBe(false);
  expect(await response.text()).toBe("Antigravity invalid request: HTTP 404");
});

test("an erroring original 404 body preserves status without denial provenance", async () => {
  const response = await normalized(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(envelope())); },
    pull(controller) { controller.error(new TypeError("synthetic body reset")); },
  }));
  expect(response.status).toBe(404);
  expect(await isAntigravityModelNotFoundRefusal(response)).toBe(false);
  expect(await response.text()).toBe("Antigravity invalid request: HTTP 404");
});

test("cancellation while reading an original 404 body propagates by identity", async () => {
  const controller = new AbortController();
  const reason = new Error("synthetic cancellation");
  let reading!: () => void;
  const atRead = new Promise<void>(resolve => { reading = resolve; });
  const pending = fetchAntigravityWithRetry({ url: "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    method: "POST", headers: {}, body: JSON.stringify({ model }) }, {
    abortSignal: controller.signal,
    executor: (async () => new Response(new ReadableStream<Uint8Array>({
      pull() { reading(); },
    }, { highWaterMark: 0 }), { status: 404 })) as typeof fetch,
  });
  await atRead;
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});

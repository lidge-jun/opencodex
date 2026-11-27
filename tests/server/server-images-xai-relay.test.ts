import { afterEach, expect, spyOn, test } from "bun:test";
import {
  collectXaiEditSources,
  handleImages,
  XAI_EDIT_MAX_REQUEST_BYTES,
} from "../../src/server/images";
import type { OcxConfig } from "../../src/types";
const oldFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = oldFetch; });
const config = { port: 0, defaultProvider: "xai", images: {bridgeEnabled:true}, providers: {xai:{adapter:"openai-chat",baseUrl:"https://api.x.ai/v1",apiKey:"test-key"}} } as OcxConfig;
async function relay(body: unknown) { return handleImages(new Request("http://localhost/v1/images/edits", {method:"POST", headers:{"content-type":"application/json"},body:JSON.stringify(body)}), config, "edits", {model:"",provider:""}); }
test("relay forwards all edit sources and rejects over five before fetch", async () => {
  const calls: any[] = [];
  globalThis.fetch = (async (_input, init) => { calls.push(JSON.parse(String(init?.body))); return Response.json({data:[]}); }) as typeof fetch;
  await relay({prompt:"edit",image:"https://example.com/a.png",image_url:"https://example.com/b.png",images:["https://example.com/c.png",{image_url:{url:"https://example.com/d.png"}},{url:"data:image/png;base64,aGk="}]});
  expect(calls[0].images.map((x: any) => x.url)).toEqual(["https://example.com/a.png","https://example.com/b.png","https://example.com/c.png","https://example.com/d.png","data:image/png;base64,aGk="]);
  const res = await relay({prompt:"edit",images:["https://example.com/1.png","https://example.com/2.png","https://example.com/3.png","https://example.com/4.png","https://example.com/5.png","https://example.com/6.png"]});
  expect(res.status).toBe(400); expect(await res.text()).toContain("at most 5 images"); expect(calls).toHaveLength(1);
});
test("relay collapses duplicate sources before the five-source limit, like the client", async () => {
  const calls: any[] = [];
  globalThis.fetch = (async (_input, init) => { calls.push(JSON.parse(String(init?.body))); return Response.json({data:[]}); }) as typeof fetch;
  await relay({prompt:"edit",images:Array(6).fill("https://example.com/a.png")});
  expect(calls).toHaveLength(1);
  expect(calls[0].image).toEqual({url:"https://example.com/a.png",type:"image_url"});
});

test("relay validates canonical edit data URLs without decoding their payloads", async () => {
  const sources = [
    "DATA:IMAGE/JPG;BASE64,/w==",
    "data:image/jpeg;base64,//8=",
    "data:image/webp;base64,+///",
  ];
  let forwarded: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { images: { url: string }[] };
    forwarded = body.images.map(image => image.url);
    return Response.json({ data: [{ b64_json: "iVBORw0KGgo=" }] });
  }) as typeof fetch;
  using from = spyOn(Buffer, "from");
  const res = await relay({ prompt: "edit", images: sources });
  expect(res.status).toBe(200);
  expect(forwarded).toEqual(sources);
  for (const source of sources) {
    expect(from).not.toHaveBeenCalledWith(source.split(",")[1], "base64");
  }
});

test("relay enforces per-image and aggregate inline budgets with synthetic limits", () => {
  const limits = { maxDecodedBytesPerImage: 6, maxAggregateEncodedBytes: 12 };
  const accepted = collectXaiEditSources({
    image: "https://example.com/source.png",
    image_url: "data:image/png;base64,aGk=",
    images: [{ image_url: { url: "data:image/jpeg;base64,QUFBQUFB" }, url: "data:image/png;base64,aGk=" }],
  }, limits);
  expect(accepted).toEqual({
    sources: [
      "https://example.com/source.png",
      "data:image/png;base64,aGk=",
      "data:image/jpeg;base64,QUFBQUFB",
    ],
    unusable: false,
    oversized: false,
  });

  expect(collectXaiEditSources({ image: "data:image/png;base64,QUFBQUFBQUFB" }, limits).oversized).toBe(true);
  expect(collectXaiEditSources({
    images: ["data:image/png;base64,aGk=aGk=", "data:image/jpeg;base64,aG8="],
  }, { maxDecodedBytesPerImage: 12, maxAggregateEncodedBytes: 8 }).unusable).toBe(true);
  expect(collectXaiEditSources({
    images: ["data:image/png;base64,aGk=", "data:image/jpeg;base64,aG8=", "data:image/webp;base64,Ynk="],
  }, { maxDecodedBytesPerImage: 6, maxAggregateEncodedBytes: 8 }).oversized).toBe(true);
});

test("the decoded per-image limit accepts both padding lengths and rejects one byte over", () => {
  // Like 50 MiB, five bytes need two quartets. Four and six bytes use the same encoded length.
  const limits = { maxDecodedBytesPerImage: 5, maxAggregateEncodedBytes: 8 };
  for (const [encoded, accepted] of [["QUJDRA==", true], ["QUJDREU=", true], ["QUJDREVG", false]] as const) {
    const url = "data:image/png;base64," + encoded;
    const { sources, unusable, oversized } = collectXaiEditSources({ image: url }, limits);
    expect({ sources, unusable, oversized }).toEqual({
      sources: accepted ? [url] : [], unusable: false, oversized: !accepted,
    });
  }
});

test("only edits routed to the xAI bridge use its request limit", async () => {
  const raised = { ...config, maxInboundBodyBytes: 200 * 1024 * 1024 };
  // A small invalid JSON body distinguishes admission (413) from parsing (400).
  // Use the reader's declared-length check without allocating a large image.
  const submit = (cfg: OcxConfig, endpoint: "edits" | "generations", declaredBytes: number) => {
    const req = new Request("http://localhost/v1/images/" + endpoint, {
      method: "POST", headers: { "content-length": String(declaredBytes) }, body: "{",
    });
    return handleImages(req, cfg, endpoint, { model: "", provider: "" });
  };
  const status = async (...args: Parameters<typeof submit>) => (await submit(...args)).status;
  const over = XAI_EDIT_MAX_REQUEST_BYTES + 1;
  expect(await status(raised, "edits", XAI_EDIT_MAX_REQUEST_BYTES)).toBe(400);
  for (const configuredLimit of [XAI_EDIT_MAX_REQUEST_BYTES, raised.maxInboundBodyBytes]) {
    const fixed = await submit({ ...raised, maxInboundBodyBytes: configuredLimit }, "edits", over);
    expect(fixed.status).toBe(413);
    const { error } = await fixed.json();
    expect(error.code).toBe("inbound_body_too_large");
    expect(error.message).toContain("Reduce the edit payload");
    expect(error.message).not.toContain("maxInboundBodyBytes");
  }
  expect(await status(raised, "generations", over)).toBe(400);
  expect(await status({ ...raised, images: { ...raised.images, provider: "custom" } }, "edits", over)).toBe(400);
  expect(await status({ ...raised, images: { ...raised.images, bridgeEnabled: false } }, "edits", over)).toBe(400);
  expect(await status({ ...raised, providers: {} }, "edits", over)).toBe(400);
  const lower = 1024 * 1024;
  const configured = await submit({ ...raised, maxInboundBodyBytes: lower }, "edits", lower + 1);
  expect(configured.status).toBe(413);
  expect((await configured.json()).error.message).toContain("maxInboundBodyBytes");
});

test("relay keeps five distinct sources in order and validates entries after the limit", async () => {
  const sources = Array.from({ length: 5 }, (_, i) => `https://example.com/${i}.png`);
  const calls: string[][] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { images: { url: string }[] };
    calls.push(body.images.map(image => image.url));
    return Response.json({ data: [{ b64_json: "iVBORw0KGgo=" }] });
  }) as typeof fetch;
  const accepted = await relay({ prompt: "edit", images: [sources[0], ` ${sources[0]} `, ...sources] });
  expect(accepted.status).toBe(200);
  expect(calls).toEqual([sources]);

  const rejected = await relay({ prompt: "edit", images: [...sources, "https://example.com/six.png", "not-a-url"] });
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).toContain("every image");
  expect(calls).toHaveLength(1);
});

test("relay refuses a request where any supplied edit source is unusable, before any upstream call", async () => {
  const calls: unknown[] = [];
  globalThis.fetch = (async (_input, init) => { calls.push(init?.body); return Response.json({data:[]}); }) as typeof fetch;
  for (const body of [
    {prompt:"edit",images:["https://example.com/a.png",{image_url:{}}]},
    {prompt:"edit",images:["https://example.com/a.png",{file_id:"file-1"}]},
    {prompt:"edit",image:"https://example.com/a.png",image_url:""},
    {prompt:"edit",image:"https://example.com/a.png",images:[42]},
    {prompt:"edit",image:"https://example.com/a.png",images:null},
    {prompt:"edit",image:"https://example.com/a.png",image_url:null},
    {prompt:"edit",images:["https://example.com/a.png","not-a-url"]},
    {prompt:"edit",images:["http://example.com/a.png"]},
    {prompt:"edit",images:["data:text/plain;base64,aGk="]},
    {prompt:"edit",images:[{image_url:null,url:"https://example.com/a.png"}]},
    {prompt:"edit",images:[{url:null}]},
    {prompt:"edit",images:[{image_url:{url:null}}]},
    {prompt:"edit",images:["data:image/png;base64,===="]},
    {prompt:"edit",images:["data:image/png;base64,AB=="]},
    {prompt:"edit",images:["data:image/png;base64,aGl="]},
    {prompt:"edit",images:["data:image/png;base64,aG=k"]},
    {prompt:"edit",images:["data:image/png;base64,aGk"]},
    {prompt:"edit",images:["data:image/png;base64,"]},
  ]) {
    const res = await relay(body);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("every image");
  }
  expect(calls).toHaveLength(0);
});

test("relay forwards every URL property of an images[] entry, not just one", async () => {
  const calls: any[] = [];
  globalThis.fetch = (async (_input, init) => { calls.push(JSON.parse(String(init?.body))); return Response.json({data:[]}); }) as typeof fetch;
  await relay({prompt:"edit",images:[{image_url:"https://example.com/a.png",url:"https://example.com/b.png"}]});
  expect(calls).toHaveLength(1);
  expect(calls[0].images.map((x: any) => x.url)).toEqual(["https://example.com/a.png","https://example.com/b.png"]);
});

test("relay preserves canonical upstream validation detail", async () => {
  globalThis.fetch = (async () => Response.json({error:"`image` is not supported for this model."},{status:400})) as typeof fetch;
  const res = await relay({prompt:"edit",image:"https://example.com/a.png"});
  expect(res.status).toBe(400); expect(await res.text()).toContain("`image` is not supported for this model.");
});

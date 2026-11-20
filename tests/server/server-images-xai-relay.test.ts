import { afterEach, expect, test } from "bun:test";
import { handleImages } from "../../src/server/images";
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

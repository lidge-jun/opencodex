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
  await relay({prompt:"edit",image:"a",image_url:"b",images:["c",{image_url:{url:"d"}},{url:"e"}]});
  expect(calls[0].images.map((x: any) => x.url)).toEqual(["a","b","c","d","e"]);
  const res = await relay({prompt:"edit",images:["1","2","3","4","5","6"]});
  expect(res.status).toBe(400); expect(await res.text()).toContain("at most 5 images"); expect(calls).toHaveLength(1);
});
test("relay preserves canonical upstream validation detail", async () => {
  globalThis.fetch = (async () => Response.json({error:"`image` is not supported for this model."},{status:400})) as typeof fetch;
  const res = await relay({prompt:"edit",image:"a"});
  expect(res.status).toBe(400); expect(await res.text()).toContain("`image` is not supported for this model.");
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-agy-restart-")); });
afterEach(() => removeTreeWithRetry(home));
const prefix = `
import { parseAntigravityAvailableModels, registerAntigravityDiscoveredWireModels, resolveAntigravityEffortWireModel } from './src/providers/antigravity-models';
import { captureModelCacheGeneration, clearModelCache, getStaleCached } from './src/codex/model-cache';
import { gatherRoutedModels } from './src/codex/catalog';
const provider = 'google-antigravity';
const baseUrl = 'https://snapshot.example.test/TenantA';
const base = 'claude-opus-5-5';
const ids = ['low','medium','high'].map(tier => base+'-'+tier);
const payload = {models: Object.fromEntries(ids.map(id => [id, {maxTokens:350000}])), agentModelSorts:[{groups:[{modelIds:ids}]}]};
const config = {port:0, defaultProvider:provider, providers:{[provider]:{adapter:'google',authMode:'key',apiKey:'fixture-token',baseUrl,googleMode:'cloud-code-assist',project:'fixture-project',liveModels:true,models:['safe-previous'],fetch:(...args)=>globalThis.fetch(...args)}}};
`;
function run(code: string) {
  const child = Bun.spawnSync([process.execPath, "-e", prefix + code], {
    cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
}
function discover() {
  expect(run(`globalThis.fetch=async()=>Response.json(payload); console.log(JSON.stringify((await gatherRoutedModels(config)).map(m=>m.id)));`))
    .toEqual(["claude-opus-5-5"]);
}
function snapshotFile() { return join(home, readdirSync(home).find(file => file.startsWith("antigravity-wire-"))!); }

test("discovery survives restart and failed discovery with actual adapter wire effort selection", () => {
  discover();
  const saved = readFileSync(snapshotFile(), "utf8");
  expect(saved).not.toContain("fixture-token");
  expect(saved).not.toContain("snapshot.example");
  expect(saved).not.toContain("fixture-project");
  const result = run(`
    import { createGoogleAdapter } from './src/adapters/google';
    import { createTranslatorBudget } from './src/lib/translator-budget';
    const translatorBudget=createTranslatorBudget();
    globalThis.fetch=async()=>{throw new Error('offline')};
    await gatherRoutedModels(config);
    const adapter=createGoogleAdapter(config.providers[provider]);
    const wires=[];
    for(const effort of ['low','medium','high',undefined]){
      const request={modelId:base,stream:false,context:{messages:[{role:'user',content:'hello'}],systemPrompt:[],tools:[]},options:effort?{reasoning:effort}:{}};
      const body=JSON.parse((await adapter.buildRequest(request,{headers:new Headers(),translatorBudget})).body);
      wires.push({model:body.model,thinking:body.request.generationConfig?.thinkingConfig});
    }
    clearModelCache(provider);
    wires.push(resolveAntigravityEffortWireModel(base,'low',baseUrl),resolveAntigravityEffortWireModel(base,'high',baseUrl));
    translatorBudget.dispose();
    console.log(JSON.stringify(wires));
  `);
  expect(result).toEqual([
    {model:"claude-opus-5-5-low"},{model:"claude-opus-5-5-medium"},{model:"claude-opus-5-5-high"},{model:"claude-opus-5-5-medium"},
    {wireModelId:"claude-opus-5-5"},{wireModelId:"claude-opus-5-5"},
  ]);
});

test("accepted partial and empty discoveries replace old durable families", () => {
  for (const models of ["[]", "parseAntigravityAvailableModels({...payload,agentModelSorts:[{groups:[{modelIds:[base+'-high']}]}]})"]) {
    discover();
    run(`registerAntigravityDiscoveredWireModels(baseUrl,${models},{provider,cacheGeneration:captureModelCacheGeneration(provider)});console.log('true');`);
    expect(run(`console.log(JSON.stringify(resolveAntigravityEffortWireModel(base,'high',baseUrl)));`))
      .toEqual({wireModelId:"claude-opus-5-5"});
  }
});

test("stale discovery never overwrites durable evidence and path case remains isolated", () => {
  discover();
  expect(run(`const generation=captureModelCacheGeneration(provider);clearModelCache(provider);registerAntigravityDiscoveredWireModels(baseUrl,[],{provider,cacheGeneration:generation});console.log(JSON.stringify(resolveAntigravityEffortWireModel(base,'high',baseUrl)));`))
    .toEqual({wireModelId:"claude-opus-5-5-high"});
  expect(run(`console.log(JSON.stringify(resolveAntigravityEffortWireModel(base,'high',baseUrl.toLowerCase())));`))
    .toEqual({wireModelId:"claude-opus-5-5"});
});

test("malformed and oversized snapshots fail closed", () => {
  discover();
  const path = snapshotFile();
  for (const content of ["{", JSON.stringify({version:2,provider:"google-antigravity",families:{}}),
    JSON.stringify({version:1,provider:"google-antigravity",families:{"claude-opus-5-5":{low:"different",medium:"claude-opus-5-5-medium",high:"claude-opus-5-5-high"}}}), " ".repeat(4*1024*1024+1)]) {
    writeFileSync(path,content);
    expect(run(`console.log(JSON.stringify(resolveAntigravityEffortWireModel(base,'high',baseUrl)));`))
      .toEqual({wireModelId:"claude-opus-5-5"});
  }
});

test("snapshot write failure cannot publish new synthetic catalog rows", () => {
  discover();
  const path = snapshotFile(); unlinkSync(path); mkdirSync(path);
  expect(run(`globalThis.fetch=async()=>Response.json(payload); const rows=await gatherRoutedModels(config); console.log(JSON.stringify({ids:rows.map(m=>m.id),cache:getStaleCached(provider)}));`))
    .toEqual({ids:["safe-previous"],cache:null});
});

test("generationless registrations stay memory-only and homes do not share mappings", () => {
  mkdirSync(join(home, "other"));
  expect(run(`
    const originalHome=process.env.OPENCODEX_HOME;
    registerAntigravityDiscoveredWireModels(baseUrl,parseAntigravityAvailableModels(payload));
    const original=resolveAntigravityEffortWireModel(base,'high',baseUrl);
    process.env.OPENCODEX_HOME=originalHome+'/other';
    const other=resolveAntigravityEffortWireModel(base,'high',baseUrl);
    process.env.OPENCODEX_HOME=originalHome;
    console.log(JSON.stringify([original,other,resolveAntigravityEffortWireModel(base,'low',baseUrl)]));
  `)).toEqual([{wireModelId:"claude-opus-5-5-high"},{wireModelId:"claude-opus-5-5"},{wireModelId:"claude-opus-5-5-low"}]);
  expect(readdirSync(home).filter(file=>file.startsWith("antigravity-wire-"))).toEqual([]);
});

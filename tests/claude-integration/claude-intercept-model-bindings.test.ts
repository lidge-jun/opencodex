/**
 * First-party model bindings (claudeCode.intercept.modelMap): a Claude Desktop Code tab picker id
 * mapped to an opencodex route, honoured only for requests on the claude-intercept ingress.
 * The request-path proof through a real CONNECT tunnel lives in
 * tests/server/claude-intercept-integration.test.ts.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyInterceptBindingPatch,
  claudeCodeForIngress,
  normalizeBindingTarget,
  parseInterceptBindingPatch,
  readInterceptBindings,
} from "../../src/claude/intercept/model-bindings";
import { resolveInboundModel } from "../../src/claude/inbound-model-options";
import { saveConfig, validateConfigCandidate } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxClaudeCodeConfig, OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
const previousHome = process.env.OPENCODEX_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-intercept-bindings-"));
  process.env.OPENCODEX_HOME = root;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (root) removeTreeWithRetry(root);
  root = "";
});

test("bindings apply only to the intercept ingress and win over the global map per key", () => {
  const cc: OcxClaudeCodeConfig = {
    modelMap: { "claude-sonnet-4-6": "global/target", "claude-opus-4-6": "global/opus" },
    intercept: { modelMap: { "claude-sonnet-4-6": "xai/grok-4.7" } },
  };
  expect(claudeCodeForIngress(cc, false)).toBe(cc);
  const view = claudeCodeForIngress(cc, true);
  expect(view).not.toBe(cc);
  expect(view?.modelMap).toEqual({ "claude-sonnet-4-6": "xai/grok-4.7", "claude-opus-4-6": "global/opus" });
  // The live object is untouched: the overlay is request-scoped.
  expect(cc.modelMap).toEqual({ "claude-sonnet-4-6": "global/target", "claude-opus-4-6": "global/opus" });
  expect(resolveInboundModel("claude-sonnet-4-6", view)).toBe("xai/grok-4.7");
  expect(resolveInboundModel("claude-sonnet-4-6", cc)).toBe("global/target");
});

test("a dated picker id reaches an undated binding and [1m] is ignored", () => {
  const view = claudeCodeForIngress({ intercept: { modelMap: { "claude-haiku-4-5": "zai/glm-5.3-flash" } } }, true);
  expect(resolveInboundModel("claude-haiku-4-5-20251001", view)).toBe("zai/glm-5.3-flash");
  expect(resolveInboundModel("claude-haiku-4-5[1m]", view)).toBe("zai/glm-5.3-flash");
  expect(resolveInboundModel("claude-sonnet-5", view)).toBe("claude-sonnet-5");
});

test("native/ targets resolve to the bare slug, global map values stay verbatim", () => {
  expect(normalizeBindingTarget("native/gpt-6-sol")).toBe("gpt-6-sol");
  expect(normalizeBindingTarget("native/")).toBe("native/");
  expect(normalizeBindingTarget("xai/grok-4.7")).toBe("xai/grok-4.7");
  const view = claudeCodeForIngress({
    modelMap: { "claude-opus-4-7": "native/kept-verbatim" },
    intercept: { modelMap: { "claude-opus-4-6": "native/gpt-6-sol" } },
  }, true);
  expect(resolveInboundModel("claude-opus-4-6", view)).toBe("gpt-6-sol");
  expect(resolveInboundModel("claude-opus-4-7", view)).toBe("native/kept-verbatim");
});

test("malformed stored bindings are ignored rather than routed", () => {
  const cc = { intercept: { modelMap: { "gpt-6": "xai/grok-4.7", "claude-ok": "", "claude-sonnet-4-6": "has space" } } } as unknown as OcxClaudeCodeConfig;
  expect(readInterceptBindings(cc)).toEqual({});
  expect(claudeCodeForIngress(cc, true)).toBe(cc);
});

test("patch parsing rejects bad ids, bad routes and unknown fields", () => {
  expect(parseInterceptBindingPatch({ set: { "claude-sonnet-4-6": "xai/grok-4.7" } })).toEqual({ set: { "claude-sonnet-4-6": "xai/grok-4.7" } });
  expect(parseInterceptBindingPatch({ remove: ["claude-sonnet-4-6"] })).toEqual({ remove: ["claude-sonnet-4-6"] });
  expect("error" in parseInterceptBindingPatch({})).toBe(true);
  expect("error" in parseInterceptBindingPatch({ set: { "gpt-6": "xai/grok-4.7" } })).toBe(true);
  expect("error" in parseInterceptBindingPatch({ set: { "claude-sonnet-4-6": "has space" } })).toBe(true);
  expect("error" in parseInterceptBindingPatch({ set: {}, extra: true })).toBe(true);
  expect("error" in parseInterceptBindingPatch({ remove: [1] })).toBe(true);
});

test("applying a patch checks routes against the available vocabulary", () => {
  const routes = new Set(["xai/grok-4.7", "native/gpt-6-sol"]);
  const bound = applyInterceptBindingPatch({}, { set: { "claude-sonnet-4-6": "native/gpt-6-sol" } }, routes);
  expect(bound).toEqual({ ok: true, bindings: { "claude-sonnet-4-6": "native/gpt-6-sol" }, changed: true });
  expect(applyInterceptBindingPatch({}, { set: { "claude-sonnet-4-6": "nope/missing" } }, routes).ok).toBe(false);
  expect(applyInterceptBindingPatch({ "claude-opus-4-6": "xai/grok-4.7" }, { remove: ["claude-unbound"] }, routes))
    .toEqual({ ok: true, bindings: { "claude-opus-4-6": "xai/grok-4.7" }, changed: false });
});

test("config validation rejects a malformed intercept.modelMap", () => {
  const base = { port: 10100, providers: { openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" } }, defaultProvider: "openai" };
  expect(validateConfigCandidate({ ...base, claudeCode: { intercept: { modelMap: { "claude-sonnet-4-6": "xai/grok-4.7" } } } }).ok).toBe(true);
  for (const modelMap of [["x"], { "gpt-6": "xai/grok-4.7" }, { "claude-sonnet-4-6": 7 }, { "claude-sonnet-4-6": "has space" }]) {
    expect(validateConfigCandidate({ ...base, claudeCode: { intercept: { modelMap } } }).ok).toBe(false);
  }
});

function bindingConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "fake",
    providers: {
      fake: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, apiKey: "sk-fake", models: ["fake-model"], liveModels: false },
    },
  } as unknown as OcxConfig;
}

async function putBindings(config: OcxConfig, body: unknown): Promise<Response> {
  const url = new URL("http://127.0.0.1:10100/api/claude-desktop/first-party-bindings");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT",
    headers: { Host: url.host, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), url, config);
  if (!response) throw new Error("route not handled");
  return response;
}

test("PUT first-party-bindings persists, adopts into the live config and reports in status", async () => {
  const live = bindingConfig();
  saveConfig(live);
  const saved = await putBindings(live, { set: { "claude-sonnet-4-6": "fake/fake-model" } });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ ok: true, modelBindings: { "claude-sonnet-4-6": "fake/fake-model" } });
  expect(live.claudeCode?.intercept?.modelMap).toEqual({ "claude-sonnet-4-6": "fake/fake-model" });
  const onDisk = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(onDisk.claudeCode?.intercept?.modelMap).toEqual({ "claude-sonnet-4-6": "fake/fake-model" });
  expect(onDisk.claudeCode?.modelMap).toBeUndefined();

  const statusUrl = new URL("http://127.0.0.1:10100/api/claude-desktop/status");
  const status = await handleManagementAPI(new Request(statusUrl, { headers: { Host: statusUrl.host } }), statusUrl, live);
  const body = await status!.json() as { firstParty: { modelBindings: Record<string, string>; pickerSuggestions: string[] } };
  expect(body.firstParty.modelBindings).toEqual({ "claude-sonnet-4-6": "fake/fake-model" });
  expect(body.firstParty.pickerSuggestions).toContain("claude-sonnet-4-6");

  const removed = await putBindings(live, { remove: ["claude-sonnet-4-6"] });
  expect(await removed.json()).toEqual({ ok: true, modelBindings: {} });
  const cleared = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(cleared.claudeCode?.intercept).toBeUndefined();
});

test("PUT first-party-bindings refuses an unavailable route and leaves config unchanged", async () => {
  const live = bindingConfig();
  saveConfig(live);
  const before = readFileSync(join(root, "config.json"), "utf8");
  const refused = await putBindings(live, { set: { "claude-sonnet-4-6": "nope/missing" } });
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: string }).error).toContain("not available");
  const badId = await putBindings(live, { set: { "gpt-6": "fake/fake-model" } });
  expect(badId.status).toBe(400);
  expect(readFileSync(join(root, "config.json"), "utf8")).toBe(before);
  expect(live.claudeCode?.intercept).toBeUndefined();
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { loadConfig, saveConfig } from "../../src/config";
import { ManagementRequest, managementHeaders } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { parseExcludedProviders } from "../../src/server/management/combo-suggestion-routes";
import type { OcxConfig } from "../../src/types";

const previousHome = process.env.OPENCODEX_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-combo-suggestion-routes-"));
  process.env.OPENCODEX_HOME = home;
  saveConfig({
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["m"] } },
  } as OcxConfig);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

async function call(config: OcxConfig, method: "GET" | "PUT", body?: unknown) {
  const url = new URL("http://localhost/api/combo-suggestions");
  const init: RequestInit = { method, headers: { ...managementHeaders(), "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await handleManagementAPI(new ManagementRequest(url, init), url, config);
  return { status: response!.status, body: await response!.json() as Record<string, unknown> };
}

const onDisk = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;

test("excluded providers round-trip through config.json, and an empty list removes the key", async () => {
  const live = loadConfig();
  expect(await call(live, "GET")).toEqual({ status: 200, body: { excludedProviders: [] } });

  expect(await call(live, "PUT", { excludedProviders: [" cursor ", "cursor", "trae"] }))
    .toEqual({ status: 200, body: { excludedProviders: ["cursor", "trae"] } });
  expect(onDisk().comboSuggestionExcludedProviders).toEqual(["cursor", "trae"]);
  expect(loadConfig().comboSuggestionExcludedProviders).toEqual(["cursor", "trae"]);
  expect(await call(loadConfig(), "GET")).toEqual({ status: 200, body: { excludedProviders: ["cursor", "trae"] } });

  expect(await call(live, "PUT", { excludedProviders: [] })).toEqual({ status: 200, body: { excludedProviders: [] } });
  expect("comboSuggestionExcludedProviders" in onDisk()).toBe(false);
  expect(live.comboSuggestionExcludedProviders).toBeUndefined();
});

test("a malformed write is refused and changes nothing", async () => {
  const live = loadConfig();
  for (const body of [{ excludedProviders: "cursor" }, { excludedProviders: [1] }, { excludedProviders: [""] }, { other: [] }]) {
    expect((await call(live, "PUT", body)).status).toBe(400);
  }
  expect("comboSuggestionExcludedProviders" in onDisk()).toBe(false);
});

test("parseExcludedProviders trims, dedupes and keeps order", () => {
  expect(parseExcludedProviders(["b", " a", "b "])).toEqual(["b", "a"]);
  expect(parseExcludedProviders(null)).toBeNull();
});

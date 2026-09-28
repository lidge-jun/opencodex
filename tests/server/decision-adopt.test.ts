import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { resolveJevDecisionDestination } from "../../src/combos/jev";
import type { OcxConfig } from "../../src/types";

const TEST_DIR = join(tmpdir(), "ocx-decision-adopt");
const previousHome = process.env.OPENCODEX_HOME;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
});

const baseConfig = (providers: Record<string, unknown>): OcxConfig => ({
  port: 10100,
  defaultProvider: "openai",
  providers: {
    openai: {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    },
    ...providers,
  },
} as unknown as OcxConfig);

/** A gateway row that merely resells the decision model under its own id. */
const zenRow = {
  adapter: "openai-chat",
  baseUrl: "https://opencode.ai/zen/v1",
  authMode: "key",
  apiKey: "env:ZEN_KEY",
};

const adopt = async (config: OcxConfig, query: string) => {
  // The management surface resolves its own origin from the Host header and refuses a request
  // without one, so the harness has to present a loopback host.
  const req = new Request(`http://127.0.0.1/api/decision-adopt?${query}`, {
    method: "POST",
    headers: { host: "127.0.0.1", origin: "http://127.0.0.1" },
  });
  const res = await handleManagementAPI(req, new URL(req.url), config, {});
  if (!res) throw new Error("handler returned no response");
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe("POST /api/decision-adopt", () => {
  test("writes a destination row that pins the discovered model", async () => {
    const config = baseConfig({ "opencode-zen": zenRow });
    const { status, body } = await adopt(config, "provider=opencode-zen&model=jev-1.13");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      name: "jev-opencode-zen",
      baseUrl: "https://opencode.ai/zen/v1/systemone",
      model: "jev-1.13",
    });

    const row = config.providers["jev-opencode-zen"];
    expect(row).toMatchObject({
      adapter: "jev-decision",
      baseUrl: "https://opencode.ai/zen/v1/systemone",
      authMode: "key",
      defaultModel: "jev-1.13",
    });
    // The credential reference is copied verbatim, so an environment-key setup keeps its file.
    expect(row?.apiKey).toBe("env:ZEN_KEY");

    // The adopted row is immediately the destination the strategy resolves, with its own model.
    expect(resolveJevDecisionDestination(config)).toEqual({
      providerId: "jev-opencode-zen",
      baseUrl: "https://opencode.ai/zen/v1/systemone",
      model: "jev-1.13",
      apiKey: "env:ZEN_KEY",
    });
  });

  test("honours an explicit destination name", async () => {
    const config = baseConfig({ "opencode-zen": zenRow });
    const { body } = await adopt(config, "provider=opencode-zen&model=jev-1.13&name=zen-decisions");
    expect(body.name).toBe("zen-decisions");
    expect(config.providers["zen-decisions"]?.adapter).toBe("jev-decision");
  });

  test("refuses a source row without a credential", async () => {
    const config = baseConfig({ "opencode-zen": { ...zenRow, apiKey: undefined } });
    const { status, body } = await adopt(config, "provider=opencode-zen&model=jev-1.13");
    expect(status).toBe(409);
    expect(String(body.error)).toContain("credential");
    expect(config.providers["jev-opencode-zen"]).toBeUndefined();
  });

  test("never overwrites an occupied name, and falls back to a model-qualified one", async () => {
    const config = baseConfig({
      "opencode-zen": zenRow,
      "jev-opencode-zen": {
        adapter: "jev-decision",
        baseUrl: "https://somewhere.else/v1/systemone",
        authMode: "key",
        apiKey: "sk-other",
      },
    });
    const { status } = await adopt(config, "provider=opencode-zen&model=jev-1.13");
    expect(status).toBe(200);
    // The row that was already there is untouched...
    expect(config.providers["jev-opencode-zen"]?.baseUrl).toBe("https://somewhere.else/v1/systemone");
    expect(config.providers["jev-opencode-zen"]?.apiKey).toBe("sk-other");
    // ...and the new destination lands on a free, model-qualified name.
    expect(config.providers["jev-opencode-zen-jev-1-13"]?.baseUrl).toBe("https://opencode.ai/zen/v1/systemone");
  });

  test("an explicit name that is taken is refused rather than renamed", async () => {
    const config = baseConfig({
      "opencode-zen": zenRow,
      "zen-decisions": {
        adapter: "jev-decision",
        baseUrl: "https://somewhere.else/v1/systemone",
        authMode: "key",
        apiKey: "sk-other",
      },
    });
    const { status, body } = await adopt(config, "provider=opencode-zen&model=jev-1.13&name=zen-decisions");
    expect(status).toBe(409);
    expect(String(body.error)).toContain("already exists");
    expect(config.providers["zen-decisions"]?.baseUrl).toBe("https://somewhere.else/v1/systemone");
  });

  test("is idempotent for the same destination", async () => {
    const config = baseConfig({ "opencode-zen": zenRow });
    await adopt(config, "provider=opencode-zen&model=jev-1.13");
    const { status, body } = await adopt(config, "provider=opencode-zen&model=jev-1.13");
    expect(status).toBe(200);
    expect(body.alreadyConfigured).toBe(true);
  });

  test("pins a second model from the same gateway to a model-qualified row", async () => {
    const config = baseConfig({ "opencode-zen": zenRow });
    await adopt(config, "provider=opencode-zen&model=jev-1.13");
    const { status, body } = await adopt(config, "provider=opencode-zen&model=jev-1.13-free");
    expect(status).toBe(200);
    expect(body.name).toBe("jev-opencode-zen-jev-1-13-free");
    expect(config.providers["jev-opencode-zen-jev-1-13-free"]?.defaultModel).toBe("jev-1.13-free");
    // The first row keeps its own model; adopting a sibling must not retarget it.
    expect(config.providers["jev-opencode-zen"]?.defaultModel).toBe("jev-1.13");
  });

  test("rejects a request that names no model", async () => {
    const config = baseConfig({ "opencode-zen": zenRow });
    const { status } = await adopt(config, "provider=opencode-zen");
    expect(status).toBe(400);
  });

  test("rejects an unconfigured provider", async () => {
    const config = baseConfig({ "opencode-zen": zenRow });
    const { status } = await adopt(config, "provider=nope&model=jev-1.13");
    expect(status).toBe(404);
  });
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  validateConfigCandidate,
} from "../src/config";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-display-names-config-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function candidate(modelDisplayNames: unknown) {
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
        note: "keep me",
        modelDisplayNames,
      },
    },
  };
}

function writeCandidate(modelDisplayNames: unknown, provider = "xai"): void {
  const config = candidate(modelDisplayNames);
  config.defaultProvider = provider;
  config.providers = {
    [provider]: {
      ...config.providers.xai,
      modelDisplayNames,
    },
  };
  writeFileSync(getConfigPath(), JSON.stringify(config), "utf8");
}

test("config validation accepts only safe provider model display names", () => {
  const valid = validateConfigCandidate(candidate({
    "grok-4.6": "Grok 4.6",
    "models/grok-vision": "Grok Vision",
  }));
  expect(valid.ok).toBe(true);

  const invalid = validateConfigCandidate(candidate({ "grok-4.6": "Grok/4.6" }));
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error).toContain("modelDisplayNames");
});

test("load keeps a provider and valid labels when one hand edited label is invalid", () => {
  writeCandidate({
    "grok-4.6": "  Grok 4.6  ",
    "future-model": "Future Model",
    unsafe: "Bad/Name",
  });

  const loaded = loadConfig();

  expect(loaded.providers.xai).toMatchObject({
    note: "keep me",
    modelDisplayNames: {
      "grok-4.6": "Grok 4.6",
      "future-model": "Future Model",
    },
  });
  expect(loaded.providers.xai.modelDisplayNames).not.toHaveProperty("unsafe");
});

test("load drops only a malformed display name map", () => {
  writeCandidate("not-an-object");

  const loaded = loadConfig();

  expect(loaded.providers.xai).toMatchObject({ note: "keep me" });
  expect(loaded.providers.xai.modelDisplayNames).toBeUndefined();
});

test("load warnings never reveal display values or secret shaped provider names", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    writeCandidate({ model: "sk-secret-display-value/unsafe" }, "sk-secret-provider-name");

    const loaded = loadConfig();

    expect(loaded.providers["sk-secret-provider-name"]).toBeDefined();
    const output = warn.mock.calls.map(call => call.join(" ")).join("\n");
    expect(output).not.toContain("sk-secret-display-value");
    expect(output).not.toContain("sk-secret-provider-name");
    expect(output).toContain("[REDACTED]");
  } finally {
    warn.mockRestore();
  }
});

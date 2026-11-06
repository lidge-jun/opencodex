import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig, saveConfig, validateConfigCandidate } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import {
  DEFAULT_CONCURRENT_INBOUND_BODY_BYTES,
  MAX_CONCURRENT_INBOUND_BODY_BYTES,
  resolveConcurrentInboundBodyLimitBytes,
} from "../../src/lib/inbound-body-policy";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";

const MiB = 1024 * 1024;
const invalid = [-1, 1.5, "unbounded", "1073741824", true, null, {}, [], Number.MAX_SAFE_INTEGER + 1];

/** Keep a distinct provider so fallback to defaults cannot satisfy retention checks. */
function configWithLimit(value?: unknown) {
  return {
    ...getDefaultConfig(),
    defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-responses", baseUrl: "https://provider.invalid/v1" } },
    maxInboundBodyBytes: 512 * MiB,
    maxConcurrentInboundBodyBytes: value,
  };
}

test("omission keeps the existing 512 MiB budget without injecting a config key", () => {
  expect(DEFAULT_CONCURRENT_INBOUND_BODY_BYTES).toBe(512 * MiB);
  expect(MAX_CONCURRENT_INBOUND_BODY_BYTES).toBe(2 * 1024 * MiB);
  expect(getDefaultConfig().maxConcurrentInboundBodyBytes).toBeUndefined();
  const parsed = configSchema.parse(configWithLimit());
  expect(parsed.maxConcurrentInboundBodyBytes).toBeUndefined();
  expect(resolveConcurrentInboundBodyLimitBytes(parsed.maxConcurrentInboundBodyBytes)).toBe(512 * MiB);
});

test("schema and candidates retain integers while the config resolver enforces both bounds", () => {
  for (const [value, resolved] of [
    [0, 512 * MiB], [1, 512 * MiB], [512 * MiB - 1, 512 * MiB],
    [512 * MiB, 512 * MiB], [768 * MiB, 768 * MiB],
    [2 * 1024 * MiB, 2 * 1024 * MiB], [2 * 1024 * MiB + 1, 2 * 1024 * MiB],
    [Number.MAX_SAFE_INTEGER, 2 * 1024 * MiB],
  ]) {
    expect(configSchema.parse(configWithLimit(value)).maxConcurrentInboundBodyBytes).toBe(value);
    const candidate = validateConfigCandidate(configWithLimit(value));
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) throw new Error(candidate.error);
    expect(candidate.config.maxConcurrentInboundBodyBytes).toBe(value);
    expect(resolveConcurrentInboundBodyLimitBytes(candidate.config.maxConcurrentInboundBodyBytes)).toBe(resolved);
  }
});

test("malformed schema and candidate values degrade like maxInboundBodyBytes", () => {
  for (const value of [...invalid, NaN, Infinity, -Infinity]) {
    const raw = { ...configWithLimit(value), maxInboundBodyBytes: value };
    const parsed = configSchema.parse(raw);
    expect(parsed.maxConcurrentInboundBodyBytes).toBeUndefined();
    expect(parsed.maxInboundBodyBytes).toBeUndefined();
    expect(parsed.providers).toEqual(raw.providers);
    const candidate = validateConfigCandidate(raw);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) throw new Error(candidate.error);
    expect(candidate.config.maxConcurrentInboundBodyBytes).toBeUndefined();
    expect(candidate.config.providers).toEqual(raw.providers);
  }
});

test("the resolver keeps invalid direct callers finite even without schema validation", () => {
  for (const value of [undefined, 0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(resolveConcurrentInboundBodyLimitBytes(value)).toBe(512 * MiB);
  }
});

describe("concurrent inbound body config persistence", () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-concurrent-inbound-config-"));
    process.env.OPENCODEX_HOME = home;
  });
  afterEach(async () => {
    try {
      await removeTreeAfterBackgroundWork(home);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
    }
  });

  test("save/load preserves zero, an explicit budget and an over-ceiling request", () => {
    for (const value of [0, 768 * MiB, MAX_CONCURRENT_INBOUND_BODY_BYTES + 1]) {
      const candidate = validateConfigCandidate(configWithLimit(value));
      expect(candidate.ok).toBe(true);
      if (!candidate.ok) throw new Error(candidate.error);
      saveConfig(candidate.config);
      expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).maxConcurrentInboundBodyBytes).toBe(value);
      const loaded = loadConfig();
      expect(loaded.maxConcurrentInboundBodyBytes).toBe(value);
      expect(loaded.providers).toEqual(candidate.config.providers);
      expect(loaded.maxInboundBodyBytes).toBe(512 * MiB);
      expect(resolveConcurrentInboundBodyLimitBytes(loaded.maxConcurrentInboundBodyBytes)).toBe(
        value === 0 ? 512 * MiB : Math.min(value, MAX_CONCURRENT_INBOUND_BODY_BYTES),
      );
    }
  }, 20_000);

  test("invalid hand edits keep providers and the original file instead of resetting config", () => {
    for (const value of invalid) {
      const raw = configWithLimit(value);
      const bytes = JSON.stringify(raw);
      writeFileSync(getConfigPath(), bytes, "utf8");
      const loaded = loadConfig();
      expect(loaded.maxConcurrentInboundBodyBytes).toBeUndefined();
      expect(resolveConcurrentInboundBodyLimitBytes(loaded.maxConcurrentInboundBodyBytes)).toBe(512 * MiB);
      expect(loaded.defaultProvider).toBe("fixture");
      expect(loaded.providers).toEqual(raw.providers);
      expect(loaded.maxInboundBodyBytes).toBe(512 * MiB);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    }
  }, 20_000);
});

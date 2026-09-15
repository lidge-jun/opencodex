import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  saveConfig,
  validateConfigCandidate,
} from "../../src/config";

let testHome = "";
const previousOpenCodexHome = process.env.OPENCODEX_HOME;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-usage-ledger-config-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  rmSync(testHome, { recursive: true, force: true });
});

test("usageLedgerRetention is accepted as a first-class config section", () => {
  const candidate = {
    ...getDefaultConfig(),
    usageLedgerRetention: { enabled: true, maxBytes: 8 * 1024 * 1024 },
  };

  const result = validateConfigCandidate(candidate);

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.config.usageLedgerRetention).toEqual(candidate.usageLedgerRetention);
  }
});

test("a malformed usageLedgerRetention section degrades without dropping providers", () => {
  saveConfig({
    ...getDefaultConfig(),
    usageLedgerRetention: { enabled: true, maxBytes: 8 * 1024 * 1024 },
  });
  const raw = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
  raw.usageLedgerRetention = { enabled: true, maxByets: 8 * 1024 * 1024 };
  writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2), "utf8");

  const loaded = loadConfig();

  expect(loaded.usageLedgerRetention).toBeUndefined();
  expect(loaded.providers.openai).toBeDefined();
});

test("partial usageLedgerRetention config remains valid for hand-edited files", () => {
  saveConfig({
    ...getDefaultConfig(),
    usageLedgerRetention: { enabled: true, maxBytes: 8 * 1024 * 1024 },
  });
  const raw = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
  raw.usageLedgerRetention = { enabled: true };
  writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2), "utf8");

  expect(loadConfig().usageLedgerRetention).toEqual({ enabled: true });
});

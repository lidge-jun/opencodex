/**
 * The operator surface for durable spend ceilings (#4546).
 *
 * The section is validated the way every optional feature section here is, and for one reason
 * sharper than tidiness: a silently ignored key leaves the BUDGET off, and a budget nobody is
 * enforcing looks exactly like a budget nobody has exceeded. That is #2106 pointed at money.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  validateConfigCandidate,
} from "../../src/config";
import { configDiagnosticsFromRaw } from "../../src/config/diagnostics";
import { spendCeilingsConfigured, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-spend-config-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function candidate(spend: unknown) {
  return {
    ...getDefaultConfig(),
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
        note: "keep me",
      },
    },
    spend,
  };
}

test("a well-formed section is accepted at every level of completeness", () => {
  expect(validateConfigCandidate(candidate(undefined)).ok).toBe(true);
  expect(validateConfigCandidate(candidate({})).ok).toBe(true);
  expect(validateConfigCandidate(candidate({ root: {} })).ok).toBe(true);
  expect(validateConfigCandidate(candidate({ root: { maxTokens: 20_000_000 } })).ok).toBe(true);
  expect(validateConfigCandidate(candidate({
    root: { maxTokens: 20_000_000 },
    identity: { maxTokens: 100_000_000 },
    pool: { maxTokens: 250_000_000 },
    retentionDays: 14,
  })).ok).toBe(true);
});

test("validateConfigCandidate rejects a ceiling that would not mean what it says", () => {
  // 0 is not "no ceiling": it would refuse every request under the scope. An operator who
  // wants no ceiling removes the key, which is why absence and 0 must not be the same write.
  for (const maxTokens of [0, -1, 1.5, "1000", null]) {
    const result = validateConfigCandidate(candidate({ root: { maxTokens } }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("schema_invalid: spend.root.maxTokens");
  }
  for (const retentionDays of [0, -3, 400]) {
    const result = validateConfigCandidate(candidate({ retentionDays }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("schema_invalid: spend.retentionDays");
  }
});

test("validateConfigCandidate rejects a typo instead of enforcing nothing", () => {
  // The #2106 shape: an undeclared key accepted, persisted, and then read as its default. Here
  // the default is "no ceiling", so the operator would believe a budget existed and it would
  // refuse nothing at all.
  expect(validateConfigCandidate(candidate({ root: { maxTokes: 20_000_000 } })).ok).toBe(false);
  expect(validateConfigCandidate(candidate({ account: { maxTokens: 20_000_000 } })).ok).toBe(false);
  expect(validateConfigCandidate(candidate({ root: { maxTokens: 10 }, retentionDaysX: 7 })).ok).toBe(false);
  expect(validateConfigCandidate(candidate("20000000")).ok).toBe(false);
});

test("a malformed section degrades to no ceiling, keeps the rest, and says so", () => {
  // The degrade direction is deliberate: discarding the whole file over a bad optional section
  // would cost the operator their providers. It is also the dangerous direction, because what
  // is dropped is enforcement -- so the diagnostics have to carry it.
  const raw = JSON.stringify(candidate({ root: { maxTokens: 0 } }));
  writeFileSync(getConfigPath(), raw, "utf8");

  const loaded = loadConfig();
  expect(loaded.spend).toBeUndefined();
  expect(loaded.providers.xai.note).toBe("keep me");

  const diagnostics = configDiagnosticsFromRaw(raw);
  expect((diagnostics.warnings ?? []).join("\n")).toContain("spend.root.maxTokens ignored");
  expect((diagnostics.warnings ?? []).join("\n")).toContain("no token ceiling is enforced");
});

test("a well-formed section survives the load intact", () => {
  writeFileSync(getConfigPath(), JSON.stringify(candidate({
    root: { maxTokens: 20_000_000 },
    retentionDays: 3,
  })), "utf8");
  const loaded = loadConfig();
  expect(loaded.spend).toEqual({ root: { maxTokens: 20_000_000 }, retentionDays: 3 });

  const resolved = spendPolicyFromConfig(loaded.spend);
  expect(resolved.root.maxTokens).toBe(20_000_000);
  expect(resolved.identity.maxTokens).toBeUndefined();
  expect(resolved.retentionMs).toBe(3 * 24 * 60 * 60_000);
  expect(spendCeilingsConfigured(resolved)).toBe(true);
});

test("a ceiling on any one scope is enough to turn enforcement on", () => {
  expect(spendCeilingsConfigured(spendPolicyFromConfig({ identity: { maxTokens: 1 } }))).toBe(true);
  expect(spendCeilingsConfigured(spendPolicyFromConfig({ pool: { maxTokens: 1 } }))).toBe(true);
  expect(spendCeilingsConfigured(spendPolicyFromConfig({ retentionDays: 30 }))).toBe(false);
});

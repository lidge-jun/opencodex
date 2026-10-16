import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, getConfigPath, loadConfig, validateConfigCandidate } from "../../src/config";
import { configDiagnosticsFromRaw } from "../../src/config/diagnostics";
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY, type SpendReservationPolicy } from "../../src/lib/spend-reservation-ledger";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const salt = "7".repeat(64);
const alias = (id: string, usedSalt = salt) => createHash("sha256").update(usedSalt).update("\0pool\0").update(id).digest("hex").slice(0, 32);
let home = "";
let priorHome: string | undefined;
beforeEach(() => {
  priorHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-pool-collision-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
  removeTreeWithRetry(home);
});
const provider = { adapter: "openai-responses", baseUrl: "https://pool.example.test/v1" };
const candidate = (aliases: Record<string, string>, providers = { P: provider, Q: provider }) => ({
  ...getDefaultConfig(), defaultProvider: "Q", providers,
  spend: { root: { maxTokens: 200 }, identity: { maxTokens: 150 }, pool: { maxTokens: 100 } },
  spendPoolAliases: aliases,
});
const policy = (aliases: Record<string, string>, ids: string[]): SpendReservationPolicy & { canonicalProviderIds: string[] } => ({
  ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: 100 }, poolAliases: aliases, canonicalProviderIds: ids,
});
const reserve = (ledger: ReturnType<typeof createSpendReservationLedger>, id = "send", poolId = "P") =>
  ledger.reserve({ sendId: id, scopes: { poolId }, inputTokens: 1, outputCeilingTokens: 0 });
const installSalt = () => writeFileSync(join(home, "spend-ledger.salt"), salt + "\n", { mode: 0o600 });

test("salted canonical collision rejects write load and reconfigure", () => {
  installSalt();
  const invalid = candidate({ [alias("P")]: "Q" });
  expect(validateConfigCandidate(invalid).ok).toBe(false);
  const diagnostics = configDiagnosticsFromRaw(JSON.stringify(invalid));
  expect(diagnostics.config.spend).toEqual(invalid.spend);
  expect(diagnostics.config.spendPoolAliases).toEqual(invalid.spendPoolAliases);
  expect(diagnostics.warnings?.join("\n")).toContain("spendPoolAliases invalid");
  writeFileSync(getConfigPath(), JSON.stringify(invalid));
  expect(loadConfig().spend).toEqual(invalid.spend);
  const loaded = createSpendReservationLedger({ salt, policy: policy(invalid.spendPoolAliases, ["P", "Q"]) });
  expect(reserve(loaded)).toMatchObject({ reserved: false, denial: { reason: "pool-history-unresolved" } });
  const ledger = createSpendReservationLedger({ salt, policy: policy({}, ["P", "Q"]) });
  expect(reserve(ledger, "before").reserved).toBe(true);
  ledger.reconfigure(policy(invalid.spendPoolAliases, ["P", "Q"]));
  expect(reserve(ledger, "after")).toMatchObject({ reserved: false, denial: { reason: "pool-history-unresolved" } });
  // A policy error cannot prevent settlement of an existing physical liability.
  expect(ledger.settle("before", { inputTokens: 1, outputTokens: 0 })).toBe(true);
});

test("adding canonical provider rejects an existing foreign mapping", () => {
  installSalt();
  const aliases = { [alias("P")]: "Q" };
  expect(validateConfigCandidate(candidate(aliases, { Q: provider })).ok).toBe(true);
  expect(validateConfigCandidate(candidate(aliases)).ok).toBe(false);
  const ledger = createSpendReservationLedger({ salt, policy: policy(aliases, ["Q"]) });
  expect(reserve(ledger, "Q-before", "Q").reserved).toBe(true);
  // The actual routed provider is also checked against a stale startup roster.
  expect(reserve(ledger, "P-stale", "P")).toMatchObject({ reserved: false, denial: { reason: "pool-history-unresolved" } });
  ledger.reconfigure(policy(aliases, ["P", "Q"]));
  expect(ledger.checkPoolContinuity()?.reason).toBe("pool-history-unresolved");
  expect(reserve(ledger, "Q-after", "Q").reserved).toBe(false);
});

test("same-home self mapping succeeds and validation creates no salt", () => {
  const saltPath = join(home, "spend-ledger.salt");
  expect(validateConfigCandidate(candidate({})).ok).toBe(true);
  expect(validateConfigCandidate(candidate({ [alias("P")]: "P" })).ok).toBe(false);
  const loaded = configDiagnosticsFromRaw(JSON.stringify(candidate({ [alias("P")]: "P" })));
  expect(loaded.config.spend?.pool?.maxTokens).toBe(100);
  expect(loaded.warnings?.join("\n")).toContain("spendPoolAliases invalid");
  expect(existsSync(saltPath)).toBe(false);
  expect(existsSync(join(home, "spend-ledger.jsonl"))).toBe(false);
  installSalt();
  expect(validateConfigCandidate(candidate({ [alias("P")]: "P" })).ok).toBe(true);
  expect(configDiagnosticsFromRaw(JSON.stringify(candidate({ [alias("P")]: "P" }))).warnings?.join("\n") ?? "").not.toContain("spendPoolAliases invalid");
  const ledger = createSpendReservationLedger({ salt, policy: policy({ [alias("P")]: "P" }, ["P", "Q"]) });
  expect(reserve(ledger).reserved).toBe(true);
  // This is a same-home rule: an alias from another salt has no claimed current owner.
  expect(validateConfigCandidate(candidate({ [alias("P", "8".repeat(64))]: "Q" })).ok).toBe(true);
});

test("unreadable malformed and linked existing salts cannot validate a mapping", () => {
  const raw = candidate({ [alias("P")]: "P" });
  writeFileSync(join(home, "spend-ledger.salt"), "invalid\n");
  expect(validateConfigCandidate(raw).ok).toBe(false);
  const other = mkdtempSync(join(tmpdir(), "ocx-linked-pool-salt-"));
  try {
    writeFileSync(join(other, "salt"), salt + "\n");
    for (const link of [linkSync, symlinkSync]) {
      const linkedHome = join(other, link === linkSync ? "hard" : "symbolic");
      // A disposable home keeps the ordinary real salt above untouched.
      mkdirSync(linkedHome);
      link(join(other, "salt"), join(linkedHome, "spend-ledger.salt"));
      process.env.OPENCODEX_HOME = linkedHome;
      expect(validateConfigCandidate(raw).ok).toBe(false);
    }
  } finally { process.env.OPENCODEX_HOME = home; removeTreeWithRetry(other); }
});

for (const target of [" P", "P ", "missing-provider"]) {
  test(`invalid alias target ${JSON.stringify(target)} rejects writes and warns on load without hiding spend`, () => {
    installSalt();
    const raw = candidate({ [alias("historical-account")]: target });
    expect(validateConfigCandidate(raw).ok).toBe(false);
    const loaded = configDiagnosticsFromRaw(JSON.stringify(raw));
    expect(loaded.config.spend).toEqual(raw.spend);
    expect(loaded.warnings?.join("\n")).toContain("spendPoolAliases invalid");
    const ledger = createSpendReservationLedger({ salt, policy: policy(raw.spendPoolAliases, ["P", "Q"]) });
    expect(reserve(ledger)).toMatchObject({ reserved: false, denial: { reason: "pool-history-unresolved" } });
  });
}

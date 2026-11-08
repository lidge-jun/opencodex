import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armClaudeCodeBaseline, getConfigPath, loadConfig, mutatePersistedConfig, saveConfig, saveConfigPreservingClaudeCode, validateConfigCandidate } from "../../src/config";
import type { OcxConfig, OcxTelemetryConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Telemetry consent is written to disk by the CLI (`ocx telemetry enable|disable`, the start
 * prompt) and by the consent route, often while a proxy runs with an older in-memory config.
 * A later settings save from that proxy must carry the decision on disk, never drop or roll it back.
 */
const seed = (telemetry?: OcxTelemetryConfig): OcxConfig => ({
  port: 10100,
  logLevel: "info",
  providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example.test" } },
  defaultProvider: "fixture",
  ...(telemetry ? { telemetry } : {}),
} as OcxConfig);

const declined: OcxTelemetryConfig = { decision: "declined", decidedAt: "2026-11-08T10:00:00.000Z", noticeShownAt: "2026-11-08T10:00:00.000Z" };
const accepted: OcxTelemetryConfig = { decision: "accepted", decidedAt: "2026-11-01T10:00:00.000Z", noticeShownAt: "2026-11-01T10:00:00.000Z" };

function liveSaveAfterDiskDecision(initial: OcxConfig, onDisk: OcxTelemetryConfig): { live: OcxConfig; saved: OcxConfig } {
  const oldHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-telemetry-live-save-"));
  process.env.OPENCODEX_HOME = home;
  try {
    saveConfig(initial);
    const live = loadConfig();
    armClaudeCodeBaseline(live);
    // A CLI process records a decision while the proxy keeps its older in-memory config.
    expect(mutatePersistedConfig(config => {
      config.telemetry = structuredClone(onDisk);
      return { changed: true, value: null };
    }).status).toBe("committed");
    live.logLevel = "debug";
    saveConfigPreservingClaudeCode(live);
    live.logLevel = "warn";
    saveConfigPreservingClaudeCode(live);
    return { live, saved: JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig };
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    removeTreeWithRetry(home);
  }
}

test("a live save keeps a telemetry decision written to disk after the proxy loaded its config", () => {
  const { live, saved } = liveSaveAfterDiskDecision(seed(), declined);
  expect(saved.logLevel).toBe("warn");
  expect(saved.telemetry).toEqual(declined);
  expect(live.telemetry).toEqual(declined);
});

test("a live save never rolls a newer decline on disk back to the accept it loaded", () => {
  const { live, saved } = liveSaveAfterDiskDecision(seed(accepted), declined);
  expect(saved.telemetry).toEqual(declined);
  expect(live.telemetry).toEqual(declined);
});

test("a live save drops a malformed telemetry block instead of adopting it", () => {
  const oldHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-telemetry-live-save-"));
  process.env.OPENCODEX_HOME = home;
  try {
    saveConfig(seed());
    const live = loadConfig();
    armClaudeCodeBaseline(live);
    // A hand edit leaves an invalid block on disk; a load would drop it, and so must a save.
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    raw.telemetry = { decision: "nope", extra: 1 };
    writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2) + "\n", "utf8");
    live.logLevel = "debug";
    saveConfigPreservingClaudeCode(live);
    expect(live.telemetry).toBeUndefined();
    expect((JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig).telemetry).toBeUndefined();
    expect(validateConfigCandidate(live).ok).toBe(true);
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    removeTreeWithRetry(home);
  }
});

test("a whole-config save from a stale snapshot keeps a newer decline on disk", () => {
  const oldHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-telemetry-live-save-"));
  process.env.OPENCODEX_HOME = home;
  try {
    saveConfig(seed(accepted));
    const stale = loadConfig();
    // Another process (`ocx telemetry disable`) declines between this load and save.
    expect(mutatePersistedConfig(config => {
      config.telemetry = structuredClone(declined);
      return { changed: true, value: null };
    }).status).toBe("committed");
    stale.logLevel = "debug";
    saveConfig(stale);
    expect((JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig).telemetry).toEqual(declined);
    expect(stale.telemetry).toEqual(declined);
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    removeTreeWithRetry(home);
  }
});

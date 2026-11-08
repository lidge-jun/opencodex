import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armClaudeCodeBaseline, getConfigPath, initializePersistedConfigIfMissing, loadConfig, mutatePersistedConfig, saveConfig, saveConfigPreservingClaudeCode, validateConfigCandidate } from "../../src/config";
import { resolveTelemetryStatus } from "../../src/telemetry/consent";
import { recordPendingTelemetryDecision, withPendingTelemetryDecision } from "../../src/telemetry/state";
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

/**
 * A whole-config save never introduces a telemetry decision, so a config holding one is created the
 * way a person's decision reaches it: the file first, then the decision through mutatePersistedConfig.
 */
function createConfig(config: OcxConfig): void {
  const { telemetry, ...rest } = config;
  saveConfig(rest as OcxConfig);
  if (!telemetry) return;
  expect(mutatePersistedConfig(persisted => {
    persisted.telemetry = structuredClone(telemetry);
    return { changed: true, value: null };
  }).status).toBe("committed");
}

function liveSaveAfterDiskDecision(initial: OcxConfig, onDisk: OcxTelemetryConfig): { live: OcxConfig; saved: OcxConfig } {
  const oldHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-telemetry-live-save-"));
  process.env.OPENCODEX_HOME = home;
  try {
    createConfig(initial);
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
    createConfig(seed(accepted));
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

test("a save over an unreadable config.json never turns an unread decline back into an accept", () => {
  const oldHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-telemetry-live-save-"));
  process.env.OPENCODEX_HOME = home;
  try {
    createConfig(seed(accepted));
    const stale = loadConfig();
    // Another process declines, then a hand edit breaks the file: the decline can no longer be read.
    expect(mutatePersistedConfig(config => {
      config.telemetry = structuredClone(declined);
      return { changed: true, value: null };
    }).status).toBe("committed");
    writeFileSync(getConfigPath(), "{ broken", "utf8");
    stale.logLevel = "debug";
    saveConfig(stale);
    // The stale accept is not written over a decision that could not be read; the install waits for the notice.
    expect((JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig).telemetry).toBeUndefined();
    expect(stale.telemetry).toBeUndefined();

    // A snapshot that holds a decline keeps it.
    const declinedSnapshot = loadConfig();
    declinedSnapshot.telemetry = structuredClone(declined);
    writeFileSync(getConfigPath(), "{ broken", "utf8");
    saveConfig(declinedSnapshot);
    expect((JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig).telemetry).toEqual(declined);
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    removeTreeWithRetry(home);
  }
});

test("a save that creates config.json never turns a pending decline into an accept", () => {
  const oldHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-telemetry-live-save-"));
  process.env.OPENCODEX_HOME = home;
  try {
    // A proxy runs without config.json and adopted a dashboard accept (held as the pending decision) ...
    const live = { ...seed(), telemetry: structuredClone(accepted) } as OcxConfig;
    recordPendingTelemetryDecision(accepted, home);
    // ... then "ocx telemetry disable" replaces the pending decision with a decline.
    recordPendingTelemetryDecision(declined, home);
    // A settings save from that proxy creates config.json.
    saveConfig(live);
    expect((JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig).telemetry).toBeUndefined();
    expect(live.telemetry).toBeUndefined();
    expect(resolveTelemetryStatus(withPendingTelemetryDecision(loadConfig(), home), {})).toMatchObject({ decision: "declined", effective: false });

    // A snapshot that holds a decline still creates the file with it.
    removeTreeWithRetry(getConfigPath());
    const declinedSnapshot = { ...seed(), telemetry: structuredClone(declined) } as OcxConfig;
    saveConfig(declinedSnapshot);
    expect((JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig).telemetry).toEqual(declined);
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    removeTreeWithRetry(home);
  }
});

test("creating config.json from an in-memory config never introduces a telemetry decision", () => {
  const oldHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-telemetry-live-save-"));
  process.env.OPENCODEX_HOME = home;
  try {
    // A running proxy holds an accept in memory while the held decision on disk is a decline.
    recordPendingTelemetryDecision(declined, home);
    const live = { ...seed(), telemetry: structuredClone(accepted) } as OcxConfig;
    expect(initializePersistedConfigIfMissing(live)).toBe("created");
    expect((JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig).telemetry).toBeUndefined();
    expect(live.telemetry).toBeUndefined();
    expect(resolveTelemetryStatus(withPendingTelemetryDecision(loadConfig(), home), {})).toMatchObject({ decision: "declined", effective: false });

    // An in-memory decline is kept.
    removeTreeWithRetry(getConfigPath());
    const declinedLive = { ...seed(), telemetry: structuredClone(declined) } as OcxConfig;
    expect(initializePersistedConfigIfMissing(declinedLive)).toBe("created");
    expect((JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig).telemetry).toEqual(declined);
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    removeTreeWithRetry(home);
  }
});

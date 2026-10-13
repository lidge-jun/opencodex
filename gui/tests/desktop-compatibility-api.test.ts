import { afterEach, expect, test } from "bun:test";
import { parseCompatibilityCertificate, parseCompatibilityRuntime, runCompatibilityAction } from "../src/desktop-compatibility-api";
import { DICTS } from "../src/i18n/catalogs";
const originalFetch = globalThis.fetch;
test("observation counters never upgrade response observations into native recovery proof", () => {
  const observation = { jsonSnapshots: 1, streamSnapshots: 3, validatedActiveStreams: 1, lastSnapshotAt: 1000,
    sourceProcessVerified: false, composerRecoveryVerified: false };
  const status = { supported: true, phase: "running", running: true,
    usage: { mode: "observe", phase: "observing", outputs: 0, appCacheConfirmed: false, observation } };
  expect(parseCompatibilityRuntime(status).usage?.observation).toEqual(observation);
  for (const invalid of [{ ...observation, sourceProcessVerified: true }, { ...observation, composerRecoveryVerified: true },
    { ...observation, streamSnapshots: -1 }, { ...observation, jsonSnapshots: "1" }, { ...observation, lastSnapshotAt: Infinity }]) {
    expect(() => parseCompatibilityRuntime({ ...status, usage: { ...status.usage, observation: invalid } })).toThrow("invalid_runtime_status");
  }
});
afterEach(() => { globalThis.fetch = originalFetch; });
test("status projection excludes private/unknown data and rejects coerced states", () => {
  const certificate = parseCompatibilityCertificate({ supported: true, state: "trusted", busy: null, fingerprint: "A".repeat(64), privateKey: "fixture-secret" });
  expect(JSON.stringify(certificate)).not.toContain("fixture-secret");
  expect(() => parseCompatibilityCertificate({ supported: true, state: ["trusted"], busy: null })).toThrow();
  expect(() => parseCompatibilityRuntime({ supported: true, phase: "off", running: true })).toThrow();
  expect(() => parseCompatibilityRuntime({ supported: true, phase: ["running"], running: true })).toThrow();
  expect(parseCompatibilityRuntime({ supported: true, phase: "running", running: true, contextFailure: "native_routing_unverified" }).contextFailure).toBe("native_routing_unverified");
  expect(() => parseCompatibilityRuntime({ supported: true, phase: "running", running: true, contextFailure: "untrusted-arbitrary-message" })).toThrow();
});
test("certificate actions bind the displayed fingerprint and never retry uncertain writes", async () => {
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_input, init) => { calls.push(init!); throw new TypeError("connection lost"); }) as typeof fetch;
  await expect(runCompatibilityAction("", { target: "certificate", action: "trust", fingerprint: "A".repeat(64) }, new AbortController().signal)).rejects.toThrow();
  expect(calls).toHaveLength(1);
  expect(JSON.parse(String(calls[0]!.body))).toEqual({ action: "trust", confirmed: true, fingerprint: "A".repeat(64) });
  await expect(runCompatibilityAction("", { target: "certificate", action: "renew" }, new AbortController().signal)).rejects.toThrow("certificate_fingerprint_required");
  expect(calls).toHaveLength(1);
});
test("only the deliberate apply action carries account-wide consent", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input, init) => { bodies.push(JSON.parse(String(init!.body))); return Response.json({ ok: true }); }) as typeof fetch;
  await runCompatibilityAction("", { target: "runtime", action: "start" }, new AbortController().signal);
  await runCompatibilityAction("", { target: "runtime", action: "apply" }, new AbortController().signal);
  expect(bodies).toEqual([{ action: "start", confirmed: true }, { action: "apply", confirmed: true, accountWideConsent: true }]);
});
test("every supported locale contains the complete compatibility consent namespace", () => {
  const keys = Object.keys(DICTS.en).filter(key => key.startsWith("desktopCompat."));
  expect(keys.length).toBeGreaterThan(20);
  for (const [locale, catalog] of Object.entries(DICTS)) {
    expect(Object.keys(catalog).filter(key => key.startsWith("desktopCompat."))).toEqual(keys);
    for (const key of keys) expect((catalog as Record<string, string>)[key]?.length).toBeGreaterThan(0);
    if (locale !== "en") expect(catalog["desktopCompat.trialRisk"]).not.toBe(DICTS.en["desktopCompat.trialRisk"]);
  }
});

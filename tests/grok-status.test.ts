import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectGrokConfig } from "../src/grok/inject";
import { grokFenceEndpointDrift, readGrokStatus } from "../src/grok/status";

function tempGrokHome(): { root: string; grokHome: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-grok-status-"));
  const grokHome = join(root, ".grok");
  mkdirSync(grokHome);
  return { root, grokHome };
}

describe("readGrokStatus", () => {
  test("reports absent when there is no config at all", () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const status = readGrokStatus({ grokHome });
      expect(status.present).toBe(false);
      expect(status.models).toEqual([]);
      expect(status.configPath).toBe(join(grokHome, "config.toml"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports absent when a config exists but carries no managed fence", () => {
    const { root, grokHome } = tempGrokHome();
    try {
      writeFileSync(join(grokHome, "config.toml"), '[model.mine]\nmodel = "my-model"\n', "utf8");
      expect(readGrokStatus({ grokHome }).present).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The reader parses the exact block `buildGrokManagedBlock` emits, so it is verified against
  // real injector output rather than a hand-written fixture that could drift from the writer.
  test("reads back what the injector wrote, including context windows", () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const result = injectGrokConfig(10190, [
        { id: "gpt-5.6-sol", contextWindow: 372_000 },
        { id: "cursor/grok-4.5", contextWindow: 500_000 },
        { id: "no-window-model" },
      ], { grokHome });
      expect(result.ok).toBe(true);

      const status = readGrokStatus({ grokHome });
      expect(status.present).toBe(true);
      expect(status.baseUrl).toBe("http://127.0.0.1:10190/v1");
      expect(status.models.map(m => `${m.id}:${m.contextWindow ?? "none"}`)).toEqual([
        "gpt-5.6-sol:372000",
        "cursor/grok-4.5:500000",
        "no-window-model:none",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // User content outside the fence can legitimately hold real credentials. The reader must not
  // surface any of it — only the region we ourselves emit.
  test("ignores everything outside the managed fence", () => {
    const { root, grokHome } = tempGrokHome();
    try {
      injectGrokConfig(10190, [{ id: "gpt-5.6-sol", contextWindow: 372_000 }], { grokHome });
      const path = join(grokHome, "config.toml");
      const existing = readFileSync(path, "utf8");
      writeFileSync(path, `[model.private]\nmodel = "secret-model"\napi_key = "sk-user-secret"\n\n${existing}`, "utf8");

      const status = readGrokStatus({ grokHome });
      expect(status.models.map(m => m.id)).toEqual(["gpt-5.6-sol"]);
      expect(JSON.stringify(status)).not.toContain("sk-user-secret");
      expect(JSON.stringify(status)).not.toContain("secret-model");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * 2026-07-27 field report: the fence named 127.0.0.1:4179 while the proxy listened on
 * 10100. Grok retried the refused connection 15 times per turn entirely on its own side,
 * so no request — and therefore no log line — ever reached opencodex. The context window
 * still read correctly, because the stale entry carried it. Nothing in the product said
 * why, which is what this check exists to fix.
 */
describe("Grok fence endpoint drift", () => {
  test("reports the mismatch when the fence names a port we do not listen on", () => {
    const drift = grokFenceEndpointDrift(
      { present: true, baseUrl: "http://127.0.0.1:4179/v1" },
      10100,
    );
    expect(drift).toEqual({ fencePort: 4179, livePort: 10100 });
  });

  test("stays quiet when the fence agrees with the live listener", () => {
    expect(grokFenceEndpointDrift(
      { present: true, baseUrl: "http://127.0.0.1:10100/v1" },
      10100,
    )).toBeNull();
  });

  // No fence, no live port, or an endpoint shape we never emit: there is nothing the user
  // could act on, and a false warning about their own config is worse than silence.
  test("stays quiet when there is nothing to compare", () => {
    expect(grokFenceEndpointDrift({ present: false, baseUrl: null }, 10100)).toBeNull();
    expect(grokFenceEndpointDrift({ present: true, baseUrl: "http://127.0.0.1:4179/v1" }, undefined)).toBeNull();
    expect(grokFenceEndpointDrift({ present: true, baseUrl: "not a url" }, 10100)).toBeNull();
    expect(grokFenceEndpointDrift({ present: true, baseUrl: "http://127.0.0.1/v1" }, 10100)).toBeNull();
  });

  test("reads the real fence a sync just wrote", () => {
    const { root, grokHome } = tempGrokHome();
    try {
      injectGrokConfig(10100, [{ id: "gpt-5.6-sol", contextWindow: 372_000 }], { grokHome });
      const status = readGrokStatus({ grokHome });
      expect(grokFenceEndpointDrift(status, 10100)).toBeNull();
      expect(grokFenceEndpointDrift(status, 4179)).toEqual({ fencePort: 10100, livePort: 4179 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

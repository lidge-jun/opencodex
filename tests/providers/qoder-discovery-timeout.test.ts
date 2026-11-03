import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchQoderModels, QODER_MODEL_DISCOVERY_TIMEOUT_MS } from "../../src/adapters/qoder/live-models";
import { clearQoderBinaryCache, QODER_GLOBAL_PROFILE } from "../../src/adapters/qoder/profiles";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #8115: `qoder --list-models` took 14.5 s on a working install, past the former 8 s bound.
beforeEach(() => clearQoderBinaryCache());
afterEach(() => clearQoderBinaryCache());

const roster = { stdout: "MODEL\nQwen3.8-Max\n", stderr: "" };

describe("qoder discovery timeout (#8115)", () => {
  test("the default bound admits a listing slower than the former 8 s limit", async () => {
    expect(QODER_MODEL_DISCOVERY_TIMEOUT_MS).toBe(30_000);
    let timeout: number | undefined;
    const result = await fetchQoderModels(QODER_GLOBAL_PROFILE, "pat", {
      which: () => "/bin/qoder",
      exec: async (_command, _args, options) => { timeout = (options as { timeout?: number }).timeout; return roster; },
    });
    expect(result).toEqual({ ok: true, models: ["Qwen3.8-Max"] });
    expect(timeout).toBe(30_000);
  });

  test("an explicit timeout is passed through unchanged", async () => {
    let timeout: number | undefined;
    await fetchQoderModels(QODER_GLOBAL_PROFILE, "pat", {
      which: () => "/bin/qoder", timeoutMs: 1_234,
      exec: async (_command, _args, options) => { timeout = (options as { timeout?: number }).timeout; return roster; },
    });
    expect(timeout).toBe(1_234);
  });

  test.each([
    ["killed", Object.assign(new Error("terminated"), { killed: true })],
    ["ETIMEDOUT", Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })],
  ])("a %s child still reports a timeout", async (_label, failure) => {
    const result = await fetchQoderModels(QODER_GLOBAL_PROFILE, "pat", {
      which: () => "/bin/qoder", exec: async () => { throw failure; },
    });
    expect(result).toEqual({ ok: false, error: "timeout", detail: "Qoder model discovery timed out" });
  });

  test.skipIf(process.platform === "win32")("a real child that outlives its bound is killed and reported as a timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-qoder-timeout-"));
    try {
      const binary = join(dir, "qoder");
      writeFileSync(binary, "#!/bin/sh\nsleep 5\necho MODEL\n");
      chmodSync(binary, 0o755);
      const started = Date.now();
      const result = await fetchQoderModels(QODER_GLOBAL_PROFILE, "pat", { which: () => binary, timeoutMs: 200 });
      expect(result).toMatchObject({ ok: false, error: "timeout" });
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally { removeTreeWithRetry(dir); }
  });
});


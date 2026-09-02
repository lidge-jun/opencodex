import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MODE_HINT_CAPABILITY_CACHE_MAX_ENTRIES,
  modeHintCapabilityCache,
  probeCodexSupportsModeHint,
} from "../src/codex/features";
import {
  resetCodexRuntimeResolveCacheForTests,
  setCodexRuntimeResolveCacheForTests,
} from "../src/codex/runtime";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

function native(supported: boolean): Buffer {
  return Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from(supported ? "multi_agent_mode_hint_text" : "older_codex_schema"),
  ]);
}

function runtimeFixture(index: number, supported: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-features-cache-"));
  roots.push(root);
  const command = join(root, `codex-${index}`);
  writeFileSync(command, native(supported));
  return command;
}

function selectRuntime(command: string): void {
  resetCodexRuntimeResolveCacheForTests();
  setCodexRuntimeResolveCacheForTests({
    runtime: { command, version: "test", source: "fallback" },
    failures: [],
  });
}

beforeEach(() => {
  modeHintCapabilityCache.clear();
  resetCodexRuntimeResolveCacheForTests();
});

afterEach(() => {
  modeHintCapabilityCache.clear();
  resetCodexRuntimeResolveCacheForTests();
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

describe("Codex mode-hint capability cache", () => {
  test("cache never exceeds its entry cap", () => {
    for (let index = 0; index < MODE_HINT_CAPABILITY_CACHE_MAX_ENTRIES * 2; index += 1) {
      selectRuntime(runtimeFixture(index, index % 2 === 0));
      probeCodexSupportsModeHint();
      expect(modeHintCapabilityCache.size).toBeLessThanOrEqual(MODE_HINT_CAPABILITY_CACHE_MAX_ENTRIES);
    }
  });

  test("eviction safely permits re-inspection", () => {
    const first = runtimeFixture(0, false);
    selectRuntime(first);
    expect(probeCodexSupportsModeHint()).toBe(false);
    for (let index = 1; index <= MODE_HINT_CAPABILITY_CACHE_MAX_ENTRIES; index += 1) {
      selectRuntime(runtimeFixture(index, false));
      expect(probeCodexSupportsModeHint()).toBe(false);
    }

    writeFileSync(first, native(true));
    selectRuntime(first);

    expect(probeCodexSupportsModeHint()).toBe(true);
  });
});

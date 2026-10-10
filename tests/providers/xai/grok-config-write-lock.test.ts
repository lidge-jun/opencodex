import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withConfigWriteLock, configWriteLockPath } from "../../../src/codex/config-write-lock";
import { buildGrokManagedBlock, injectGrokConfig, stripGrokConfig } from "../../../src/grok/inject";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

let home: string;
const models = [{ id: "fixture-model" }];
beforeEach(() => { home = fs.mkdtempSync(join(tmpdir(), "ocx-grok-write-lock-")); });
afterEach(() => { removeTreeWithRetry(home); });

test("injection and cleanup refuse a held lock without touching config or backup", () => {
  const path = join(home, "config.toml");
  const bytes = buildGrokManagedBlock(10100, models) + "\n";
  fs.writeFileSync(path, bytes);
  const result = withConfigWriteLock(path, () => {
    expect(injectGrokConfig(10101, models, { grokHome: home })).toMatchObject({ ok: false, changed: false, skippedReason: "locked", retryable: true });
    expect(stripGrokConfig({ grokHome: home })).toMatchObject({ ok: false, changed: false, skippedReason: "locked", retryable: true });
    expect(fs.readFileSync(path, "utf8")).toBe(bytes);
    expect(fs.existsSync(join(home, "config.toml.bak-opencodex"))).toBe(false);
  });
  expect(result.ok).toBe(true);
});

test("unsafe lock namespaces are distinct from retryable contention", () => {
  const path = join(home, "config.toml");
  fs.writeFileSync(path, "theme = \"light\"\n");
  fs.mkdirSync(configWriteLockPath(path));
  expect(injectGrokConfig(10100, models, { grokHome: home })).toMatchObject({ ok: false, changed: false, skippedReason: "unsafe", retryable: false });
  expect(stripGrokConfig({ grokHome: home })).toMatchObject({ ok: false, changed: false, skippedReason: "unsafe", retryable: false });
  expect(fs.readFileSync(path, "utf8")).toBe("theme = \"light\"\n");
});

for (const action of ["inject", "strip"] as const) {
  test(`${action} refuses an alias retarget after reading the locked destination`, () => {
    const path = join(home, "config.toml");
    const first = join(home, "first.toml");
    const second = join(home, "second.toml");
    const firstBytes = `theme = "first"\n${buildGrokManagedBlock(10100, models)}\n`;
    const secondBytes = 'theme = "second"\n';
    fs.writeFileSync(first, firstBytes);
    fs.writeFileSync(second, secondBytes);
    fs.symlinkSync(first, path);
    const read = fs.readFileSync;
    let retargeted = false;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...args: unknown[]) => {
      const value = (read as Function)(file, ...args);
      if (String(file) === path && !retargeted) {
        retargeted = true;
        fs.unlinkSync(path);
        fs.symlinkSync(second, path);
      }
      return value;
    }) as typeof fs.readFileSync);
    try {
      const result = action === "inject" ? injectGrokConfig(10101, models, { grokHome: home }) : stripGrokConfig({ grokHome: home });
      expect(retargeted).toBe(true);
      expect(result).toMatchObject({ ok: false, changed: false });
      expect(fs.readFileSync(first, "utf8")).toBe(firstBytes);
      expect(fs.readFileSync(second, "utf8")).toBe(secondBytes);
    } finally { spy.mockRestore(); }
  });
}

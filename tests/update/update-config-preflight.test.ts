import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { runConfigPreflight } from "../../src/update/config-preflight";

const roots: string[] = [];

function tempRoot(name: string): string {
  const root = join(tmpdir(), `ocx-update-preflight-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

describe("update config pre-flight", () => {
  test("passes when config.json is valid", () => {
    const dir = tempRoot("valid");
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({
      port: 10100,
      defaultProvider: "mock",
      providers: { mock: { adapter: "openai-chat", baseUrl: "https://api.example.com/v1" } },
    }), "utf8");

    const result = runConfigPreflight(cfg);
    expect(result.ok).toBe(true);
  });

  test("passes when config.json does not exist yet (clean install)", () => {
    const dir = tempRoot("nonexistent");
    const cfg = join(dir, "config.json");

    const result = runConfigPreflight(cfg);
    expect(result.ok).toBe(true);
  });

  test("fails closed when config.json has invalid JSON syntax", () => {
    const dir = tempRoot("syntax-error");
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, "{ port: 10100, invalid json", "utf8");

    const result = runConfigPreflight(cfg);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_json");
  });

  test("fails closed when config.json violates schema", () => {
    const dir = tempRoot("schema-error");
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ port: "invalid_string_port", providers: 123 }), "utf8");

    const result = runConfigPreflight(cfg);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_schema");
  });

  test("fails closed when config.json is an occupied entry that cannot be read (dangling symlink)", () => {
    const dir = tempRoot("dangling-symlink");
    const target = join(dir, "target-does-not-exist.json");
    const cfg = join(dir, "config.json");
    symlinkSync(target, cfg);

    const result = runConfigPreflight(cfg);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("read_error");
  });
});

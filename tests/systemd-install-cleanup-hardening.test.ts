import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../src/service.ts"), "utf8");

describe("systemd install cleanup status hardening", () => {
  test("only treats literal not-found as confirmed unit absence", () => {
    expect(source).toContain('if (!loadState) throw new Error("systemd service status could not be verified.");');
    expect(source).toContain('return loadState === "not-found" ? null : loadState;');
    expect(source).not.toContain('return !loadState || loadState === "not-found" ? null : loadState;');
  });
});

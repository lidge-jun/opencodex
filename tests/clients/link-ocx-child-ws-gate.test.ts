import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

// Lane T6-4: ocx-child's link WebSocket gate opens only in a build with the link-ws-test-gate Cargo
// feature. These checks keep that true for the builds operators make and keep both test runs wired.

const pkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8")) as { scripts: Record<string, string> };
const cargo = readFileSync(repoPath("native/ocx-child/Cargo.toml"), "utf8");

describe("ocx-child link WebSocket test gate", () => {
  test("the distribution build passes no Cargo features", () => {
    expect(pkg.scripts["build:ocx-child"]).toBe("cargo build --release --locked --manifest-path native/ocx-child/Cargo.toml");
  });

  test("the feature is off by default and the gated integration target requires it", () => {
    expect(cargo).toMatch(/\[features\]\n(?:#.*\n)*link-ws-test-gate = \[\]/);
    expect(cargo).not.toMatch(/^default\s*=/m);
    expect(cargo).toMatch(/\[\[test\]\]\nname = "link_websocket"\nrequired-features = \["link-ws-test-gate"\]/);
  });

  test("the test script runs the crate without the feature (gate provably closed) and with it (the integration target)", () => {
    const script = pkg.scripts["test:ocx-child"] ?? "";
    const runs = script.split("&&").map(part => part.trim());
    expect(runs).toEqual([
      "cargo test --locked --manifest-path native/ocx-child/Cargo.toml",
      "cargo test --locked --manifest-path native/ocx-child/Cargo.toml --features link-ws-test-gate",
    ]);
  });
});

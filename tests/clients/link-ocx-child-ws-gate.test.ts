import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { rustToolchainEnv } from "../helpers/rust-toolchain-env";

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

  // CI reaches ocx-child only through tests like these, so both Cargo runs happen here too.
  const toolchain = rustToolchainEnv("cargo");
  const manifest = repoPath("native", "ocx-child", "Cargo.toml");
  const runCargo = (args: string[]) => {
    const run = Bun.spawnSync([toolchain.bin!, "test", "--locked", "--manifest-path", manifest, ...args], {
      env: toolchain.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 240_000,
    });
    if (run.signalCode) throw new Error(`cargo test ${args.join(" ")} ended by ${run.signalCode}:\n${run.stderr.toString()}`);
    expect(run.exitCode, `${run.stderr.toString()}\ntoolchain: ${toolchain.describe()}`).toBe(0);
    return run.stdout.toString();
  };

  test.skipIf(toolchain.bin === null)("without the feature the link WebSocket unit tests pass and the gate stays closed", () => {
    const out = runCargo(["--lib", "link_ws"]);
    expect(out).toContain("link_ws_advert::tests::gate_stays_closed_without_the_test_feature ... ok");
  }, 240_000);

  test.skipIf(toolchain.bin === null)("with the feature the real-binary link WebSocket tests pass", () => {
    const out = runCargo(["--features", "link-ws-test-gate", "--test", "link_websocket"]);
    expect(out).toContain("with_the_gate_an_advertising_home_carries_frames_both_ways ... ok");
  }, 240_000);
});

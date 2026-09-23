import { expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";

const script = await Bun.file(repoPath("desktop", "scripts", "prepare-sidecar.ts")).text();

test("desktop sidecar preparation maps supported Rust targets", () => {
  for (const value of [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
  ]) expect(script).toContain(value);
  expect(script).toContain("build:standalone");
  expect(script).toContain("binaries");
  expect(script).toContain("resources");
  expect(script).toContain("ocx-${triple}");
});

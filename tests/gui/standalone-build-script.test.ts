import { expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";

const script = await Bun.file(repoPath("scripts", "build-standalone.ts")).text();
const targets = await Bun.file(repoPath("scripts", "standalone-targets.ts")).text();

test("standalone build script exposes supported targets and packaging contract", () => {
  // The target list lives in the shared module the release verifier also reads;
  // the build script consumes it rather than restating it.
  expect(script).toContain("./standalone-targets");
  for (const target of [
    "bun-darwin-arm64",
    "bun-darwin-x64",
    "bun-windows-x64",
    "bun-linux-x64",
    "bun-linux-arm64",
  ]) expect(targets).toContain(target);
  expect(script).toContain("--compile");
  expect(script).toContain("--outfile");
  expect(script).toContain("gui/dist");
  expect(script).toContain("SHA256SUMS");
});

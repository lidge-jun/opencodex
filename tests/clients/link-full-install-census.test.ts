import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFullInstallCensus, remoteFullInstallCensusArgv } from "../../src/link/remote-plant";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * O1 --require-ephemeral: the census walks every full ocx candidate the gated argv would try (the served-runtime
 * census, Desktop, system and PATH) and does not stop at an ocx-child, unlike runtime inspection.
 */
let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "ocx-census-")); });
afterAll(() => { if (dir) removeTreeWithRetry(dir); });

function executable(path: string, body: string): void {
  writeFileSync(path, "#!/bin/sh\n" + body + "\n");
  chmodSync(path, 0o755);
}

function census(home: string, path: string): { code: number; stdout: string } {
  const argv = remoteFullInstallCensusArgv();
  const result = Bun.spawnSync(["/bin/sh", ...argv.slice(1)], { env: { HOME: home, PATH: path, OPENCODEX_HOME: join(home, ".opencodex") }, stdin: "ignore" });
  return { code: result.exitCode ?? -1, stdout: result.stdout.toString() };
}

test.skipIf(process.platform === "win32")("a Child with ocx-child state and a full ocx on PATH reports the full install", () => {
  const home = join(dir, "both"), bin = join(home, "bin");
  mkdirSync(join(home, ".opencodex", "child"), { recursive: true });
  writeFileSync(join(home, ".opencodex", "child", "state.json"), "{}");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  executable(join(home, ".local", "bin", "ocx-child"), "echo 'opencodex 2.99.0'");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "ocx"), "echo 'opencodex 2.99.0'");
  const result = census(home, bin + ":/usr/bin:/bin");
  expect(result.code).toBe(0);
  expect(parseFullInstallCensus(result.stdout)).toBe("present");
});

test.skipIf(process.platform === "win32")("an ocx-child alone, or an ocx that cannot run, reports none", () => {
  const home = join(dir, "child-only"), bin = join(home, "bin");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  executable(join(home, ".local", "bin", "ocx-child"), "echo 'opencodex 2.99.0'");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "ocx"), "exit 1");
  const result = census(home, bin + ":/usr/bin:/bin");
  expect(result.code).toBe(0);
  expect(parseFullInstallCensus(result.stdout)).toBe("none");
});

test("the parser needs the closing marker and reads anything else as unknown", () => {
  expect(parseFullInstallCensus("ocx-census:done\n")).toBe("none");
  expect(parseFullInstallCensus("login banner\nocx-census:full\nocx-census:done\n")).toBe("present");
  expect(parseFullInstallCensus("ocx-census:full\n")).toBeNull();
  expect(parseFullInstallCensus("")).toBeNull();
});

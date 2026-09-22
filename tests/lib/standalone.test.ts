import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { realpathSync } from "node:fs";
import {
  isStandaloneBinary,
  isStandaloneModuleUrl,
  standaloneRoot,
} from "../../src/lib/standalone";

test("source Bun processes are not identified as compiled binaries", () => {
  expect(isStandaloneBinary()).toBe(false);
});

test("compiled module URL markers are recognized on POSIX and Windows", () => {
  expect(isStandaloneModuleUrl("file:///$bunfs/root/src/cli/index.ts")).toBe(true);
  expect(isStandaloneModuleUrl("file:///B:/~BUN/root/src/cli/index.ts")).toBe(true);
  expect(isStandaloneModuleUrl("file:///Users/x/src/lib/standalone.ts")).toBe(false);
});

test("standaloneRoot follows the running executable", () => {
  expect(standaloneRoot()).toBe(dirname(realpathSync(process.execPath)));
});

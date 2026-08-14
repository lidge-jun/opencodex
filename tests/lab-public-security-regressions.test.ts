import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcsStringify } from "../src/lab/conformance/jcs";
import { labPublicPublisherKeyPath } from "../src/lab/paths";
import { publishPrivateFileExclusive } from "../src/lab/public/private-file";
import { getOrCreatePublicPublisher } from "../src/lab/public/signature";
import {
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../src/lib/windows-secret-acl";

const roots: string[] = [];

afterEach(() => {
  setIcaclsRunnerForTests(null);
  setPlatformForTests(null);
  resetHardenedStateForTests();
  for (const root of roots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

function configDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

test("JCS rejects sparse JavaScript arrays instead of collapsing holes", () => {
  const sparse = new Array<unknown>(1);
  expect(() => jcsStringify(sparse)).toThrow(/sparse|array hole/i);
});

test("private publication prepares an empty stage before writing secret bytes", () => {
  const root = configDir("ocx-cl10-private-stage-prepare-");
  const finalPath = join(root, "secret.bin");
  const observedSizes: number[] = [];

  expect(publishPrivateFileExclusive(finalPath, Buffer.from("secret", "utf8"), {
    prepareStage: stagePath => observedSizes.push(statSync(stagePath).size),
  })).toEqual({ created: true });
  expect(observedSizes).toEqual([0]);
});

test("publisher key creation applies required Windows secret ACL hardening to the final key path", () => {
  const home = configDir("ocx-cl10-windows-publisher-acl-");
  const keyPath = labPublicPublisherKeyPath(home);
  const calls: string[][] = [];

  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setIcaclsRunnerForTests((args) => {
    calls.push(args);
    return { success: true, exitCode: 0, timedOut: false, stdout: "" };
  });

  expect(getOrCreatePublicPublisher(home).publisher.algorithm).toBe("ed25519");
  expect(existsSync(keyPath)).toBe(true);
  expect(calls.some((args) => args[0] === keyPath && args.includes("/grant:r"))).toBe(true);
  expect(calls.some((args) => args[0] === keyPath && args.includes("/inheritance:r"))).toBe(true);
});

test("publisher key creation never publishes the final path when required Windows ACL hardening fails", () => {
  const home = configDir("ocx-cl10-windows-publisher-acl-fail-");
  const keyPath = labPublicPublisherKeyPath(home);

  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setIcaclsRunnerForTests(() => ({
    success: false,
    exitCode: 5,
    timedOut: false,
    stdout: "",
  }));

  expect(() => getOrCreatePublicPublisher(home)).toThrow(/ACL hardening/i);
  expect(existsSync(keyPath)).toBe(false);
});

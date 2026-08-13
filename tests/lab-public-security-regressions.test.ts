import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcsStringify } from "../src/lab/conformance/jcs";
import { labPublicPublisherKeyPath } from "../src/lab/paths";
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

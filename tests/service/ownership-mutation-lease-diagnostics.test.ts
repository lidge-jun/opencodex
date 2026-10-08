import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnershipMutationLease,
  inspectOwnershipMutationLease,
  ownershipMutationLeaseStatusLine,
} from "../../src/service/ownership-mutation-lease.mjs";

describe("ownership mutation lease diagnostic lookup (carry #6655)", () => {
  const instance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const pid = 6236;
  let root: string;
  let paths: string[];
  let lock: string;
  let owner: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-lease-diagnostics-"));
    paths = [join(root, "service-state.json")];
    lock = `${paths[0]}.mutation.lock`;
    owner = join(lock, `v1-${pid}-${instance}-${token}.json`);
    mkdirSync(lock);
    writeFileSync(owner, JSON.stringify({ version: 1, pid, processInstance: instance, token, createdAt: 1_000 }));
    utimesSync(owner, 1, 1);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function onPlatform(platform: NodeJS.Platform, run: () => void) {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      run();
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  }

  function interceptLookup(stdout: string) {
    return spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0, stdout, stderr: "", pid: 1, output: [null, stdout, ""], signal: null,
    });
  }

  test("Windows inspection, status and busy refusal launch zero diagnostic subprocesses and preserve the owner", () => {
    const bytes = readFileSync(owner);
    const identity = lstatSync(owner);
    const spawned = interceptLookup(`"untrusted-tasklist.exe","${pid}"`);
    try {
      onPlatform("win32", () => {
        const options = { now: () => 213_000, processAlive: () => true };
        expect(inspectOwnershipMutationLease(paths, options))
          .toMatchObject({ pid, alive: true, image: null, ageMs: 212_000, record: "complete" });
        const line = ownershipMutationLeaseStatusLine(paths, options);
        expect(line).toContain(`recorded PID ${pid} [alive, identity unverified], lease age 212s`);
        expect(line).toContain("stale leases are reclaimed after 30s once the recorded PID is no longer alive.");
        let busy: unknown;
        try {
          acquireOwnershipMutationLease(paths, { ...options, waitMs: 0 }).release();
        } catch (error) { busy = error; }
        expect(busy).toBeInstanceOf(Error);
        expect(busy).toMatchObject({
          code: "OWNERSHIP_MUTATION_LEASE_BUSY",
          holder: { pid, alive: true, image: null, ageMs: 212_000, record: "complete" },
        });
        expect((busy as Error).message).toContain("another process owns the runtime mutation lease");
        expect(spawned).not.toHaveBeenCalled();
      });
    } finally { spawned.mockRestore(); }
    expect(readFileSync(owner)).toEqual(bytes);
    expect(lstatSync(owner)).toMatchObject({ dev: identity.dev, ino: identity.ino, mtimeMs: identity.mtimeMs });
    expect(readdirSync(lock)).toEqual([`v1-${pid}-${instance}-${token}.json`]);
  });

  test("Windows status leaves a stale dead owner intact and acquisition still reclaims it", () => {
    const bytes = readFileSync(owner);
    const spawned = interceptLookup("must not be used");
    try {
      onPlatform("win32", () => {
        const options = { now: () => 600_000, processAlive: () => false };
        expect(inspectOwnershipMutationLease(paths, options))
          .toMatchObject({ pid, alive: false, image: null, ageMs: 599_000 });
        expect(ownershipMutationLeaseStatusLine(paths, options)).toContain(`[not alive, identity unverified]`);
        expect(readFileSync(owner)).toEqual(bytes);
        const lease = acquireOwnershipMutationLease(paths, { ...options, waitMs: 0 });
        try {
          expect(existsSync(owner)).toBe(false);
          const entry = readdirSync(lock)[0];
          expect(JSON.parse(readFileSync(join(lock, entry), "utf8")))
            .toMatchObject({ pid: process.pid, token: lease.token });
        } finally { lease.release(); }
        expect(existsSync(lock)).toBe(false);
        expect(spawned).not.toHaveBeenCalled();
      });
    } finally { spawned.mockRestore(); }
  });

  test("POSIX diagnostics retain the bounded ps lookup and executable basename", () => {
    const spawned = interceptLookup(" /usr/local/bin/lease-holder \n");
    try {
      onPlatform("linux", () => {
        expect(inspectOwnershipMutationLease(paths, { now: () => 2_000, processAlive: () => true }))
          .toMatchObject({ pid, alive: true, image: "lease-holder", ageMs: 1_000 });
        expect(spawned).toHaveBeenCalledTimes(1);
        expect(spawned).toHaveBeenCalledWith("ps", ["-o", "comm=", "-p", String(pid)], {
          encoding: "utf8", timeout: 1_000,
        });
      });
    } finally { spawned.mockRestore(); }
  });

  test("Windows still accepts an explicitly supplied optional image resolver", () => {
    const spawned = interceptLookup("must not be used");
    try {
      onPlatform("win32", () => {
        const image = (recordedPid: number) => recordedPid === pid ? "supplied-image.exe" : null;
        expect(inspectOwnershipMutationLease(paths, { processAlive: () => true, processImage: image }))
          .toMatchObject({ pid, alive: true, image: "supplied-image.exe" });
        expect(spawned).not.toHaveBeenCalled();
      });
    } finally { spawned.mockRestore(); }
  });
});

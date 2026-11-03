import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_UNINSTALL_MANIFEST,
  CONFIG_UNINSTALL_RECORDS,
  recordOwnedConfigPath,
  removeOwnedConfigState,
} from "../../src/lib/config-ownership";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #8093: two processes sharing one config home must not drop each other's recorded paths.
const modulePath = repoPath("src/lib/config-ownership.ts");
const childScript = (dir: string, rel: string) => `import { recordOwnedConfigPath } from ${JSON.stringify(modulePath)};\n`
  + `if (!recordOwnedConfigPath(${JSON.stringify(dir)}, ${JSON.stringify(join(dir, rel))})) process.exit(1);`;
const manifestPaths = (dir: string) =>
  (JSON.parse(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")) as { paths: string[] }).paths;

function withHome(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-ownership-record-"));
    const dir = join(parent, "home");
    try { await fn(dir); } finally { removeTreeWithRetry(parent); }
  };
}

describe("concurrent ownership recording (#8093)", () => {
  test("a path recorded by another process survives a later write from a stale cache", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
    expect(Bun.spawnSync([process.execPath, "-e", childScript(dir, "other")]).exitCode).toBe(0);
    expect(recordOwnedConfigPath(dir, join(dir, "local"))).toBe(true);
    for (const name of ["config.json", "other", "local"]) writeFileSync(join(dir, name), name);
    expect(manifestPaths(dir)).toEqual(expect.arrayContaining(["other", "local"]));
    expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(dir)).toBe(false);
  }));

  test("simultaneous recordings from several processes are all removed by uninstall", withHome(async dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
    const names = Array.from({ length: 6 }, (_, i) => `parallel-${i}`);
    const children = names.map(name => Bun.spawn([process.execPath, "-e", childScript(dir, name)]));
    expect(await Promise.all(children.map(child => child.exited))).toEqual(names.map(() => 0));
    for (const name of names) writeFileSync(join(dir, name), name);
    expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
  }));

  test("an already recorded path does not touch disk", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
    expect(recordOwnedConfigPath(dir, join(dir, "fresh"))).toBe(true);
    rmSync(join(dir, CONFIG_UNINSTALL_RECORDS), { recursive: true });
    const manifest = readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8");
    expect(recordOwnedConfigPath(dir, join(dir, "fresh"))).toBe(true);
    expect(existsSync(join(dir, CONFIG_UNINSTALL_RECORDS))).toBe(false);
    expect(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")).toBe(manifest);
  }));

  test.skipIf(process.platform === "win32")("records are private files in a private directory", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "fresh"))).toBe(true);
    const records = join(dir, CONFIG_UNINSTALL_RECORDS);
    expect(lstatSync(records).mode & 0o777).toBe(0o700);
    const files = readdirSync(records);
    expect(files).toHaveLength(1);
    expect(lstatSync(join(records, files[0]!)).mode & 0o077).toBe(0);
  }));

  test.skipIf(process.platform === "win32")("a linked record directory is never written through", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
    const outside = join(dir, "..", "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(dir, CONFIG_UNINSTALL_RECORDS));
    expect(recordOwnedConfigPath(dir, join(dir, "fresh"))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  }));

  test("a record that this module did not write makes uninstall fail closed", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "fresh"))).toBe(true);
    writeFileSync(join(dir, CONFIG_UNINSTALL_RECORDS, `${"0".repeat(64)}.path`), "keep-me");
    writeFileSync(join(dir, "keep-me"), "user data");
    expect(removeOwnedConfigState(dir).status).toBe("refused");
    expect(existsSync(join(dir, "keep-me"))).toBe(true);
  }));
});


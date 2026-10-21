import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { rotateServiceLog } from "../../src/service/logging";

const roots: string[] = [];
function sandbox(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-service-log-")));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
async function cli(service: boolean, args = ["start", "--port", "invalid"]) {
  const root = sandbox();
  const env = { ...process.env, HOME: root, OPENCODEX_HOME: join(root, ".opencodex"), CODEX_HOME: join(root, ".codex") };
  delete env.OCX_SERVICE;
  if (service) env.OCX_SERVICE = "1";
  const child = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), ...args], {
    cwd: repoRoot(), env, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("managed service log", () => {
  test("CLI start errors receive an ISO timestamp only under OCX_SERVICE", async () => {
    const managed = await cli(true);
    const interactive = await cli(false);
    expect(managed.code).toBe(1);
    expect(interactive.code).toBe(1);
    expect(managed.stderr.trim()).toMatch(timestamp);
    expect(managed.stderr.replace(new RegExp(timestamp.source, "gm"), "")).toBe(interactive.stderr);
  });

  test("inherited OCX_SERVICE does not change other CLI command output", async () => {
    const managed = await cli(true, ["--version"]);
    const interactive = await cli(false, ["--version"]);
    expect(managed.code).toBe(0);
    expect(managed.stdout).toBe(interactive.stdout);
    expect(managed.stdout).not.toMatch(timestamp);
  });

  test("all console sinks prefix every line and preserve formatted arguments", async () => {
    const path = join(sandbox(), "service.log");
    const child = Bun.spawn([process.execPath, "--eval", `
      const { startServiceLogging } = await import(${JSON.stringify(repoPath("src/service/logging.ts"))});
      const stop = startServiceLogging(${JSON.stringify(path)}, { OCX_SERVICE: "1" });
      console.log("hello %s\\nnext", "world");
      console.info("info"); console.debug("debug"); console.warn("warn");
      console.error(new Error("sample diagnostic"));
      stop(); console.log("plain");
    `], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines.pop()).toBe("plain");
    for (const line of [...lines, ...stderr.trimEnd().split("\n")]) expect(line).toMatch(timestamp);
    expect(stdout.replace(new RegExp(timestamp.source, "gm"), "")).toBe("hello world\nnext\ninfo\ndebug\nplain\n");
    expect(stderr).toContain("Error: sample diagnostic");
  });

  test("copy-truncate keeps the open append descriptor and two bounded generations", () => {
    const path = join(sandbox(), "service.log");
    writeFileSync(path, "oldest\nlatest\n");
    const inode = statSync(path).ino;
    const fd = openSync(path, "a");
    try {
      expect(rotateServiceLog(path, 7)).toBe(true);
      expect(statSync(path).ino).toBe(inode);
      expect(statSync(path).size).toBe(0);
      expect(readFileSync(`${path}.1`, "utf8")).toBe("latest\n");
      writeSync(fd, "second line\n");
      expect(readFileSync(path, "utf8")).toBe("second line\n");
      expect(rotateServiceLog(path, 7)).toBe(true);
      expect(readFileSync(`${path}.2`, "utf8")).toBe("latest\n");
      writeSync(fd, "third line\n");
      expect(rotateServiceLog(path, 7)).toBe(true);
      expect(readFileSync(`${path}.1`, "utf8")).toBe("d line\n");
      expect(readFileSync(`${path}.2`, "utf8")).toBe("d line\n");
      expect(existsSync(`${path}.3`)).toBe(false);
    } finally { closeSync(fd); }
  });

  test("missing, small, exact-cap and failed rotations leave logging usable", () => {
    const path = join(sandbox(), "service.log");
    expect(rotateServiceLog(path, 8)).toBe(false);
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, "small");
    expect(rotateServiceLog(path, 8)).toBe(false);
    writeFileSync(path, "exactcap");
    expect(rotateServiceLog(path, 8)).toBe(false);
    expect(existsSync(`${path}.1`)).toBe(false);
    writeFileSync(path, "over the cap");
    writeFileSync(`${path}.1`, "previous");
    mkdirSync(`${path}.2`);
    expect(rotateServiceLog(path, 8)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("over the cap");
    expect(rotateServiceLog(path, 0)).toBe(false);
  });

  for (const suffix of ["", ".1", ".2"]) {
    test(`hardlinked ${suffix || "active"} leaf is rejected without changing any file`, () => {
      const root = sandbox();
      const path = join(root, "service.log");
      const target = join(root, "unrelated.txt");
      writeFileSync(target, "unrelated contents");
      for (const leaf of ["", ".1", ".2"]) {
        if (leaf === suffix) linkSync(target, `${path}${leaf}`);
        else writeFileSync(`${path}${leaf}`, `original ${leaf || "active"}`);
      }
      const before = ["", ".1", ".2"].map(leaf => readFileSync(`${path}${leaf}`, "utf8"));
      expect(rotateServiceLog(path, 4)).toBe(false);
      expect(["", ".1", ".2"].map(leaf => readFileSync(`${path}${leaf}`, "utf8"))).toEqual(before);
      expect(readFileSync(target, "utf8")).toBe("unrelated contents");
    });

    test.skipIf(process.platform === "win32")(`symlinked ${suffix || "active"} leaf is rejected`, () => {
      const root = sandbox();
      const path = join(root, "service.log");
      const target = join(root, "unrelated.txt");
      writeFileSync(target, "unrelated contents");
      if (suffix) writeFileSync(path, "active contents");
      symlinkSync(target, `${path}${suffix}`);
      expect(rotateServiceLog(path, 4)).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("unrelated contents");
      if (suffix) expect(readFileSync(path, "utf8")).toBe("active contents");
    });
  }

  test("a non-regular active leaf is rejected", () => {
    const path = join(sandbox(), "service.log");
    mkdirSync(path);
    expect(rotateServiceLog(path, 4)).toBe(false);
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  test("an allowed parent directory alias still rotates", () => {
    const root = sandbox();
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    mkdirSync(actual);
    symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
    const path = join(alias, "service.log");
    writeFileSync(path, "oldest latest");
    expect(rotateServiceLog(path, 6)).toBe(true);
    expect(readFileSync(join(actual, "service.log.1"), "utf8")).toBe("latest");
  });

  test("parent aliases use canonical exclusive creation without weakening flags", () => {
    const root = sandbox();
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    mkdirSync(actual);
    symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
    const path = join(alias, "service.log");
    writeFileSync(path, "oldest latest");
    const open = fs.openSync;
    let exclusiveOpens = 0;
    const hook = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: number, ...args: unknown[]) => {
      if (String(file).endsWith(".1")) {
        exclusiveOpens++;
        expect(file).toBe(join(realpathSync(actual), "service.log.1"));
        expect(flags & fs.constants.O_EXCL).toBe(fs.constants.O_EXCL);
        expect(flags & fs.constants.O_CREAT).toBe(fs.constants.O_CREAT);
        expect(flags & fs.constants.O_TRUNC).toBe(0);
      }
      return Reflect.apply(open, fs, [file, flags, ...args]);
    }) as typeof fs.openSync);
    try { expect(rotateServiceLog(path, 6)).toBe(true); }
    finally { hook.mockRestore(); }
    expect(exclusiveOpens).toBe(1);
    expect(readFileSync(join(actual, "service.log.1"), "utf8")).toBe("latest");
  });

  for (const boundary of ["resolve", "copy"] as const) {
    test(`parent alias retargeted during ${boundary} preserves both source files`, () => {
      const root = sandbox();
      const actual = join(root, "actual");
      const other = join(root, "other");
      const alias = join(root, "alias");
      mkdirSync(actual); mkdirSync(other);
      writeFileSync(join(actual, "service.log"), "original contents");
      writeFileSync(join(other, "service.log"), "replacement contents");
      symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
      const method = boundary === "resolve" ? "realpathSync" : "readSync";
      const original = fs[method];
      let changed = false;
      const hook = spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
        const result = Reflect.apply(original, fs, args);
        if (!changed) {
          changed = true;
          renameSync(alias, `${alias}.saved`);
          symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
        }
        return result;
      }) as typeof original);
      try { expect(rotateServiceLog(join(alias, "service.log"), 4)).toBe(false); }
      finally { hook.mockRestore(); }
      expect(changed).toBe(true);
      expect(readFileSync(join(actual, "service.log"), "utf8")).toBe("original contents");
      expect(readFileSync(join(other, "service.log"), "utf8")).toBe("replacement contents");
      expect(existsSync(join(other, "service.log.1"))).toBe(false);
    });
  }

  test("an archive inserted through a parent alias still fails exclusive creation", () => {
    const root = sandbox();
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    mkdirSync(actual);
    symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
    const path = join(alias, "service.log");
    writeFileSync(path, "original contents");
    const open = fs.openSync;
    const hook = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (file === join(actual, "service.log.1")) writeFileSync(`${path}.1`, "inserted contents");
      return Reflect.apply(open, fs, [file, ...args]);
    }) as typeof fs.openSync);
    try { expect(rotateServiceLog(path, 4)).toBe(false); }
    finally { hook.mockRestore(); }
    expect(readFileSync(path, "utf8")).toBe("original contents");
    expect(readFileSync(`${path}.1`, "utf8")).toBe("inserted contents");
  });

  test("replacement between leaf inspection and source open is not truncated", () => {
    const path = join(sandbox(), "service.log");
    writeFileSync(path, "original contents");
    const open = fs.openSync;
    const hook = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (file === path) {
        renameSync(path, `${path}.saved`);
        writeFileSync(path, "replacement contents");
      }
      return Reflect.apply(open, fs, [file, ...args]);
    }) as typeof fs.openSync);
    try { expect(rotateServiceLog(path, 4)).toBe(false); }
    finally { hook.mockRestore(); }
    expect(readFileSync(path, "utf8")).toBe("replacement contents");
    expect(readFileSync(`${path}.saved`, "utf8")).toBe("original contents");
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  test("an archive inserted after rename is not opened destructively", () => {
    const path = join(sandbox(), "service.log");
    writeFileSync(path, "active contents");
    writeFileSync(`${path}.1`, "previous archive");
    const open = fs.openSync;
    const hook = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (file === `${path}.1`) writeFileSync(`${path}.1`, "inserted contents");
      return Reflect.apply(open, fs, [file, ...args]);
    }) as typeof fs.openSync);
    try { expect(rotateServiceLog(path, 4)).toBe(false); }
    finally { hook.mockRestore(); }
    expect(readFileSync(path, "utf8")).toBe("active contents");
    expect(readFileSync(`${path}.1`, "utf8")).toBe("inserted contents");
    expect(readFileSync(`${path}.2`, "utf8")).toBe("previous archive");
  });

  for (const change of ["replace-source", "link-source", "replace-archive", "link-archive", "read-failure"] as const) {
    test(`copy boundary refuses ${change} and preserves the source`, () => {
      const path = join(sandbox(), "service.log");
      writeFileSync(path, "original contents");
      const read = fs.readSync;
      let changed = false;
      const hook = spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
        const count = Reflect.apply(read, fs, args);
        if (!changed) {
          changed = true;
          const leaf = change.endsWith("archive") ? `${path}.1` : path;
          if (change.startsWith("replace")) {
            renameSync(leaf, `${leaf}.saved`);
            writeFileSync(leaf, "replacement contents");
          } else if (change.startsWith("link")) linkSync(leaf, `${leaf}.linked`);
          else throw new Error("synthetic copy failure");
        }
        return count;
      }) as typeof fs.readSync);
      try { expect(rotateServiceLog(path, 4)).toBe(false); }
      finally { hook.mockRestore(); }
      expect(readFileSync(change === "replace-source" ? `${path}.saved` : path, "utf8")).toBe("original contents");
      if (change.startsWith("replace")) {
        expect(readFileSync(change.endsWith("archive") ? `${path}.1` : path, "utf8")).toBe("replacement contents");
      }
      if (change === "link-archive") expect(readFileSync(`${path}.1.linked`, "utf8")).toBe("");
    });
  }

  test("a write failure after a partial archive leaves the active log intact", () => {
    const path = join(sandbox(), "service.log");
    const contents = "x".repeat(128 * 1024 + 1);
    writeFileSync(path, contents);
    const write = fs.writeSync;
    let writes = 0;
    const hook = spyOn(fs, "writeSync").mockImplementation(((...args: unknown[]) => {
      if (++writes === 2) throw new Error("synthetic disk failure");
      return Reflect.apply(write, fs, args);
    }) as typeof fs.writeSync);
    try { expect(rotateServiceLog(path, 128 * 1024)).toBe(false); }
    finally { hook.mockRestore(); }
    expect(writes).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(contents);
    expect(statSync(`${path}.1`).size).toBe(64 * 1024);
  });

  test("archive flush failure preserves the active source", () => {
    const path = join(sandbox(), "service.log");
    writeFileSync(path, "original contents");
    const hook = spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("synthetic flush failure"); });
    try { expect(rotateServiceLog(path, 4)).toBe(false); }
    finally { hook.mockRestore(); }
    expect(readFileSync(path, "utf8")).toBe("original contents");
  });

  test("rotation checks at startup and periodically only for service processes", async () => {
    const path = join(sandbox(), "service.log");
    const child = Bun.spawn([process.execPath, "--eval", `
      const fs = await import("node:fs");
      const { startServiceLogging, SERVICE_LOG_MAX_BYTES: cap } = await import(${JSON.stringify(repoPath("src/service/logging.ts"))});
      const path = ${JSON.stringify(path)};
      const grow = () => { fs.writeFileSync(path, ""); fs.truncateSync(path, cap + 1); };
      grow();
      const original = console.log;
      startServiceLogging(path, {}, 10)();
      if (console.log !== original || fs.statSync(path).size !== cap + 1) process.exit(2);
      const stop = startServiceLogging(path, { OCX_SERVICE: "1" }, 10);
      if (fs.statSync(path).size !== 0 || fs.statSync(path + ".1").size !== cap) process.exit(3);
      grow();
      await Bun.sleep(80);
      stop();
      if (fs.statSync(path).size !== 0 || fs.statSync(path + ".2").size !== cap) process.exit(4);
    `], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  });
});

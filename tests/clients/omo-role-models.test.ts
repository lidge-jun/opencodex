import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { omoJsoncPath, readOmoRoleModels, writeOmoRoleModel } from "../../src/clients/omo-role-models";
import { hasJsoncComments } from "../../src/lib/jsonc";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function file(text?: string): string {
  dir = mkdtempSync(join(tmpdir(), "ocx-omo-roles-"));
  const path = join(dir, "omo.jsonc");
  if (text !== undefined) writeFileSync(path, text);
  return path;
}

describe("omo role models", () => {
  test("writes [codex].agents.<role>.model and keeps sibling keys and indentation", () => {
    const path = file('{\n    "agents": { "sisyphus": { "model": "a" } },\n    "[codex]": { "agents": { "explorer": { "reasoning": "high" } } }\n}\n');
    expect(writeOmoRoleModel("explorer", "gpt-5.6-sol", path)).toBe("written");
    const written = readFileSync(path, "utf8");
    expect(JSON.parse(written)).toEqual({
      agents: { sisyphus: { model: "a" } },
      "[codex]": { agents: { explorer: { reasoning: "high", model: "gpt-5.6-sol" } } },
    });
    expect(written.startsWith('{\n    "agents"')).toBe(true);
    expect(written.endsWith("}\n")).toBe(true);
    expect(readOmoRoleModels(path)).toEqual({ state: "present", models: { explorer: "gpt-5.6-sol" } });
    expect(writeOmoRoleModel("explorer", "gpt-5.6-sol", path)).toBe("unchanged");
  });

  test("creates the [codex] block in a file that has none", () => {
    const path = file("{}");
    expect(writeOmoRoleModel("librarian", "m", path)).toBe("written");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "[codex]": { agents: { librarian: { model: "m" } } } });
  });

  test("a bare codex key, which LazyCodex ignores, is neither read nor written", () => {
    const path = file('{ "codex": { "agents": { "explorer": { "model": "stale" } } } }');
    expect(readOmoRoleModels(path)).toEqual({ state: "present", models: {} });
    expect(writeOmoRoleModel("explorer", "m", path)).toBe("written");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      codex: { agents: { explorer: { model: "stale" } } },
      "[codex]": { agents: { explorer: { model: "m" } } },
    });
  });

  test("a file with comments is reported and left byte for byte", () => {
    const text = '{\n  // pick carefully\n  "[codex]": {}\n}\n';
    const path = file(text);
    expect(writeOmoRoleModel("explorer", "m", path)).toBe("skipped_comments");
    expect(readOmoRoleModels(path)).toEqual({ state: "comments" });
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("a missing file is reported absent and not created", () => {
    const path = file();
    expect(writeOmoRoleModel("explorer", "m", path)).toBe("absent");
    expect(readOmoRoleModels(path)).toEqual({ state: "absent" });
    expect(() => readFileSync(path)).toThrow();
  });

  test("refuses a symlink substituted before the integration file is opened", () => {
    const path = file("{}");
    const secret = join(dir!, "secret.json");
    writeFileSync(secret, '{ "tokens": { "access_token": "secret" } }');
    const realOpen = fs.openSync;
    const spy = spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
      if (target === path) {
        rmSync(path);
        symlinkSync(secret, path);
      }
      return realOpen(target, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(writeOmoRoleModel("explorer", "m", path)).toBe("invalid");
      expect(readFileSync(secret, "utf8")).toBe('{ "tokens": { "access_token": "secret" } }');
    } finally {
      spy.mockRestore();
    }
  });

  test.each(["dev", "ino"] as const)("rejects distinct %s values that collide as numbers", identity => {
    const path = file("{}");
    const first = 2n ** 53n;
    const second = first + 1n;
    expect(first).not.toBe(second);
    expect(Number(first)).toBe(Number(second));
    const numeric = fs.lstatSync(path);
    const exact = fs.lstatSync(path, { bigint: true });
    const realFstat = fs.fstatSync;
    const realLstat = fs.lstatSync;
    const opened = spyOn(fs, "fstatSync").mockImplementation(((fd, options) => {
      const stats = realFstat(fd, options);
      return Object.assign(stats, { [identity]: options?.bigint ? first : Number(first) });
    }) as typeof fs.fstatSync);
    const current = spyOn(fs, "lstatSync").mockImplementation(((target, options) => {
      if (target !== path) return realLstat(target, options);
      return Object.assign(options?.bigint ? exact : numeric, {
        [identity]: options?.bigint ? second : Number(second),
      });
    }) as typeof fs.lstatSync);
    const read = spyOn(fs, "readFileSync");
    const close = spyOn(fs, "closeSync");
    try {
      expect(readOmoRoleModels(path)).toEqual({ state: "invalid" });
      expect(writeOmoRoleModel("explorer", "m", path)).toBe("invalid");
      expect(read).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(2);
      expect(close.mock.calls.map(([fd]) => fd)).toEqual(opened.mock.calls.map(([fd]) => fd));
    } finally {
      close.mockRestore();
      read.mockRestore();
      current.mockRestore();
      opened.mockRestore();
    }
    expect(readFileSync(path, "utf8")).toBe("{}");
  });

  test.skipIf(process.platform === "win32").each(["read", "write"])(
    "%s refuses a FIFO without waiting for a writer",
    operation => {
      const path = file();
      expect(spawnSync("mkfifo", [path], { timeout: 3000 }).status).toBe(0);
      const moduleUrl = new URL("../../src/clients/omo-role-models.ts", import.meta.url).href;
      const script = `
        const { readOmoRoleModels, writeOmoRoleModel } = await import(${JSON.stringify(moduleUrl)});
        const result = process.argv[2] === "read"
          ? readOmoRoleModels(process.argv[1])
          : writeOmoRoleModel("explorer", "m", process.argv[1]);
        console.log(JSON.stringify(result));
      `;
      // A subprocess deadline bounds the test even if synchronous open regresses.
      const child = spawnSync(process.execPath, ["--eval", script, path, operation], {
        timeout: 3000, killSignal: "SIGKILL", encoding: "utf8",
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(operation === "read" ? { state: "invalid" } : "invalid");
      expect(fs.lstatSync(path).isFIFO()).toBe(true);
    },
  );

  test("a [codex] value of the wrong shape is invalid rather than overwritten", () => {
    const text = '{ "[codex]": { "agents": ["explorer"] } }';
    const path = file(text);
    expect(writeOmoRoleModel("explorer", "m", path)).toBe("invalid");
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("an explicit null [codex], agents, or role entry is invalid and left byte for byte", () => {
    for (const text of ['{ "[codex]": null }', '{ "[codex]": { "agents": null } }', '{ "[codex]": { "agents": { "explorer": null } } }']) {
      const path = file(text);
      expect(writeOmoRoleModel("explorer", "m", path)).toBe("invalid");
      expect(readFileSync(path, "utf8")).toBe(text);
      rmSync(dir!, { recursive: true, force: true });
    }
  });

  test("an unreadable file reads as unreadable, and the write still reports the failure", () => {
    const path = file('{ "[codex]": {} }');
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const spy = spyOn(fs, "readFileSync").mockImplementation((() => { throw denied; }) as never);
    try {
      expect(readOmoRoleModels(path)).toEqual({ state: "unreadable" });
      expect(() => writeOmoRoleModel("explorer", "m", path)).toThrow("EACCES");
    } finally {
      spy.mockRestore();
    }
  });

  test("comment detection ignores comment markers inside strings", () => {
    expect(hasJsoncComments('{ "url": "https://example.com/*x*/" }')).toBe(false);
    expect(hasJsoncComments('{ "a": 1 /* note */ }')).toBe(true);
    expect(hasJsoncComments('{ "a": 1 /* open')).toBe(true);
  });

  test("the path follows HOME before USERPROFILE", () => {
    expect(omoJsoncPath({ HOME: "/h", USERPROFILE: "/u" }, "/os")).toBe(join("/h", ".omo", "omo.jsonc"));
    expect(omoJsoncPath({ USERPROFILE: "/u" }, "/os")).toBe(join("/u", ".omo", "omo.jsonc"));
    expect(omoJsoncPath({}, "/os")).toBe(join("/os", ".omo", "omo.jsonc"));
  });
});

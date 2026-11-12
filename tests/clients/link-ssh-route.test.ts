import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createLinkPathReader, resolveLinkPathFromConfig } from "../../src/link/ssh-route";

const HOME = "/home/fixture";
const SYSTEM = "/etc/ssh/ssh_config";

/** An in-memory file tree; a path absent from it reads as missing, `denied` paths as unreadable. */
function files(tree: Record<string, string>, denied: string[] = []) {
  const reads: string[] = [];
  return {
    reads,
    deps: {
      home: HOME,
      systemConfig: SYSTEM,
      readFile: (path: string) => {
        reads.push(path);
        if (denied.includes(path)) throw Object.assign(new Error("denied"), { code: "EACCES" });
        if (!(path in tree)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return tree[path]!;
      },
      glob: (pattern: string) => Object.keys(tree).filter(path => new Bun.Glob(pattern).match(path)).sort(),
    },
  };
}
const user = (body: string, extra: Record<string, string> = {}) => files({ [join(HOME, ".ssh", "config")]: body, ...extra });

describe("link path from ssh_config, without running ssh (#3023)", () => {
  test("a relay ProxyCommand, a ProxyJump host and a plain host", () => {
    const config = user("Host pen-*\n  ProxyCommand pen pipe %h\nHost behind\n  ProxyJump bastion\nHost lan-box\n  HostName 192.0.2.4\n");
    expect(resolveLinkPathFromConfig("pen-home", config.deps)).toBe("proxy-command");
    expect(resolveLinkPathFromConfig("behind", config.deps)).toBe("proxy-jump");
    expect(resolveLinkPathFromConfig("lan-box", config.deps)).toBe("direct");
  });

  test("the first value obtained wins, none included, and the first of ProxyCommand or ProxyJump decides", () => {
    expect(resolveLinkPathFromConfig("home", user("Host home\n  ProxyCommand none\nHost *\n  ProxyCommand nc %h %p\n").deps)).toBe("direct");
    expect(resolveLinkPathFromConfig("home", user("Host home\n  ProxyJump bastion\nHost *\n  ProxyCommand nc %h %p\n").deps)).toBe("proxy-jump");
    expect(resolveLinkPathFromConfig("home", user("ProxyCommand=nc %h %p\nHost home\n  ProxyJump bastion\n").deps)).toBe("proxy-command");
  });

  test("host patterns: wildcards, negation and case", () => {
    const config = user("Host * !home\n  ProxyCommand nc %h %p\n");
    expect(resolveLinkPathFromConfig("home", config.deps)).toBe("direct");
    expect(resolveLinkPathFromConfig("other", config.deps)).toBe("proxy-command");
    expect(resolveLinkPathFromConfig("Pen-Home", user("Host pen-?ome\n  ProxyCommand x\n").deps)).toBe("proxy-command");
  });

  test("a Match block before the decision or canonicalization reads unknown; one after the decision does not matter", () => {
    expect(resolveLinkPathFromConfig("home", user("Match exec \"slow-command\"\n  ProxyCommand x\nHost home\n  ProxyJump b\n").deps)).toBe("unknown");
    expect(resolveLinkPathFromConfig("home", user("Host home\n  ProxyJump b\nMatch exec \"slow-command\"\n  ProxyCommand x\n").deps)).toBe("proxy-jump");
    expect(resolveLinkPathFromConfig("home", user("CanonicalizeHostname yes\nHost home\n  ProxyJump b\n").deps)).toBe("unknown");
  });

  test("includes: top level and inside a matching Host block are read, inside another Host block are not", () => {
    const tree = user("Include config.d/*\nHost other\n  Include other.conf\n", {
      [join(HOME, ".ssh", "config.d", "pen")]: "Host pen-*\n  ProxyCommand pen pipe %h\n",
      [join(HOME, ".ssh", "other.conf")]: "Host *\n  ProxyJump b\n",
    });
    expect(resolveLinkPathFromConfig("pen-home", tree.deps)).toBe("proxy-command");
    expect(resolveLinkPathFromConfig("lan", tree.deps)).toBe("direct");
    expect(tree.reads).not.toContain(join(HOME, ".ssh", "other.conf"));
  });

  test("the system file applies after the user's, a missing file is empty, an unreadable one is unknown", () => {
    const tree = files({ [SYSTEM]: "Host *\n  ProxyCommand corp-proxy %h\n" });
    expect(resolveLinkPathFromConfig("home", tree.deps)).toBe("proxy-command");
    expect(resolveLinkPathFromConfig("home", files({}).deps)).toBe("direct");
    expect(resolveLinkPathFromConfig("home", files({}, [join(HOME, ".ssh", "config")]).deps)).toBe("unknown");
  });
});

describe("ssh_config reading, review round 5 (#3023)", () => {
  test("ProxyJump none blocks a later ProxyJump but not a later ProxyCommand, as OpenSSH does", () => {
    expect(resolveLinkPathFromConfig("home", user("Host home\n  ProxyJump none\nHost *\n  ProxyCommand nc %h %p\n").deps)).toBe("proxy-command");
    expect(resolveLinkPathFromConfig("home", user("Host home\n  ProxyJump none\nHost *\n  ProxyJump b\n").deps)).toBe("direct");
    expect(resolveLinkPathFromConfig("home", user("Host home\n  ProxyCommand none\nHost *\n  ProxyJump b\n").deps)).toBe("direct");
  });

  test("an oversized file or too many included files read unknown without reading past the bound", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-ssh-route-"));
    try {
      mkdirSync(join(dir, ".ssh", "many"), { recursive: true });
      writeFileSync(join(dir, ".ssh", "config"), "Include many/*\n");
      for (let i = 0; i < 70; i++) writeFileSync(join(dir, ".ssh", "many", `f${String(i).padStart(2, "0")}`), "# nothing\n");
      expect(resolveLinkPathFromConfig("home", { home: dir, systemConfig: null })).toBe("unknown");
      writeFileSync(join(dir, ".ssh", "config"), "# " + "x".repeat(300 * 1024) + "\nHost home\n  ProxyJump b\n");
      expect(resolveLinkPathFromConfig("home", { home: dir, systemConfig: null })).toBe("unknown");
      writeFileSync(join(dir, ".ssh", "config"), "Host home\n  ProxyJump b\n");
      expect(resolveLinkPathFromConfig("home", { home: dir, systemConfig: null })).toBe("proxy-jump");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("one status read reads each file once, however many rows it resolves", () => {
    const tree = user("Host a\n  ProxyJump b\n");
    const read = createLinkPathReader(tree.deps);
    expect([read("a"), read("b"), read("c")]).toEqual(["proxy-jump", "direct", "direct"]);
    expect(tree.reads.filter(path => path === join(HOME, ".ssh", "config"))).toHaveLength(1);
  });
});

describe("ssh_config reading, review round 6 (#3023)", () => {
  test("host patterns full of wildcards match in linear time", () => {
    const alias = "a".repeat(255);
    const pattern = "*a".repeat(200) + "*b";
    expect(resolveLinkPathFromConfig(alias, user(`Host ${pattern}\n  ProxyCommand x\n`).deps)).toBe("direct");
    expect(resolveLinkPathFromConfig(alias + "b", user(`Host ${pattern}\n  ProxyCommand x\n`).deps)).toBe("proxy-command");
  });

  test("a named pipe, a wildcard directory, or a huge directory read unknown without blocking or walking a tree", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "ocx-ssh-route-"));
    try {
      mkdirSync(join(dir, ".ssh", "big"), { recursive: true });
      expect(Bun.spawnSync(["mkfifo", join(dir, ".ssh", "config")]).exitCode).toBe(0);
      expect(resolveLinkPathFromConfig("home", { home: dir, systemConfig: null })).toBe("unknown");
      rmSync(join(dir, ".ssh", "config"));
      writeFileSync(join(dir, ".ssh", "config"), "Include */config\n");
      expect(resolveLinkPathFromConfig("home", { home: dir, systemConfig: null })).toBe("unknown");
      for (let i = 0; i < 1100; i++) writeFileSync(join(dir, ".ssh", "big", `skip-${i}`), "");
      writeFileSync(join(dir, ".ssh", "config"), "Include big/match-*\nHost home\n  ProxyJump b\n");
      expect(resolveLinkPathFromConfig("home", { home: dir, systemConfig: null })).toBe("unknown");
      writeFileSync(join(dir, ".ssh", "config"), "Include conf.d/*.conf\n");
      mkdirSync(join(dir, ".ssh", "conf.d"));
      writeFileSync(join(dir, ".ssh", "conf.d", "pen.conf"), "Host home\n  ProxyCommand pen pipe %h\n");
      writeFileSync(join(dir, ".ssh", "conf.d", ".hidden.conf"), "Host home\n  ProxyJump b\n");
      expect(resolveLinkPathFromConfig("home", { home: dir, systemConfig: null })).toBe("proxy-command");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

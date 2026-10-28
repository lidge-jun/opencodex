import { expect, test } from "bun:test";
import { existsSync, linkSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { atomicWriteFileNoFollow } from "../../src/config/atomic-write";
import { createTempHome } from "../helpers/temp-home";
import { repoPath } from "../helpers/repo-root";

test("exclusive secret publication preserves exact bytes and removes its private temp", () => {
  const home = createTempHome("ocx-exclusive-");
  try {
    const path = home.path("recovery.bak");
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0x00, 0x0d, 0x0a]);
    atomicWriteFileNoFollow(path, bytes, undefined, {
      afterTempWrite: temp => {
        expect(readFileSync(temp)).toEqual(bytes);
        if (process.platform !== "win32") expect(statSync(temp).mode & 0o777).toBe(0o600);
      },
    }, { exclusive: true });
    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(home.root)).toEqual(["recovery.bak"]);
  } finally { home.remove(); }
});

test("exclusive publication refuses an occupant inserted at the final boundary", () => {
  const home = createTempHome("ocx-exclusive-raced-");
  try {
    const path = home.path("recovery.bak");
    expect(() => atomicWriteFileNoFollow(path, "new-secret", undefined, {
      beforeRename: () => { writeFileSync(path, "unrelated-original"); },
    }, { exclusive: true })).toThrow();
    expect(readFileSync(path, "utf8")).toBe("unrelated-original");
    expect(readdirSync(home.root)).toEqual(["recovery.bak"]);
  } finally { home.remove(); }
});

test("exclusive publication rejects temp substitution after writing and before publication", () => {
  const home = createTempHome("ocx-exclusive-substituted-");
  try {
    const path = home.path("recovery.bak");
    let replacedTemp = "";
    expect(() => atomicWriteFileNoFollow(path, "private-original", undefined, {
      beforeRename: temp => {
        replacedTemp = temp;
        renameSync(temp, home.path("moved-private-temp"));
        writeFileSync(temp, "replacement");
      },
    }, { exclusive: true })).toThrow();
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(home.path("moved-private-temp"), "utf8")).toBe("private-original");
    expect(readFileSync(replacedTemp, "utf8")).toBe("replacement");
  } finally { home.remove(); }
});

test("exclusive publication scrubs and removes its temp when caller validation fails", () => {
  const home = createTempHome("ocx-exclusive-denied-");
  try {
    expect(() => atomicWriteFileNoFollow(home.path("recovery.bak"), "private-original", undefined, {
      validateBeforeRename: () => { throw new Error("denied"); },
    }, { exclusive: true })).toThrow("denied");
    expect(readdirSync(home.root)).toEqual([]);
  } finally { home.remove(); }
});

test("a failed post-publication receipt never scrubs the published hard link", () => {
  const home = createTempHome("ocx-exclusive-receipt-");
  try {
    const path = home.path("recovery.bak");
    expect(() => atomicWriteFileNoFollow(path, "private-original", undefined, {
      afterRename: () => { throw new Error("receipt failed"); },
    }, { exclusive: true })).toThrow("receipt failed");
    expect(readFileSync(path, "utf8")).toBe("private-original");
    expect(readdirSync(home.root)).toEqual(["recovery.bak"]);
  } finally { home.remove(); }
});

test("an error returned after link publication cannot scrub the published copy", () => {
  const home = createTempHome("ocx-exclusive-uncertain-");
  try {
    const path = home.path("recovery.bak");
    const module = pathToFileURL(repoPath("src/config/atomic-write.ts")).href;
    const child = Bun.spawnSync([process.execPath, "--eval", `import { mock } from 'bun:test'; import * as fs from 'node:fs';
      const real = { ...fs }; mock.module('node:fs', () => ({ ...real, linkSync(source, target) {
        real.linkSync(source, target); throw Object.assign(new Error('uncertain publication'), { code: 'EIO' });
      }}));
      const { atomicWriteFileNoFollow } = await import(${JSON.stringify(module)});
      try { atomicWriteFileNoFollow(${JSON.stringify(path)}, 'complete-original', undefined, {}, { exclusive: true }); }
      catch { console.log('rejected'); }`], { env: { ...process.env } });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain("rejected");
    expect(readFileSync(path, "utf8")).toBe("complete-original");
    expect(readdirSync(home.root)).toEqual(["recovery.bak"]);
  } finally { home.remove(); }
});

test("exclusive cleanup never truncates or removes a substituted inode", () => {
  const home = createTempHome("ocx-exclusive-foreign-");
  try {
    const path = home.path("recovery.bak");
    const victim = home.path("unrelated");
    writeFileSync(victim, "untouched");
    let replacedTemp = "";
    expect(() => atomicWriteFileNoFollow(path, "private-original", undefined, {
      beforeRename: temp => {
        replacedTemp = temp;
        renameSync(temp, home.path("moved-private-temp"));
        linkSync(victim, temp);
      },
    }, { exclusive: true })).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(readFileSync(replacedTemp, "utf8")).toBe("untouched");
    expect(existsSync(path)).toBe(false);
  } finally { home.remove(); }
});

test("exclusive cleanup preserves a shared inode even before publication", () => {
  const home = createTempHome("ocx-exclusive-shared-");
  try {
    const other = home.path("shared-original");
    expect(() => atomicWriteFileNoFollow(home.path("recovery.bak"), "complete-original", undefined, {
      beforeRename: temp => { linkSync(temp, other); throw new Error("denied"); },
    }, { exclusive: true })).toThrow("denied");
    expect(readFileSync(other, "utf8")).toBe("complete-original");
    expect(readdirSync(home.root)).toEqual(["shared-original"]);
  } finally { home.remove(); }
});

test("a filesystem reporting zero inode identity still accepts ordinary private writes", () => {
  const home = createTempHome("ocx-zero-identity-");
  try {
    const ordinary = home.path("config.json");
    const exclusive = home.path("recovery.bak");
    const module = pathToFileURL(repoPath("src/config/atomic-write.ts")).href;
    const child = Bun.spawnSync([process.execPath, "--eval", `import { mock } from 'bun:test'; import * as fs from 'node:fs';
      const real = { ...fs };
      const zero = stats => { if (typeof stats?.ino === 'bigint') Object.defineProperty(stats, 'ino', { value: 0n }); return stats; };
      mock.module('node:fs', () => ({ ...real,
        fstatSync: (fd, options) => zero(real.fstatSync(fd, options)),
        lstatSync: (path, options) => zero(real.lstatSync(path, options)),
      }));
      const { atomicWriteFile, atomicWriteFileNoFollow } = await import(${JSON.stringify(module)});
      atomicWriteFile(${JSON.stringify(ordinary)}, 'ordinary-save');
      console.log('ordinary-ok');
      try { atomicWriteFileNoFollow(${JSON.stringify(exclusive)}, 'recovery', undefined, {}, { exclusive: true }); console.log('exclusive-ok'); }
      catch { console.log('exclusive-refused'); }`], { env: { ...process.env } });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.exitCode, output).toBe(0);
    expect(output).toContain("ordinary-ok");
    expect(output).toContain("exclusive-refused");
    expect(readFileSync(ordinary, "utf8")).toBe("ordinary-save");
    expect(existsSync(exclusive)).toBe(false);
  } finally { home.remove(); }
});

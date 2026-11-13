import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { inspectUpdateMarker, inspectUpdateSyncMutex } from "../../src/update/sync-update-mutex.mjs";

/**
 * The copied repository tree is npm-hoisted: a nested node_modules may rely on a dependency hoisted to an
 * ancestor. pnpm instead links every dependency beside its dependent, and the global-store verifier holds
 * the fixture to that shape, so each nested group gets a sibling link to the hoisted dependency it uses.
 */
function linkHoistedDependenciesIntoNestedGroups(top: string) {
  const groups = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .flatMap(entry => entry.name.startsWith("@")
      ? readdirSync(join(dir, entry.name)).map(name => join(dir, entry.name, name))
      : [join(dir, entry.name)])
    .flatMap(pkg => existsSync(join(pkg, "node_modules")) ? [join(pkg, "node_modules"), ...groups(join(pkg, "node_modules"))] : []);
  for (const group of groups(top)) {
    for (const entry of readdirSync(group)) {
      const names = entry.startsWith("@") ? readdirSync(join(group, entry)).map(name => entry + "/" + name) : [entry];
      for (const name of names) {
        const manifest = join(group, name, "package.json");
        if (!existsSync(manifest)) continue;
        const deps = Object.keys(JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {});
        for (const dep of deps) {
          if (existsSync(join(group, dep)) || !existsSync(join(top, dep))) continue;
          mkdirSync(dirname(join(group, dep)), { recursive: true });
          symlinkSync(join(top, dep), join(group, dep), "dir");
        }
      }
    }
  }
}

/** Release the post-run fence so the next parent run in this fixture is admitted. */
function expireFixtureFence(home: string) {
  const path = join(home, "update-orchestrated.json");
  if (!existsSync(path)) return;
  const marker = JSON.parse(readFileSync(path, "utf8"));
  expect(inspectUpdateSyncMutex(home)).toBe("free");
  if (marker.fenceUntil === undefined) { expect(inspectUpdateMarker(home)).toBe("free"); return; }
  marker.fenceUntil = marker.startedAt;
  writeFileSync(path, JSON.stringify(marker));
}

/**
 * #8183 end to end: a pnpm 12 global virtual-store install (global group link into
 * <pnpm home>/store/v11/links/...) goes through parent owner discovery, the serialized pnpm owner
 * expectation, child revalidation, pnpm add pinned to the proven store, and parent readback. A child
 * that sees a different store refuses before any mutation.
 */
test.skipIf(process.platform === "win32")("orchestrated pnpm update of a global virtual-store install", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-pnpm-gvs-child-")));
  const home = join(root, "home"), pnpmHome = join(root, "pnpm-home"), bin = join(pnpmHome, "bin");
  const store = join(pnpmHome, "store", "v11"), group = join(pnpmHome, "global", "v11");
  const real = join(store, "links", "@bitkyc08", "opencodex", "2.0.0", "h", "node_modules", "@bitkyc08", "opencodex");
  const exposed = join(group, "g1", "node_modules", "@bitkyc08", "opencodex");
  const log = join(root, "pnpm.log");
  for (const dir of [home, bin, real, dirname(exposed)]) mkdirSync(dir, { recursive: true });
  try {
    cpSync(repoPath("src"), join(real, "src"), { recursive: true }); cpSync(repoPath("bin"), join(real, "bin"), { recursive: true });
    const manifest = JSON.parse(readFileSync(repoPath("package.json"), "utf8")); manifest.version = "2.0.0";
    writeFileSync(join(real, "package.json"), JSON.stringify(manifest));
    // pnpm puts dependencies beside the package in its links group, never inside it, which is the shape the
    // released verifier refuses (#8183) and only the store proof accepts. Copy the real tree even when
    // node_modules is itself a link, so the fixture never writes into the checkout.
    const linksGroup = dirname(dirname(real)), repoModules = realpathSync(repoPath("node_modules"));
    cpSync(repoModules, linksGroup, { recursive: true, verbatimSymlinks: true,
      filter: source => !source.slice(repoModules.length + 1).startsWith(".") });
    linkHoistedDependenciesIntoNestedGroups(linksGroup);
    symlinkSync(real, exposed, "dir");
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 1 }));
    const executable = Bun.which("node"); if (!executable) throw new Error("Node required");
    const node = spawnSync(executable, ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
    if (!node || !node.startsWith("/")) throw new Error("Node executable is not an absolute path");
    for (const name of ["ocx", "opencodex"]) { writeFileSync(join(bin, name), "#!/bin/sh\nexec '" + node + "' '" + exposed + "/bin/ocx.mjs' \"$@\"\n"); chmodSync(join(bin, name), 0o755); }
    writeFileSync(join(bin, "pnpm"), "#!" + node + "\n" + [
      "const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),e=process.env;",
      "fs.appendFileSync(e.OCX_FIXTURE_LOG,JSON.stringify({args:a,child:e.OCX_UPDATE_ORCHESTRATED_CHILD==='1'})+'\\n');",
      "const m=JSON.parse(fs.readFileSync(p.join(e.OCX_FIXTURE_REAL,'package.json')));",
      "const childStore=e.OCX_FIXTURE_CHILD_STORE&&e.OCX_UPDATE_ORCHESTRATED_CHILD==='1';",
      "if(a[0]==='--version') console.log('12.16.1');",
      "else if(a[0]==='list') console.log(JSON.stringify([{path:e.OCX_FIXTURE_GROUP,dependencies:{'@bitkyc08/opencodex':{version:m.version,path:e.OCX_FIXTURE_EXPOSED}}}]));",
      "else if(a[0]==='root') console.log(e.OCX_FIXTURE_GROUP);",
      "else if(a[0]==='bin') console.log(e.OCX_FIXTURE_BIN);",
      "else if(a[0]==='config') console.log(a[2]==='global-bin-dir'?e.OCX_FIXTURE_BIN:'undefined');",
      "else if(a[0]==='store'&&a[1]==='path'&&a.length===3&&a[2]==='--dir='+e.PNPM_HOME) console.log(childStore?e.OCX_FIXTURE_CHILD_STORE:e.OCX_FIXTURE_STORE);",
      "else if(a[0]==='view') console.log(a.includes('dist.integrity')?'sha512-YWJj':'2.1.0');",
      // The updated tree also gains an in-store node_modules link, so it satisfies the released verifier as
      // well; the parent's readback must still re-prove the pinned store owner instead of demoting it.
      "else if(a[0]==='add'){m.version='2.1.0';fs.writeFileSync(p.join(e.OCX_FIXTURE_REAL,'package.json'),JSON.stringify(m));fs.symlinkSync(p.dirname(p.dirname(e.OCX_FIXTURE_REAL)),p.join(e.OCX_FIXTURE_REAL,'node_modules'),'dir');}",
      "else process.exit(90);",
    ].join("\n") + "\n");
    chmodSync(join(bin, "pnpm"), 0o755);
    const env = { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: join(root, "codex"), PNPM_HOME: pnpmHome,
      OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_UPDATE_ORCHESTRATED_CHILD: "0", OPENCODEX_BUN_PATH: process.execPath,
      PATH: bin, OCX_FIXTURE_LOG: log, OCX_FIXTURE_REAL: real, OCX_FIXTURE_EXPOSED: exposed, OCX_FIXTURE_GROUP: group, OCX_FIXTURE_BIN: bin, OCX_FIXTURE_STORE: store };
    const parent = (extraEnv: Record<string, string> = {}) => spawnSync(node, [join(exposed, "bin/ocx.mjs"), "update", "--yes", "--json"],
      { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60000 });
    const adds = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(call => call.args[0] === "add") : [];

    // The child sees a different store than the parent proved: refused before any pnpm add.
    const otherStore = join(root, "other-pnpm", "store", "v11"); mkdirSync(otherStore, { recursive: true });
    const drifted = parent({ OCX_FIXTURE_CHILD_STORE: otherStore });
    // The child's own store proof refuses (before it stops the proxy), so the parent reports no change.
    expect(drifted.status).not.toBe(0);
    expect(drifted.stderr).toContain("pnpm global-store package is outside the selected store");
    expect(JSON.parse(drifted.stdout)).toMatchObject({ applied: false, rolledBack: false });
    expect(adds()).toEqual([]);
    expect(JSON.parse(readFileSync(join(real, "package.json"), "utf8")).version).toBe("2.0.0");
    expireFixtureFence(home);

    // Same store in parent and child: the update applies with add pinned to the proven lexical store.
    const applied = parent();
    expect({ status: applied.status, stderr: applied.stderr }).toMatchObject({ status: 0 });
    expect(JSON.parse(applied.stdout)).toMatchObject({ applied: true, toVersion: "2.1.0" });
    expect(adds()).toHaveLength(1);
    expect(adds()[0]).toMatchObject({ child: true });
    expect(adds()[0].args).toContain("--store-dir=" + store);
    expect(adds()[0].args).toContain("@bitkyc08/opencodex@2.1.0");
    expect(JSON.parse(readFileSync(join(real, "package.json"), "utf8")).version).toBe("2.1.0");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 150000);

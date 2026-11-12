import { expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePnpmActiveLauncher, runOwnedPnpm } from "../../src/update/index";
import { runPnpmGlobalUpdate } from "../../src/update/pnpm-global-install.mjs";
import { PNPM_READ_CWD, pnpmReadEnvironment, withPnpmCommandCwd } from "../../src/update/pnpm-read-policy.mjs";

test("both pnpm environment prefixes override every case variant without mutating the parent", () => {
  const original = { npm_config_ignore_pnpmfile: "false", NPM_CONFIG_IGNORE_PNPMFILE: "false", PnPm_CoNfIg_IgNoRe_PnPmFiLe: "false", pnpm_config_ignore_pnpmfile: "false", KEEP: "retained" };
  const result = pnpmReadEnvironment(original);
  expect(result).toEqual({ npm_config_ignore_pnpmfile: "true", pnpm_config_ignore_pnpmfile: "true", KEEP: "retained" });
  expect(original.npm_config_ignore_pnpmfile).toBe("false");
});

test("mutation workspaces are unique, bounded to known files, and cleaned after a thrown callback", () => {
  const seen: string[] = [];
  for (let i=0; i<2; i++) {
    expect(() => withPnpmCommandCwd(["add", "-g", "fixture"], cwd => {
      seen.push(cwd);
      expect(cwd).not.toBe(tmpdir()); expect(cwd).not.toBe(PNPM_READ_CWD);
      expect(readFileSync(cwd + "/pnpm-workspace.yaml", "utf8")).toContain("packages: []");
      if (process.platform !== "win32") expect(lstatSync(cwd).mode & 0o077).toBe(0);
      throw new Error("fixture failure");
    })).toThrow("fixture failure");
  }
  expect(seen[0]).not.toBe(seen[1]);
  for (const cwd of seen) expect(existsSync(cwd)).toBe(false);
});

const fixtureHome = realpathSync(mkdtempSync(join(tmpdir(), "ocx-isolation-home-")));
const fixtureStore = join(fixtureHome, "store", "v11");
mkdirSync(fixtureStore, { recursive: true });
/** A legacy global group: the released owner shape, with no store query. */
const owner = { commandPath: "/trusted/pnpm", packagePath: "/pkg", globalDir: "/global", globalRoot: "/global", globalBinDir: "/bin" };
const storeOwner = { ...owner, globalStore: true, store: realpathSync(fixtureStore), storePath: fixtureStore, virtualStoreDirs: [], homeAnchor: fixtureHome };
test("read-only owned pnpm permits only the anchored store path query and refuses store mutation", () => {
  let calls = 0;
  const spawn = ((_bin: unknown, _argv: unknown, options: { cwd: string }) => {
    calls++;
    // Same cwd policy as list -g: the store answer must come from the context the listing used.
    expect(options.cwd).toBe(PNPM_READ_CWD);
    return { status: 0, stdout: fixtureStore, stderr: "", pid: 1, output: [], signal: null };
  }) as never;
  expect(runOwnedPnpm(storeOwner, ["store", "path", `--dir=${fixtureHome}`], true, "pipe", spawn).status).toBe(0);
  for (const args of [["store", "path"], ["store", "path", "--store-dir=/elsewhere"], ["store", "path", "--dir=relative"], ["store", "prune"]]) {
    expect(runOwnedPnpm(storeOwner, args, true, "pipe", spawn).status).toBe(1);
  }
  expect(calls).toBe(1);
});

test.skipIf(process.platform === "win32")("GUI active launcher verification runs the selected fixture pnpm store probe", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ocx-gui-pnpm-")));
  try {
    const globalDir = join(home, "global"), globalRoot = join(globalDir, "v11"), globalBinDir = join(home, "bin");
    const store = join(home, "custom", "v11"), group = join(store, "links", "pkg", "node_modules");
    const packagePath = join(group, "@bitkyc08", "opencodex"), launcher = join(packagePath, "bin", "ocx.mjs");
    for (const dir of [globalBinDir, globalRoot, join(packagePath, "bin"), join(group, "bun", "bin"), join(group, "zod")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(packagePath, "package.json"), JSON.stringify({ version: "2.0.0", dependencies: { bun: "1", zod: "1" } }));
    writeFileSync(launcher, "x".repeat(1024));
    writeFileSync(join(group, "bun", "package.json"), "{}");
    writeFileSync(join(group, "zod", "package.json"), "{}");
    const binary = join(group, "bun", "bin", "bun"); closeSync(openSync(binary, "w")); truncateSync(binary, 10 * 1024 * 1024);
    for (const name of ["ocx", "opencodex"]) {
      const shim = join(globalBinDir, name); writeFileSync(shim, `#!/bin/sh\nexec node '${launcher}' "$@"\n`); chmodSync(shim, 0o755);
    }
    const commandPath = join(home, "pnpm");
    const listing = JSON.stringify([{ path: globalRoot, dependencies: { "@bitkyc08/opencodex": { version: "2.0.0", path: packagePath } } }]);
    writeFileSync(commandPath, `#!/usr/bin/env node\nconst command = process.argv[2];\nif (command === 'list') console.log(${JSON.stringify(listing)});\nelse if (command === '--version') console.log('12.16.1');\nelse if (command === 'store' && process.argv[3] === 'path' && process.argv[4] === ${JSON.stringify("--dir=" + home)}) console.log(${JSON.stringify(store)});\nelse if (command === 'config') console.log('undefined');\nelse process.exit(1);\n`, { mode: 0o755 });
    expect(resolvePnpmActiveLauncher({ commandPath, packagePath, globalDir, globalRoot, globalBinDir, globalStore: true, store, storePath: store, virtualStoreDirs: [], homeAnchor: home })).toBe(launcher);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
for (const fail of [false,true]) {
  test(`actual pnpm spawn options isolate ${fail ? "rollback" : "install"} and registry reads`, () => {
    const mutations: string[] = [];
    let listCall=0, addCall=0, spawnCalls=0;
    const versions = fail ? ["1.0.0","1.0.1","1.0.0"] : ["1.0.0","1.0.1"];
    const result = runPnpmGlobalUpdate({ packageName:"ocx_test", currentVersion:"1.0.0", targetVersion:"1.0.1", tag:"latest", owner, runningPackagePath:"/pkg",
      runPnpm:(args:string[],capture=false) => runOwnedPnpm(owner,args,capture,"ignore", ((_bin:unknown,_argv:unknown,options:{cwd:string;env:Record<string,string>}) => {
        spawnCalls++;
        expect(options.env.npm_config_ignore_pnpmfile).toBe("true");
        expect(options.env.pnpm_config_ignore_pnpmfile).toBe("true");
        let status=0,stdout="";
        if(args[0]==="add") {
          mutations.push(options.cwd);
          expect(options.cwd).not.toBe(tmpdir()); expect(options.cwd).not.toBe(PNPM_READ_CWD);
          expect(existsSync(options.cwd+"/pnpm-workspace.yaml")).toBe(true);
          status=fail && addCall++===0 ? 1 : 0;
        } else {
          expect(options.cwd).toBe(PNPM_READ_CWD);
          if(args[0]==="list") stdout=JSON.stringify([{path:"/global",dependencies:{ocx_test:{version:versions[Math.min(listCall++,versions.length-1)],path:"/pkg"}}}]);
        }
        return {status,stdout,stderr:"",pid:1,output:[],signal:null};
      }) as never, () => true), verify:()=>({ok:true}),verifyShims:()=>({ok:true}) });
    expect(result.ok).toBe(!fail); expect(spawnCalls).toBeGreaterThan(1);
    expect(mutations).toHaveLength(fail ? 2 : 1);
    for(const cwd of mutations) expect(existsSync(cwd)).toBe(false);
  });
}

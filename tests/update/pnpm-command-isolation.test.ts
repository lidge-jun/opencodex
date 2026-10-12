import { expect, test } from "bun:test";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { runOwnedPnpm } from "../../src/update/index";
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

const owner = { commandPath: "/trusted/pnpm", packagePath: "/pkg", globalDir: "/global", globalRoot: "/global", globalBinDir: "/bin" };
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
      }) as never), verify:()=>({ok:true}),verifyShims:()=>({ok:true}) });
    expect(result.ok).toBe(!fail); expect(spawnCalls).toBeGreaterThan(1);
    expect(mutations).toHaveLength(fail ? 2 : 1);
    for(const cwd of mutations) expect(existsSync(cwd)).toBe(false);
  });
}

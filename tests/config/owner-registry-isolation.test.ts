import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTempHome } from "../helpers/temp-home";
import { repoPath } from "../helpers/repo-root";
import { spawnTestChild } from "../helpers/spawn-test-child";

const registryModule = pathToFileURL(repoPath("src/config/owner-registry.ts")).href;

describe("owner registry home isolation", () => {
  for (const guarded of [true, false]) {
    test(`${guarded ? "guarded tests isolate" : "production preserves"} the startup-home registry`, async () => {
      const home = createTempHome("ocx-owner-registry-isolation-");
      try {
        const startupHome = home.path("startup");
        const startupRegistry = join(startupHome, ".opencodex", "ocx-homes");
        const foreignHome = home.path("foreign");
        const selectedHome = home.path("selected");
        mkdirSync(startupRegistry, { recursive: true });
        mkdirSync(foreignHome, { recursive: true });
        mkdirSync(selectedHome, { recursive: true });
        writeFileSync(join(foreignHome, "runtime-port.json"), "{}");
        writeFileSync(join(selectedHome, "runtime-port.json"), "{}");
        const key = createHash("sha256").update(foreignHome).digest("hex").slice(0, 24);
        const foreignEntry = join(startupRegistry, key + ".json");
        const foreignBytes = JSON.stringify({ home: foreignHome, v: 1 });
        writeFileSync(foreignEntry, foreignBytes);
        const registryAlias = home.path("registry-alias");
        symlinkSync(startupRegistry, registryAlias, process.platform === "win32" ? "junction" : "dir");
        const child = await spawnTestChild([process.execPath, "-e", `
          import { homedir } from "node:os";
          import { ownerRegistryDir, readOwnerRegistry, registerOwnerRegistryHome,
            unregisterOwnerRegistryHome } from ${JSON.stringify(registryModule)};
          const startupHome = homedir();
          // Windows homedir() follows USERPROFILE changes. Keep production's default
          // home stable; only guarded callers exercise a rewritten worker home.
          if (${guarded}) process.env.HOME = process.env.USERPROFILE = ${JSON.stringify(home.path("worker"))};
          // No preload and no registry override: child callers must still be isolated.
          delete process.env.OCX_OWNER_REGISTRY_DIR;
          const dir = ownerRegistryDir();
          const before = readOwnerRegistry();
          registerOwnerRegistryHome(process.env.OPENCODEX_HOME);
          const written = readOwnerRegistry();
          unregisterOwnerRegistryHome(${JSON.stringify(foreignHome)});
          process.env.OPENCODEX_HOME = ${JSON.stringify(home.path("next"))};
          const next = readOwnerRegistry();
          let refused = 0;
          let unpinnedRefused = false;
          if (${guarded}) {
            for (const dir of ${JSON.stringify([startupRegistry, registryAlias, join(registryAlias, "missing")])}) {
              process.env.OCX_OWNER_REGISTRY_DIR = dir;
              try { readOwnerRegistry(); } catch { refused++; }
              registerOwnerRegistryHome(process.env.OPENCODEX_HOME);
              unregisterOwnerRegistryHome(${JSON.stringify(foreignHome)});
            }
            delete process.env.OCX_OWNER_REGISTRY_DIR;
            // Unpin into the protected home on cached and dynamic homedir() runtimes.
            process.env.HOME = process.env.USERPROFILE = startupHome;
            delete process.env.OPENCODEX_HOME;
            try { readOwnerRegistry(); } catch { unpinnedRefused = true; }
          }
          console.log(JSON.stringify({ startupHome, dir, before, written, next, refused, unpinnedRefused }));
        `], {
          cwd: home.root,
          env: {
            ...process.env,
            HOME: startupHome,
            USERPROFILE: startupHome,
            OCX_REAL_HOME: startupHome,
            OCX_TEST_HOME_GUARD: guarded ? "1" : "0",
            OPENCODEX_HOME: selectedHome,
          },
          deadlineMs: 10_000,
        });
        expect(child.timedOut).toBe(false);
        expect(child.reaped).toBe(true);
        expect(child.pipesClosed).toBe(true);
        expect(child.exitCode, child.stderr).toBe(0);
        const result = JSON.parse(child.stdout.trim());
        expect(result.startupHome).toBe(startupHome);
        expect(result.written.homes).toContain(selectedHome);
        if (guarded) {
          expect(result.dir).toBe(join(selectedHome, "ocx-homes"));
          expect(result.before).toEqual({ homes: [], truncated: false });
          expect(result.written.homes).toEqual([selectedHome]);
          expect(result.next).toEqual({ homes: [], truncated: false });
          expect(result.refused).toBe(3);
          expect(result.unpinnedRefused).toBe(true);
          expect(readdirSync(startupRegistry)).toEqual([key + ".json"]);
          expect(readFileSync(foreignEntry, "utf8")).toBe(foreignBytes);
        } else {
          expect(result.dir).toBe(startupRegistry);
          expect(result.before).toEqual({ homes: [foreignHome], truncated: false });
          expect(result.written.homes).toContain(foreignHome);
          expect(result.next.homes).toEqual([selectedHome]);
          expect(readdirSync(startupRegistry)).toHaveLength(1);
        }
      } finally {
        home.remove();
      }
    }, 20_000);
  }
});

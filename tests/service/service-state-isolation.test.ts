import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTempHome } from "../helpers/temp-home";
import { repoPath } from "../helpers/repo-root";
import { spawnTestChild } from "../helpers/spawn-test-child";

const stateModule = pathToFileURL(repoPath("src/service/state.ts")).href;

describe("service state home isolation", () => {
  for (const guarded of [true, false]) {
    test(`${guarded ? "guarded tests isolate" : "production preserves"} the startup-home mirror`, async () => {
      const home = createTempHome("ocx-service-state-isolation-");
      try {
        const startupHome = home.path("startup");
        const startupState = join(startupHome, ".opencodex", "service-state.json");
        mkdirSync(join(startupHome, ".opencodex"), { recursive: true });
        const foreign = {
          version: 2,
          backend: "scheduler",
          codexHome: home.path("foreign-codex"),
          opencodexHome: home.path("foreign-opencodex"),
        };
        const foreignBytes = JSON.stringify(foreign);
        writeFileSync(startupState, foreignBytes);
        const configHome = home.path("case-a");
        const nextConfigHome = home.path("case-b");
        const child = await spawnTestChild([process.execPath, "-e", `
          import { homedir } from "node:os";
          import { readServiceInstallState, serviceStatePathsForOpenCodexHome,
            writeServiceInstallState } from ${JSON.stringify(stateModule)};
          const startupHome = homedir();
          // Windows homedir() follows USERPROFILE changes. Keep production's default
          // home stable; only guarded callers exercise a rewritten worker home.
          if (${guarded}) process.env.HOME = process.env.USERPROFILE = ${JSON.stringify(home.path("worker"))};
          const before = readServiceInstallState();
          const pinned = serviceStatePathsForOpenCodexHome(${JSON.stringify(nextConfigHome)});
          writeServiceInstallState("scheduler", null);
          const written = readServiceInstallState();
          process.env.OPENCODEX_HOME = ${JSON.stringify(nextConfigHome)};
          const next = readServiceInstallState();
          console.log(JSON.stringify({ startupHome, before, pinned, written, next }));
        `], {
          cwd: home.root,
          env: {
            ...process.env,
            HOME: startupHome,
            USERPROFILE: startupHome,
            // The wrapper protects the true developer home, not its own sandbox.
            OCX_REAL_HOME: home.path("protected-real-home"),
            OCX_TEST_HOME_GUARD: guarded ? "1" : "0",
            OPENCODEX_HOME: configHome,
            CODEX_HOME: home.codexHome,
          },
          deadlineMs: 10_000,
        });
        expect(child.timedOut).toBe(false);
        expect(child.reaped).toBe(true);
        expect(child.pipesClosed).toBe(true);
        expect(child.exitCode, child.stderr).toBe(0);
        const result = JSON.parse(child.stdout.trim());
        expect(result.startupHome).toBe(startupHome);
        expect(result.written.opencodexHome).toBe(configHome);
        expect(result.written.codexHome).toBe(home.codexHome);
        if (guarded) {
          expect(result.before).toBeNull();
          expect(result.pinned).toEqual([join(nextConfigHome, "service-state.json")]);
          expect(result.next).toBeNull();
          expect(readFileSync(startupState, "utf8")).toBe(foreignBytes);
        } else {
          expect(result.before).toEqual(foreign);
          expect(result.pinned).toEqual([join(nextConfigHome, "service-state.json"), startupState]);
          expect(result.next).toEqual(result.written);
          expect(JSON.parse(readFileSync(startupState, "utf8"))).toEqual(result.written);
        }
      } finally {
        home.remove();
      }
    }, 20_000);
  }
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cliSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");
const helpSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "help.ts"), "utf8");

describe("ocx restore back", () => {
  test("restore/eject accept `back` to re-point codex at the RUNNING proxy only", () => {
    const restoreCase = cliSource.slice(cliSource.indexOf('case "restore":'), cliSource.indexOf('case "recover-history":'));

    // The reverse switch must be liveness-gated (never inject a dead port) and reuse the
    // same inject path as `ocx start` — no parallel injector.
    expect(restoreCase).toContain('if (args[1] === "back")');
    expect(restoreCase).toContain("await findLiveProxy()");
    expect(restoreCase).toContain("await syncModelsToCodex(live.port)");
    expect(restoreCase.indexOf("findLiveProxy()")).toBeLessThan(restoreCase.indexOf("syncModelsToCodex(live.port)"));
    // The forward switch (plain `ocx restore`) is unchanged.
    expect(restoreCase).toContain("restoreNativeCodex()");
  });

  test("help documents both directions of the switch", () => {
    expect(helpSource).toContain("ocx restore [back]");
    expect(helpSource).toContain("ocx eject [back]");
    expect(helpSource).toContain("ocx restore back");
  });
});

import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../helpers/repo-root";

// Moved byte for byte from ci-workflows.test.ts to keep that file under its size cap.
const root = pathToFileURL(repoRoot() + "/");

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("gui exhaustive-deps suppression stays scoped and effective", () => {
  // `bun run doctor:gui` exited 1 on dev for one deliberate exception at
  // gui/src/pages/Models.tsx, blocking explicit comprehensive validation.
  // Two config edits fixed it, and each has a
  // failure mode that is silent rather than loud, which is what these assertions cover.

  test("the oxlint override carries its own react plugin, or it resolves to nothing", async () => {
    const oxlintrc = JSON.parse(await readText("gui/.oxlintrc.json")) as {
      overrides?: Array<{ files?: string[]; rules?: Record<string, unknown>; plugins?: string[] }>;
    };
    const overrides = oxlintrc.overrides ?? [];
    const scoped = overrides.filter(entry => (entry.files ?? []).includes("src/pages/Models.tsx"));

    expect(scoped).toHaveLength(1);
    const override = scoped[0]!;

    // Rule id must match the style the rest of this config uses ("react/..."). The
    // eslint-style "react-hooks/..." id silently matches nothing here.
    expect(override.rules?.["react/exhaustive-deps"]).toBe("off");
    expect(override.rules).not.toHaveProperty("react-hooks/exhaustive-deps");

    // Without a per-override plugins key the override is inert: the rule stays on and
    // the warning comes back. This is the assertion that catches a well-meaning cleanup
    // that deletes a key looking redundant next to the top-level plugin list.
    expect(override.plugins).toContain("react");

    // Narrow by construction: the override turns off exactly one rule. rules-of-hooks and
    // react-compiler must keep firing in that file, and a probe confirmed they do.
    expect(Object.keys(override.rules ?? {})).toEqual(["react/exhaustive-deps"]);
  });

  test("react-doctor scopes the ignore to one file instead of going blind everywhere", async () => {
    const config = JSON.parse(await readText("gui/doctor.config.json")) as {
      blocking?: string;
      ignore?: { overrides?: Array<{ files?: string[]; rules?: string[] }> };
      rules?: Record<string, unknown>;
    };

    // A global rules entry was tried first and rejected: it silenced the rule repo-wide,
    // proven by injecting a missing-dep violation into Startup.tsx and watching doctor
    // report "No issues". ignore.overrides keeps that violation failing.
    expect(config.rules).not.toHaveProperty("react-doctor/exhaustive-deps");
    expect(config.rules).not.toHaveProperty("react-hooks/exhaustive-deps");

    const overrides = config.ignore?.overrides ?? [];
    const scoped = overrides.filter(entry => (entry.files ?? []).includes("src/pages/Models.tsx"));
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.rules).toContain("react-hooks/exhaustive-deps");

    // Every ignore override must name at least one file. An empty or missing files list
    // would apply the ignore to the whole scan, which is the failure this pair guards.
    for (const entry of overrides) {
      expect((entry.files ?? []).length).toBeGreaterThan(0);
      expect((entry.rules ?? []).length).toBeGreaterThan(0);
    }

    // blocking must stay at warning; flipping it to error would hide the next finding
    // instead of this one. scripts/doctor-gui-if-changed.ts documents that contract.
    expect(config.blocking).toBe("warning");
  });

  test("the effect keeps the in-file record of why the dep array stays short", async () => {
    const models = await readText("gui/src/pages/Models.tsx");
    const effectEnd = models.indexOf("}, [catalogActive, loadShadowCall, loadV2]);");
    expect(effectEnd).toBeGreaterThan(-1);

    // The reasoning has to sit on the effect, not in a commit message. Read the comment
    // block immediately above the dep array rather than the whole file, or this passes on
    // any incidental mention elsewhere.
    const preceding = models.slice(0, effectEnd).split(/\r?\n/).slice(-8).join("\n");
    expect(preceding).toContain("PreserveManualMemo");
    expect(preceding).toContain("five react-compiler");

    // Both suppressions are config-side, so the note must point at the two files a reader
    // would otherwise have to find by grep.
    expect(preceding).toContain("gui/.oxlintrc.json");
    expect(preceding).toContain("gui/doctor.config.json");

    // An in-file react-doctor disable was tried and removed: doctor passes without it, and
    // react/react-compiler penalises a component merely for carrying suppressions. If one
    // reappears, the config route has been misunderstood.
    expect(models).not.toContain("react-doctor-disable-next-line");
  });
});

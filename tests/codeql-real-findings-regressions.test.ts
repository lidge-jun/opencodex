import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTomlDocument } from "../src/codex/project-config-warnings";

const issueQuality = require("../.github/scripts/issue-quality.cjs") as {
  clean: (value: unknown) => string;
};
const prQuality = require("../.github/scripts/pr-quality.cjs") as {
  assessPrDescription: (body: string) => { ok: boolean; reason?: string };
  hasScreenshotEvidence: (body: string) => boolean;
};

describe("validated CodeQL regressions", () => {
  test("unterminated HTML comments stay non-rendered through EOF", () => {
    const hiddenScreenshot = "<!--\n![proof](https://example.invalid/screenshot.png)";
    expect(prQuality.hasScreenshotEvidence(hiddenScreenshot)).toBe(false);
    expect(prQuality.assessPrDescription(hiddenScreenshot)).toEqual({ ok: false, reason: "empty" });
    expect(issueQuality.clean("<!--\nhidden issue text")).toBe("");

    expect(issueQuality.clean("<!-- hidden -->\nVisible text")).toBe("Visible text");
  });

  test("malformed TOML basic strings are ignored while escaped strings still parse", () => {
    const malformed = parseTomlDocument('model_provider = "' + "\\".repeat(64));
    expect(malformed.root.model_provider).toBeUndefined();

    const valid = parseTomlDocument('model_provider = "provider\\\\name"');
    expect(valid.root.model_provider).toBe("provider\\name");
  });

  test("TOML string matchers do not let backslash enter both repetition arms", () => {
    const unsafe = '"(?:\\\\.|[^"])*"';
    const safe = '"(?:\\\\.|[^"\\\\])*"';
    const files = [
      "src/codex/project-config-warnings.ts",
      "src/codex/inject.ts",
      "src/codex/plugins-doctor.ts",
    ];

    for (const path of files) {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      expect(source).not.toContain(unsafe);
      expect(source).toContain(safe);
    }
  });
});

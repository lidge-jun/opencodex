import { expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";

const locales = ["", "fr/", "ja/", "ko/", "ru/", "tr/", "zh-cn/", "zh-tw/"] as const;

test("each integration guide explains GJC reasoning export", async () => {
  for (const locale of locales) {
    const path = `docs-site/src/content/docs/${locale}guides/integrations.md`;
    const guide = await Bun.file(repoPath(path)).text();
    const gjcSection = guide.split(/\n\s*\n/).find(paragraph =>
      paragraph.includes("GJC") && paragraph.includes("compat.supportsReasoningEffort"));
    expect(gjcSection, `${path} must explain the GJC effort controls`).toBeDefined();
    expect(gjcSection).toContain("thinking.levels");
    expect(gjcSection).toContain("none");
    expect(gjcSection).toContain("ultra");
  }
});

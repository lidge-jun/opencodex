import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
const fontStack = css.replace(/\/\*[\s\S]*?\*\//g, "")
  .match(/--font-ui\s*:\s*([^;]+);/)?.[1];
if (!fontStack) throw new Error("The UI font stack is missing.");
const families = fontStack.split(",").map(family =>
  family.trim().replace(/^(["'])(.*)\1$/, "$2"),
);

// Keep system fonts ahead of Apple SD Gothic Neo, which also covers Latin.
// This guards fallback order; actual glyph selection requires a browser check.
test.each(["system-ui", "-apple-system", "BlinkMacSystemFont"])(
  "%s precedes Apple SD Gothic Neo in the UI font stack",
  systemFont => {
    const systemIndex = families.indexOf(systemFont);
    const koreanIndex = families.indexOf("Apple SD Gothic Neo");
    expect(systemIndex).toBeGreaterThanOrEqual(0);
    expect(koreanIndex).toBeGreaterThanOrEqual(0);
    expect(systemIndex).toBeLessThan(koreanIndex);
  },
);

import { expect, test } from "bun:test";
import { effectiveDeclaration, withoutComments } from "./helpers/css-declarations";

test("Usage table scrollports contain absolutely positioned accessible captions", async () => {
  const css = withoutComments(await Bun.file(new URL("../src/styles-usage-workspace.css", import.meta.url)).text());
  // Source contract only: happy-dom cannot measure overflow. The rendered
  // regression in usage-scroll-browser.ts proves the blank-scroll failure.
  expect(effectiveDeclaration(css, ".usw-section .tbl-wrap", "position")).toBe("relative");
  expect(effectiveDeclaration(css, ".usw-section .tbl-wrap", "overflow-y")).toBe("auto");
});

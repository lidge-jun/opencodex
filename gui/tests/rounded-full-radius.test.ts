import { expect, test } from "bun:test";
import { compile } from "@tailwindcss/node";
import { fileURLToPath } from "node:url";

/*
 * rounded-full must build to a finite radius. Tailwind's default, calc(infinity * 1px),
 * serializes to 2147483647px, which macOS WKWebView can paint as square corners (#8281).
 * Compiling the real theme catches a regression in the token or in its @theme block.
 */
test("the compiled theme builds rounded-full to a finite pill radius", async () => {
  const base = fileURLToPath(new URL("../src/design/", import.meta.url));
  const source = await Bun.file(new URL("../src/design/theme.css", import.meta.url)).text();
  const compiler = await compile(source, { base, onDependency: () => {} });
  const css = compiler.build(["rounded-full"]);
  const rule = css.match(/\.rounded-full\s*\{[^}]*\}/)?.[0];
  expect(rule).toBeDefined();
  expect(rule).toContain("border-radius: 9999px");
  expect(css).not.toContain("2147483647px");
  expect(css).not.toContain("infinity");
});

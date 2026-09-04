import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type FC, type SVGProps } from "react";
import * as icons from "../src/icons";

/**
 * The codex-set nav row wears the Codex mark.
 *
 * Deliberately not in `sidebar-codex-set.test.ts`: that file's subject is the row
 * surviving the removed viewMode filter, and it dropped its own `Icon: IconKey`
 * pin for failing on a change it was never written to catch. This file's subject
 * IS the glyph, so it is supposed to fail when the glyph changes.
 *
 * It still does not pin the symbol NAME. A rename is not a regression; wearing a
 * key again is. The name is read from the row only to resolve the component, and
 * every assertion lands on rendered geometry.
 */
function iconNameForNavRow(src: string, id: string): string {
  // Comments naming the icon are prose, not evidence: icons.tsx carries a long
  // block comment naming this mark, and App.tsx has comment prose inside <nav>.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const at = code.indexOf("const NAV: NavEntry[] = [");
  expect(at, "NAV table not found in App.tsx").toBeGreaterThan(-1);
  const nav = code.slice(at, code.indexOf("];", at));
  const row = nav.match(new RegExp(`\\{[^{}]*id: "${id}"[^{}]*\\}`));
  expect(row, `NAV has no ${id} row`).not.toBeNull();
  const name = row![0].match(/Icon:\s*(\w+)/);
  expect(name, `the ${id} row declares no Icon`).not.toBeNull();
  return name![1]!;
}

test("the codex-set nav row renders the upstream Codex mark, under any symbol name", async () => {
  const src = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const name = iconNameForNavRow(src, "codex-set");

  const Icon = (icons as Record<string, FC<SVGProps<SVGSVGElement>> | undefined>)[name];
  expect(Icon, `App.tsx points codex-set at ${name}, which icons.tsx does not export`)
    .toBeTypeOf("function");

  const svg = renderToStaticMarkup(createElement(Icon!));
  // Attribute order and source formatting are not the subject; the drawn path is.
  const d = (svg.match(/\sd="[^"]*"/g) ?? []).join(" ").replace(/\s+/g, " ");

  /*
   * Provenance, by the numbers only the openai/codex `svg.codex-mark` carries: a
   * ring of r=14.758 about (16,16) on a 32-unit box, enclosing a `>` and a `_`.
   * Asserted as tokens rather than as the whole `d` string, so a reflow or a
   * decimal-preserving reformat does not fail it while a redraw does.
   */
  expect(svg).toContain('viewBox="0 0 32 32"');
  expect(d).toContain("30.758 16");             // ring, rightmost point
  expect(d).toContain("14.758");                // ring radius
  expect(d).toContain("16 1.242");              // ring, top
  expect(d).toContain("22.356 19.797H17.17");   // the underscore
  expect(d).toContain("9.662 12.29");           // the chevron

  /*
   * The reversion this is really guarding: folding the mark back through `S()`,
   * which hardcodes a 24-unit box and stroke 2. That rescales a path drawn for 32
   * units and still renders something icon-shaped, so review does not catch it.
   * `stroke-width="2.484"` does not contain `stroke-width="2"`, hence the
   * negative assertions rather than only the positive ones.
   */
  expect(svg).toContain('stroke-width="2.484"');
  expect(svg).toContain('stroke="currentColor"');
  expect(svg).toContain('fill="none"');
  expect(svg).not.toContain('viewBox="0 0 24 24"');
  expect(svg).not.toContain('stroke-width="2"');
  expect((svg.match(/<path/g) ?? []).length).toBe(1);
});

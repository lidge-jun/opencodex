import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_MARKS } from "../src/components/apikeys-workspace/client-config-clients";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

/*
 * A mark that 404s renders as a broken image, which is worse than the monogram
 * it replaced. CLIENT_MARKS is a plain string map, so nothing else checks that
 * the file it names was actually committed.
 */
test("every client mark names a file that exists", () => {
  const missing = Object.entries(CLIENT_MARKS)
    .filter(([, src]) => !existsSync(join(PUBLIC_DIR, src!.replace(/^\//, ""))));
  expect(missing).toEqual([]);
});

/*
 * The Hermes favicon was rejected for exactly this: it passed an SVG parse and a
 * render probe while being a single <text> glyph with no path data, so it draws
 * differently per machine and blank where the font lacks the character. A mark
 * has to carry geometry.
 */
test("every client mark is drawn geometry, not text or an embedded raster", () => {
  for (const [clientId, src] of Object.entries(CLIENT_MARKS)) {
    const body = readFileSync(join(PUBLIC_DIR, src!.replace(/^\//, "")), "utf8");
    expect(body, `${clientId} mark should not render text`).not.toMatch(/<text[\s>]/);
    expect(body, `${clientId} mark should not embed a raster`).not.toMatch(/<image[\s>]/);
    expect(body, `${clientId} mark should carry vector geometry`)
      .toMatch(/<(path|circle|rect|polygon|ellipse|line|polyline)[\s>]/);
  }
});

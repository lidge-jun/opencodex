import { expect, test } from "bun:test";

/*
 * The classic dashboard (gui/classic, served at /classic/) and the switch between it and the
 * current one. These read the wiring the build and the first paint depend on.
 */
const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test("a remembered classic choice forwards before first paint, except for the tray popover", async () => {
  const html = await read("../index.html");
  expect(html).toContain('edition = localStorage.getItem("ocx-ui");');
  expect(html).toContain('edition === "classic"');
  expect(html).toContain('location.hash.indexOf("#/tray") !== 0');
  expect(html).toContain('location.replace("/classic/" + location.search + location.hash)');
});

test("both dashboards carry a switch to the other one", async () => {
  const edition = await read("../src/lib/dashboard-edition.ts");
  expect(edition).toContain('export const DASHBOARD_EDITION_KEY = "ocx-ui";');
  expect(edition).toContain('edition === "classic" ? "/classic/" : "/"');
  const app = await read("../src/App.tsx");
  expect(app).toContain('switchDashboardEdition("classic")');
  expect(app).toContain('aria-label={t("shellV2.uiClassic")}');
  const classicApp = await read("../classic/src/App.tsx");
  expect(classicApp).toContain('switchDashboardEdition("current")');
  expect(classicApp).toContain('import { switchDashboardEdition } from "./lib/dashboard-edition";');
});

test("the classic build is part of the dashboard build and lands under dist/classic", async () => {
  const pkg = JSON.parse(await read("../package.json")) as { scripts: Record<string, string> };
  expect(pkg.scripts.build).toContain("vite build -c vite.classic.config.ts");
  const config = await read("../vite.classic.config.ts");
  expect(config).toContain("base: '/classic/'");
  expect(config).toContain("outDir: join(GUI, 'dist', 'classic')");
});

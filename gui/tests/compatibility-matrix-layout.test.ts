import { expect, test } from "bun:test";

async function readSources(): Promise<string> {
  const models = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
  const routing = await Bun.file(new URL("../src/app-routing.ts", import.meta.url)).text();
  const tabs = await Bun.file(new URL("../src/pages/models-tab.ts", import.meta.url)).text();
  const page = await Bun.file(new URL("../src/pages/CompatibilityMatrix.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  const styles = await Bun.file(new URL("../src/styles-compatibility-matrix.css", import.meta.url)).text();
  return `${models}\n${routing}\n${tabs}\n${page}\n${css}\n${styles}`;
}

test("Compatibility Lab is mounted as the Models Compatibility tab", async () => {
  const src = await readSources();
  expect(src).toContain('"models/compatibility"');
  expect(src).toContain('modelsPanelDomId("compatibility")');
  expect(src).toContain('<CompatibilityMatrix apiBase={apiBase} active={tab === "compatibility"} onCountChange={setCompatibilityCount} />');
  expect(src).toContain('@import "./styles-compatibility-matrix.css"');
  expect(src).toContain("lab-matrix");
  expect(src).toContain("lab-verdict-badge");
});

test("Compatibility matrix uses scrollable table layout", async () => {
  const styles = await Bun.file(new URL("../src/styles-compatibility-matrix.css", import.meta.url)).text();
  expect(styles).toContain(".lab-matrix-scroll");
  expect(styles).toContain(".lab-matrix");
  expect(styles).toContain(".lab-detail-table");
  for (const removedToken of ["--radius-md", "--text-xs", "--text-sm", "--font-mono", "--surface-1", "--surface-2", "--text-muted"]) {
    expect(styles).not.toContain(`var(${removedToken})`);
  }
});

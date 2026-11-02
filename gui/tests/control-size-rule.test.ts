import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

/*
 * Control sizes (design-system/foundations.md, "Control sizes"): every button, field, select
 * and segmented track is 34px (md) or 28px (sm), and a small button that shares a row with a
 * field or select grows to md. v1 sized controls by padding, so a 31.5px select sat next to a
 * 26px button. These checks keep the tokens and the rules that apply them from drifting.
 */
const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test("the two control heights are tokens, and v1's control tokens follow them", async () => {
  const theme = await read("../src/design/theme.css");
  expect(theme).toContain("--ocx-control-h: 34px;");
  expect(theme).toContain("--ocx-control-h-sm: 28px;");
  const bridge = await read("../src/design/bridge.css");
  expect(bridge).toContain(":root { --control-md: var(--ocx-control-h); --control-sm: var(--ocx-control-h-sm); }");
});

test("v1 buttons, fields and selects take a control height, and neighbours pair up", async () => {
  const bridge = await read("../src/design/bridge.css");
  expect(bridge).toContain(".btn { min-height: var(--ocx-control-h); padding-block: 0; }");
  expect(bridge).toContain(".btn.btn-sm { min-height: var(--ocx-control-h-sm); }");
  expect(bridge).toContain(":is(.select-trigger, .input:not(textarea)):not(.lang-toggle *) { min-height: var(--ocx-control-h); padding-block: 0; }");
  expect(bridge).toMatch(/:has\(> :is\(\.custom-select, \.input, select, [^)]*\)\)\)? > \.btn\.btn-sm \{\s*min-height: var\(--ocx-control-h\);/);
});

test("v2 Button and SegmentedControl size from the tokens, not from h-7/h-8/h-9", async () => {
  const button = await read("../src/components/ui-v2/button.tsx");
  expect(button).toContain('sm: "h-[var(--ocx-row-control-h,var(--ocx-control-h-sm))]');
  // ...and the bridge feeds that row height to the children of any row holding a field.
  const bridge = await read("../src/design/bridge.css");
  expect(bridge).toContain("@property --ocx-row-control-h { syntax: \"*\"; inherits: false; }");
  expect(button).toContain('md: "h-[var(--ocx-control-h)]');
  expect(button).not.toMatch(/\bh-(7|8|9)\b/);
  // The app's Select (ui.tsx) has a compact size too; it is the sm token, not a third height.
  const ui = await read("../src/ui.tsx");
  expect(ui).toContain('size === "sm" && "h-[var(--ocx-control-h-sm)]');
  expect(ui).not.toMatch(/size === "sm" && "h-(7|8|9)/);
  const segmented = await read("../src/components/ui-v2/segmented-control.tsx");
  expect(segmented).toContain("h-[calc(var(--ocx-control-h)-4px)]");
  expect(segmented).toContain("h-[calc(var(--ocx-control-h-sm)-4px)]");
});

test("v2 code sizes its buttons and fields from the tokens, never h-7/h-8/h-9", async () => {
  // A class string that makes something clickable or typeable (cursor-pointer, an input or a
  // select class) must not carry a Tailwind fixed height of its own: that is how a 28px chip,
  // a 32px toolbar button and a 36px field ended up side by side.
  const roots = ["src/components/ui-v2", "src/components/v2-accounts", "src/components/v2-logs",
    "src/components/v2-models", "src/components/v2-subagents", "src/components/v2-usage",
    "src/components/v2-connect", "src/components/v2-startup", "src/components/v2-proxy"];
  const offenders: string[] = [];
  let scanned = 0;
  for (const root of roots) {
    // A page folder that has not landed yet is simply skipped.
    if (!existsSync(new URL(`../${root}`, import.meta.url))) continue;
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(new URL(`../${root}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
      scanned++;
      const src = await Bun.file(new URL(`../${root}/${file.split(String.fromCharCode(92)).join("/")}`, import.meta.url)).text();
      for (const m of src.matchAll(/(["'`])([^"'`\n]*)\1/g)) {
        const cls = m[2]!;
        if (/\bh-(7|8|9)\b/.test(cls) && /\bcursor-pointer\b|\binput\b|\bselect-sm\b/.test(cls)) {
          offenders.push(`${root}/${file}:${src.slice(0, m.index).split("\n").length}`);
        }
      }
    }
  }
  // The scan has to reach the v2 components, or it would pass vacuously.
  expect(scanned).toBeGreaterThan(20);
  expect(offenders).toEqual([]);
});

import { expect, test } from "bun:test";

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
  expect(button).toContain('sm: "h-[var(--ocx-control-h-sm)]');
  expect(button).toContain('md: "h-[var(--ocx-control-h)]');
  expect(button).not.toMatch(/\bh-(7|8|9)\b/);
  const segmented = await read("../src/components/ui-v2/segmented-control.tsx");
  expect(segmented).toContain("h-[calc(var(--ocx-control-h)-4px)]");
  expect(segmented).toContain("h-[calc(var(--ocx-control-h-sm)-4px)]");
});

import { expect, test } from "bun:test";

const modelsSource = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
const workspaceCss = await Bun.file(new URL("../src/styles-models-workspace.css", import.meta.url)).text();

/**
 * "Keep ChatGPT on v1" qualifies the selected Sub-agent surface, so it has to
 * render under the v1/base/v2 chips in the right-hand column of the controls
 * grid. Reusing `.models-v2-mode-row` put it in the left (Shadow Call) column
 * instead, where it read as an unrelated floating switch.
 */
test("keep-native-v1 switch renders in its own right-column row, not a second mode row", () => {
  const block = modelsSource.slice(modelsSource.indexOf('v2.multiAgentMode === "v2"'));
  const row = block.slice(0, block.indexOf("</div>\n          </div>") + 1);

  expect(row).toContain("models-v2-keep-native-row");
  expect(row).toContain("models.keepNativeOnV1");
  // The old markup reused the mode row and hard-coded an inline offset.
  expect(row).not.toContain('className="models-v2-mode-row row" style={{ marginTop: 8 }}');
});

test("keep-native-v1 row is pinned to the Sub-agent column and right-aligned", () => {
  const rule = workspaceCss.slice(workspaceCss.indexOf(".models-v2-keep-native-row {"));
  const body = rule.slice(0, rule.indexOf("}"));

  expect(body).toContain("grid-column: 2");
  expect(body).toContain("justify-self: end");
});

test("keep-native-v1 row falls back to the single-column stack under 1160px", () => {
  const narrow = workspaceCss.slice(workspaceCss.indexOf("@media (max-width: 1160px)"));
  const scoped = narrow.slice(0, narrow.indexOf("@container"));

  expect(scoped).toContain(".models-v2-keep-native-row");
  expect(scoped).toContain("grid-column: 1");
  expect(scoped).toContain("justify-self: start");
});

/**
 * `Tooltip` renders a <button>, so wrapping the Switch in it nested a button
 * inside a button and collapsed the accessibility tree for the control.
 */
test("the help affordance wraps only the info icon, never the switch", () => {
  const block = modelsSource.slice(modelsSource.indexOf("models-v2-keep-native-row"));
  const row = block.slice(0, block.indexOf("</div>\n          </div>") + 1);
  const tooltipAt = row.indexOf("<Tooltip");
  const switchAt = row.indexOf("<Switch");

  expect(tooltipAt).toBeGreaterThan(-1);
  expect(switchAt).toBeGreaterThan(-1);
  expect(switchAt).toBeLessThan(tooltipAt);
  expect(row).toContain("models-v2-keep-native-info");
});

/**
 * `loadV2()` returns early while `v2BusyRef` is held, so refetching from inside
 * an in-flight write left the control showing its old value until the next 10s
 * poll. The keep-native row only renders while the mode is v2, so a stale mode
 * also delayed the row from appearing at all.
 */
test("v2 setting writes adopt the response instead of a no-op refetch", () => {
  const helperAt = modelsSource.indexOf("const putV2Setting = async");
  expect(helperAt).toBeGreaterThan(-1);

  const helper = modelsSource.slice(helperAt, modelsSource.indexOf("const setMultiAgentMode"));
  expect(helper).toContain("setV2({");
  expect(helper).toContain("keepNativeChatGptOnV1: data.keepNativeChatGptOnV1 === true");
  expect(helper).not.toContain("void loadV2()");
});

test("both v2 surface setters route through the shared writer", () => {
  const setters = modelsSource.slice(
    modelsSource.indexOf("const setMultiAgentMode"),
    modelsSource.indexOf("const putV2Threads"),
  );

  expect(setters).toContain("putV2Setting({ multiAgentMode: mode })");
  expect(setters).toContain("putV2Setting({ keepNativeChatGptOnV1: next })");
  expect(setters).not.toContain("void loadV2()");
});

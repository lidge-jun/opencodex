import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import { SmallFastModelSetting } from "../src/pages/ClaudeCode";
import { backgroundHelperOptions } from "../src/pages/claude-code-helper-options";
import { modelLabel } from "../src/model-display";

let originalLanguageDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  originalLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  if (originalLanguageDescriptor) {
    Object.defineProperty(globalThis.navigator, "language", originalLanguageDescriptor);
  } else {
    delete (globalThis.navigator as { language?: string }).language;
  }
});

const options = [
  { value: "", label: "Let Claude Code choose (native model)" },
  { value: "gemini/gemini-3-flash", label: "gemini/gemini-3-flash" },
];

function renderSetting(value: string, tierHaikuModel?: string): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <SmallFastModelSetting
        value={value}
        tierHaikuModel={tierHaikuModel}
        options={options}
        onChange={() => {}}
      />
    </LanguageProvider>,
  );
}

test("unset background helper explains native selection and Sonnet cost", () => {
  const html = renderSetting("");
  expect(html).toContain("Let Claude Code choose (native model)");
  expect(html).toContain("background work such as chat summaries and topic detection");
  expect(html).toContain("native Sonnet model");
  expect(html).toContain("may incur charges from your native provider");
  expect(html).toContain('role="status"');
});

test("tier Haiku override is the effective helper and hides the native warning", () => {
  const html = renderSetting("", "mock/tier-haiku");
  expect(html).toContain("Let Claude Code choose (native model)");
  expect(html).toContain("background work such as chat summaries and topic detection");
  expect(html).not.toContain("native Sonnet model");
  expect(html).not.toContain('role="status"');
});

test("selected background helper keeps the neutral description and hides the native warning", () => {
  const html = renderSetting("gemini/gemini-3-flash");
  expect(html).toContain("gemini/gemini-3-flash");
  expect(html).toContain("background work such as chat summaries and topic detection");
  expect(html).not.toContain("native Sonnet model");
  expect(html).not.toContain('role="status"');
});

// #668: the picker built its options with `String(modelLabel(m))`. modelLabel()
// returns a ReactNode for icon-bearing slugs, so String() collapsed those to
// "[object Object]". These render the options the page actually builds, so
// reintroducing String() fails here rather than only on screen.
test("icon-bearing models render their name, never [object Object] (#668)", () => {
  const slugs = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
  // The closed picker renders only the SELECTED option, so assert per slug.
  for (const slug of slugs) {
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <SmallFastModelSetting
          value={slug}
          options={backgroundHelperOptions(slugs, "Let Claude Code choose (native model)")}
          onChange={() => {}}
        />
      </LanguageProvider>,
    );
    expect(html).not.toContain("[object Object]");
    expect(html).toContain(slug);
    expect(html).toContain("<svg");
  }
});

test("background helper options keep icon labels as nodes and lead with the unset entry (#668)", () => {
  const options = backgroundHelperOptions(["gpt-5.6-sol", "gemini/gemini-3-flash"], "unset");
  expect(options[0]).toEqual({ value: "", label: "unset" });
  // A plain slug stays a string; an icon-bearing slug must stay a node.
  expect(options[2]!.label).toBe("gemini/gemini-3-flash");
  expect(typeof options[1]!.label).toBe("object");
  expect(String(options[1]!.label)).toBe("[object Object]"); // why String() was wrong
});

test("background helper options tolerate an absent model list (#668)", () => {
  expect(backgroundHelperOptions(undefined, "unset")).toEqual([{ value: "", label: "unset" }]);
});

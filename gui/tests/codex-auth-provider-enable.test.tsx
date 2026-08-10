import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import { OpenAiAccountModeBanner } from "../src/pages/CodexAuth";

let previousLanguageDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  if (previousLanguageDescriptor) {
    Object.defineProperty(globalThis.navigator, "language", previousLanguageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis.navigator, "language");
  }
});

test("missing OpenAI provider offers an in-place enable action", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <OpenAiAccountModeBanner state="absent" busy={false} onEnable={() => undefined} />
    </LanguageProvider>,
  );

  expect(html).toContain("Your OpenAI accounts are still available");
  expect(html).toContain("Enable OpenAI");
  expect(html).not.toContain('href="#providers"');
});

test("disabled and busy OpenAI provider states keep the recovery action clear", () => {
  const disabledHtml = renderToStaticMarkup(
    <LanguageProvider>
      <OpenAiAccountModeBanner state="disabled" busy={false} onEnable={() => undefined} />
    </LanguageProvider>,
  );
  const busyHtml = renderToStaticMarkup(
    <LanguageProvider>
      <OpenAiAccountModeBanner state="disabled" busy={true} onEnable={() => undefined} />
    </LanguageProvider>,
  );

  expect(disabledHtml).toContain("Your OpenAI accounts are still available");
  expect(disabledHtml).toContain("Enable OpenAI");
  expect(busyHtml).toContain("Enabling...");
  expect(busyHtml).toContain("disabled=\"\"");
});

test("noncanonical disabled OpenAI rows do not offer built-in recovery", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <OpenAiAccountModeBanner state="invalid" busy={false} onEnable={() => undefined} />
    </LanguageProvider>,
  );

  expect(html).toContain("The built-in OpenAI provider is not configured.");
  expect(html).toContain('class="link-btn"');
  expect(html).toContain("Open Providers");
  expect(html).not.toContain("Enable OpenAI");
  expect(html).not.toContain("Your OpenAI accounts are still available");
});

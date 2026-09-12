import { expect, test } from "bun:test";

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

test("account more-actions uses the compact dashboard popover language", async () => {
  const css = await Bun.file(new URL("../src/styles-codex-set.css", import.meta.url)).text();
  const wrapper = ruleBody(css, "details.codex-account-more");
  const layout = ruleBody(css, "details.codex-account-more > .codex-account-more-body");
  const visual = ruleBody(css, ".codex-account-more .codex-account-more-body");

  expect(wrapper).toMatch(/position:\s*relative/);
  expect(wrapper).toMatch(/display:\s*inline-block/);
  expect(layout).toMatch(/position:\s*absolute/);
  expect(layout).toMatch(/top:\s*calc\(100% \+ 6px\)/);
  expect(layout).toMatch(/right:\s*0/);
  expect(layout).toMatch(/flex-basis:\s*auto/);

  expect(visual).toMatch(/z-index:\s*var\(--z-popover\)/);
  expect(visual).toMatch(/min-width:\s*min\(16rem, calc\(100vw - 2rem\)\)/);
  expect(visual).toMatch(/max-width:\s*min\(22rem, calc\(100vw - 2rem\)\)/);
  expect(visual).toMatch(/background:\s*var\(--raised\)/);
  expect(visual).toMatch(/border-radius:\s*var\(--radius\)/);
  expect(visual).toMatch(/box-shadow:\s*0 4px 24px rgb\(0 0 0 \/ 0\.14\)/);
  expect(visual).toMatch(/justify-content:\s*flex-start/);
});

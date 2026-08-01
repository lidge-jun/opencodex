import { expect, test } from "bun:test";
import { resolveAppHashChange } from "../src/app-routing";

/**
 * Account management belongs to Providers: that workspace handles OAuth account
 * sets and API-key pools for every provider and embeds the special OpenAI pool.
 * Keep the old hash as a passive compatibility redirect for bookmarks.
 */

test("the sidebar exposes one provider-independent account destination", async () => {
  const src = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

  expect(src).toContain('{ id: "providers", tkey: "nav.providers", Icon: IconServer }');
  expect(src).not.toContain('{ id: "codex-auth"');
  expect(src).not.toContain('page === "codex-auth"');
});

test("legacy Codex Auth links redirect to all-provider account management", () => {
  expect(resolveAppHashChange("codex-auth")).toEqual({
    page: "providers",
    replaceTo: "providers",
  });
  expect(resolveAppHashChange("codex-auth/accounts")).toEqual({
    page: "providers",
    replaceTo: "providers",
  });
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { providerIconSrc } from "../src/provider-icons";
import { poolSettingsRequestBody } from "../src/pool-settings";

test("Pool 2 retains the Claude shape with a distinct green mark", () => {
  const root = join(import.meta.dir, "..", "public", "provider-icons");
  const primary = readFileSync(join(root, "claude-color.svg"), "utf8");
  const secondary = readFileSync(join(root, "claude-green.svg"), "utf8");
  expect(secondary.match(/ d="([^"]+)"/)?.[1]).toBe(primary.match(/ d="([^"]+)"/)?.[1]);
  expect(secondary).toContain('fill="#0a7d5c"');
  expect(secondary).toContain("#4ecb9d");
  expect(providerIconSrc("anthropic2")).toContain("claude-green.svg");
  expect(providerIconSrc("anthropic")).toContain("claude-color.svg");
});

test("Pool 2 settings retain provider identity and native preference", () => {
  expect(poolSettingsRequestBody("anthropic2", { nativeMessages: false }))
    .toMatchObject({ provider: "anthropic2", nativeMessages: false });
});

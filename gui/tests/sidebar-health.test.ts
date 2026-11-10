import { expect, test } from "bun:test";
import { proxyHealthOnline } from "../src/lib/proxy-health";

test("sidebar status follows the latest health attempt even when earlier data remains", () => {
  expect(proxyHealthOnline(undefined, undefined)).toBe(true);
  expect(proxyHealthOnline({ version: "test" }, undefined)).toBe(true);
  expect(proxyHealthOnline(null, undefined)).toBe(false);
  expect(proxyHealthOnline(undefined, new Error("offline"))).toBe(false);
  expect(proxyHealthOnline({ version: "stale" }, new Error("offline"))).toBe(false);
});

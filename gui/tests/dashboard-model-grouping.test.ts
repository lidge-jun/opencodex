import { expect, test } from "bun:test";
import type { TFn } from "../src/i18n/shared";
import { groupDashboardModels } from "../src/pages/use-dashboard-data";
import { formatProviderDisplayName, providerIconSrc } from "../src/provider-icons";

test("Dashboard groups models whose provider names match object prototype properties", () => {
  const models = [
    { id: "proto-model", provider: "__proto__" },
    { id: "constructor-model", provider: "constructor" },
    { id: "string-model", provider: "toString" },
    { id: "second-proto-model", provider: "__proto__" },
  ];

  expect(groupDashboardModels(models)).toEqual([
    ["__proto__", [models[0], models[3]]],
    ["constructor", [models[1]]],
    ["toString", [models[2]]],
  ]);
});

test("provider display helpers ignore inherited object prototype properties", () => {
  const t = ((key: string) => key) as TFn;
  expect(formatProviderDisplayName("__proto__", t)).toBe("__proto__");
  expect(formatProviderDisplayName("constructor", t)).toBe("Constructor");
  expect(formatProviderDisplayName("toString", t)).toBe("toString");
  expect(providerIconSrc("__proto__")).toBeUndefined();
  expect(providerIconSrc("constructor")).toBeUndefined();
  expect(providerIconSrc("toString")).toBeUndefined();
});

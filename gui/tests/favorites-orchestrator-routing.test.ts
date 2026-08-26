import { expect, test } from "bun:test";
import { VALID_PAGES, readPageFromHash, resolveAppHashChange } from "../src/app-routing";

test("favorites and orchestrator are first-class pages", () => {
  expect(VALID_PAGES.has("favorites")).toBe(true);
  expect(VALID_PAGES.has("orchestrator")).toBe(true);
  expect(readPageFromHash("#favorites")).toBe("favorites");
  expect(readPageFromHash("#orchestrator")).toBe("orchestrator");
});

test("favorites and orchestrator hashes settle without rewrite", () => {
  expect(resolveAppHashChange("favorites")).toEqual({ page: "favorites", replaceTo: null });
  expect(resolveAppHashChange("orchestrator")).toEqual({ page: "orchestrator", replaceTo: null });
});

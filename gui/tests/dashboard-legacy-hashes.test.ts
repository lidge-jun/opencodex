import { expect, test } from "bun:test";
import { hashBelongsToPage, readPageFromHash, resolveAppHashChange, LEGACY_DASHBOARD_TAB_REDIRECTS } from "../src/app-routing";

/**
 * devlog/_plan/260904_dashboard_minimal/020_dashboard_home.md: the dashboard's Providers and
 * Models tabs were read-only copies of the real pages and are gone. Their hashes shipped in
 * bookmarks and Back/Forward history, so they redirect (passively, with a replace) instead
 * of falling back to the overview.
 */

test("the two legacy dashboard tab hashes redirect to their real pages", () => {
  expect(LEGACY_DASHBOARD_TAB_REDIRECTS).toEqual({ "dashboard/providers": "providers", "dashboard/models": "models" });
  for (const [raw, page] of Object.entries(LEGACY_DASHBOARD_TAB_REDIRECTS)) {
    expect(resolveAppHashChange(raw)).toEqual({ page, replaceTo: page });
    // No longer a dashboard route: a bookmark must not light the dashboard row.
    expect(hashBelongsToPage(raw, "dashboard")).toBe(false);
  }
});

test("bare #dashboard and the update deep link are unchanged", () => {
  expect(readPageFromHash("dashboard")).toBe("dashboard");
  expect(resolveAppHashChange("dashboard").replaceTo).toBeNull();
  expect(hashBelongsToPage("dashboard/update", "dashboard")).toBe(true);
  expect(resolveAppHashChange("dashboard/update").replaceTo).toBeNull();
});

test("unknown dashboard suffixes are still normalised away", () => {
  const action = resolveAppHashChange("dashboard/nope");
  expect(action.page).toBe("dashboard");
  expect(action.replaceTo).toBe("dashboard");
});

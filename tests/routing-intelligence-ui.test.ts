import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashBelongsToPage, readPageFromHash, resolveAppHashChange, VALID_PAGES } from "../gui/src/app-routing";
import {
  sanitizeLogEntryRouteDecision,
  validCachedRouteDecision,
  type LogEntryBase as LogEntry,
} from "../gui/src/pages/log-route-decision";

const guiRoot = join(import.meta.dir, "..", "gui", "src");

test("routing is a Models tab with a registered nested hash", () => {
  // It used to be a first-class page. Both ids are gone from the union now, and the
  // old top-level hashes keep working through a passive redirect.
  expect(VALID_PAGES.has("routing" as never)).toBe(false);
  expect(VALID_PAGES.has("combos" as never)).toBe(false);

  expect(readPageFromHash("models/routing")).toBe("models");
  expect(hashBelongsToPage("models/routing", "models")).toBe(true);
  expect(resolveAppHashChange("models/routing").replaceTo).toBeNull();

  expect(resolveAppHashChange("routing")).toEqual({ page: "models", replaceTo: "models/routing" });
  expect(resolveAppHashChange("routing/anything")).toEqual({ page: "models", replaceTo: "models/routing" });
  expect(resolveAppHashChange("combos")).toEqual({ page: "models", replaceTo: "models/combos" });
});

test("Routing page wires profile CRUD, dry-run, and analytics against management APIs", () => {
  const page = readFileSync(join(guiRoot, "pages", "RoutingProfiles.tsx"), "utf8");
  expect(page).toContain("/api/routing-profiles");
  expect(page).toContain('method: "PUT"');
  expect(page).toContain('method: "DELETE"');
  expect(page).toContain("routingProfilePutBody");
  expect(page).toContain("<form");
  expect(page).toContain("/api/routing-analytics");
  expect(page).toContain("/api/routing-profiles/dry-run");
  expect(page).toContain("if (!response.ok)");
  expect(page).toContain('data-page="routing"');
});

test("Logs detail renders a route-decision section with an honest empty state", () => {
  const page = readFileSync(join(guiRoot, "pages", "Logs.tsx"), "utf8");
  expect(page).toContain("routeDecision");
  expect(page).toContain('logs.detail.route.section');
  expect(page).toContain('logs.detail.route.unknown');
  expect(page).toContain("log-detail-route");
});

const baseLog = {
  timestamp: 1,
  model: "gpt-test",
  provider: "openai",
  status: 200,
  durationMs: 10,
} satisfies LogEntry;

test("validCachedRouteDecision accepts a well-formed route decision", () => {
  expect(validCachedRouteDecision(undefined)).toBe(true);
  expect(validCachedRouteDecision({
    routeKind: "combo",
    profile: { id: "balanced", revision: "rev-1" },
    selected: { provider: "openai", model: "gpt-5", reason: "score" },
    candidates: [{ provider: "openai", model: "gpt-5", eligible: true, exclusions: [{ code: "cooldown" }] }],
  })).toBe(true);
});

test("validCachedRouteDecision rejects malformed candidates and nested fields", () => {
  expect(validCachedRouteDecision({ candidates: "nope" as unknown as [] })).toBe(false);
  expect(validCachedRouteDecision({ candidates: [{ provider: "openai", eligible: "yes" as unknown as boolean }] })).toBe(false);
  expect(validCachedRouteDecision({ profile: { id: 12 as unknown as string } })).toBe(false);
  expect(validCachedRouteDecision({ routeKind: 7 as unknown as string })).toBe(false);
  expect(validCachedRouteDecision({ selected: { provider: 1 as unknown as string } })).toBe(false);
});

test("sanitizeLogEntryRouteDecision drops invalid routeDecision and keeps valid ones", () => {
  const valid: LogEntry = {
    ...baseLog,
    routeDecision: {
      routeKind: "native",
      selected: { provider: "openai", model: "gpt-5" },
    },
  };
  const invalid: LogEntry = {
    ...baseLog,
    routeDecision: {
      candidates: { provider: "openai" } as unknown as [],
    },
  };

  expect(sanitizeLogEntryRouteDecision(valid).routeDecision).toEqual(valid.routeDecision);
  expect(sanitizeLogEntryRouteDecision(invalid).routeDecision).toBeUndefined();
  expect(sanitizeLogEntryRouteDecision(baseLog).routeDecision).toBeUndefined();
});

test("Models mounts RoutingProfiles as a tab, and App no longer owns a Routing row", () => {
  const models = readFileSync(join(guiRoot, "pages", "Models.tsx"), "utf8");
  expect(models).toContain("RoutingProfiles");
  expect(models).toContain('modelsPanelDomId("routing")');

  const app = readFileSync(join(guiRoot, "App.tsx"), "utf8");
  expect(app).not.toContain('id: "routing"');
  expect(app).not.toContain('page === "routing"');
  expect(app).not.toContain("IconRoute");
});

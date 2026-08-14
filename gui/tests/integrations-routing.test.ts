import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  hashBelongsToPage,
  readPageFromHash,
  resolveAppHashChange,
  INTEGRATION_TAB_HASHES,
  VALID_PAGES,
} from "../src/app-routing";
import { normalizeHashPath, replaceHash } from "../src/hash-routing";

/**
 * Routing contract for devlog/_fin/260802_client_toggle_api/050 §2-§3.
 *
 * The three legacy top-level pages (`api`, `claude`, `grok`) collapse into one
 * `integrations` route with nested hashes. The load-bearing property is not
 * "the page resolves" — it is that each legacy hash keeps its SPECIFIC nested
 * destination, because `readPageFromHash` already answers `integrations` and
 * generic normalization would otherwise rewrite the hash to the bare page and
 * silently land an old bookmark on Overview.
 */

const LEGACY_DESTINATIONS: readonly (readonly [string, string])[] = [
  ["api", "integrations/keys"],
  ["claude", "integrations/claude"],
  ["grok", "integrations/grok"],
];

describe("legacy integration hashes", () => {
  test("each legacy hash resolves to its own nested destination", () => {
    for (const [legacy, destination] of LEGACY_DESTINATIONS) {
      const action = resolveAppHashChange(legacy);
      expect(action.page).toBe("integrations");
      // The destination, not merely the page: asserting only `page` would pass
      // even if every legacy hash collapsed onto Overview.
      expect(action.replaceTo).toBe(destination);
    }
  });

  test("the legacy page ids are no longer routes of their own", () => {
    for (const [legacy] of LEGACY_DESTINATIONS) {
      expect(VALID_PAGES.has(legacy as never)).toBe(false);
      // They still resolve — as the new page, never as the dashboard fallback.
      expect(readPageFromHash(legacy)).toBe("integrations");
    }
  });

  test("readPageFromHash alone cannot preserve the destination", () => {
    /*
     * Pins the ORDERING the plan calls observable. `readPageFromHash` maps the
     * legacy id to the new page, so by the time generic normalization runs the
     * hash already "belongs" to no registered route; only the explicit
     * resolver branches carry the nested destination. If those branches moved
     * below the normalization, `replaceTo` would be the bare page instead.
     */
    for (const [legacy, destination] of LEGACY_DESTINATIONS) {
      expect(readPageFromHash(legacy)).toBe("integrations");
      expect(hashBelongsToPage(legacy, "integrations")).toBe(false);
      expect(resolveAppHashChange(legacy).replaceTo).toBe(destination);
      expect(resolveAppHashChange(legacy).replaceTo).not.toBe("integrations");
    }
  });
});

describe("registered nested hashes", () => {
  test("every registered tab hash survives untouched", () => {
    for (const raw of INTEGRATION_TAB_HASHES) {
      expect(readPageFromHash(raw)).toBe("integrations");
      expect(hashBelongsToPage(raw, "integrations")).toBe(true);
      const action = resolveAppHashChange(raw);
      expect(action.page).toBe("integrations");
      // A registered hash must never be passively replaced.
      expect(action.replaceTo).toBeNull();
    }
  });

  test("the two-segment Claude Desktop route is registered", () => {
    /*
     * Claude Desktop is owned by the inner Claude panel, but it has to appear
     * in the registry or App normalization strips the suffix before Claude can
     * read it — the panel would open on Claude Code every time.
     */
    expect(INTEGRATION_TAB_HASHES).toContain("integrations/claude/desktop");
    expect(resolveAppHashChange("integrations/claude/desktop").replaceTo).toBeNull();
  });

  test("the DSH deep link is registered and survives normalization", () => {
    expect(INTEGRATION_TAB_HASHES).toContain("integrations/dsh");
    expect(readPageFromHash("integrations/dsh")).toBe("integrations");
    expect(resolveAppHashChange("integrations/dsh")).toEqual({
      page: "integrations",
      replaceTo: null,
    });
  });

  test("bare #integrations is Overview and has no suffix of its own", () => {
    expect(readPageFromHash("integrations")).toBe("integrations");
    expect(hashBelongsToPage("integrations", "integrations")).toBe(true);
    expect(resolveAppHashChange("integrations").replaceTo).toBeNull();
    expect(INTEGRATION_TAB_HASHES).not.toContain("integrations/overview");
  });

  test("an unregistered suffix is normalized back to the bare page", () => {
    const action = resolveAppHashChange("integrations/nonsense");
    expect(action.page).toBe("integrations");
    expect(action.replaceTo).toBe("integrations");
  });
});

describe("the collapse disturbs no neighbouring route", () => {
  test("logs, dashboard and providers keep their contracts", () => {
    expect(hashBelongsToPage("logs/debug", "logs")).toBe(true);
    expect(resolveAppHashChange("debug").replaceTo).toBe("logs/debug");
    expect(resolveAppHashChange("providers/workspace").replaceTo).toBe("providers");
    expect(hashBelongsToPage("dashboard/update", "dashboard")).toBe(true);
    // Cross-page suffixes stay invalid in both directions.
    expect(hashBelongsToPage("integrations/keys", "dashboard")).toBe(false);
    expect(hashBelongsToPage("logs/debug", "integrations")).toBe(false);
  });
});

describe("history semantics", () => {
  let win: Window;
  let previous: Record<string, unknown>;
  const keys = ["window", "document"] as const;

  beforeEach(() => {
    previous = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
    win = new Window({ url: "http://localhost/#api" });
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: win },
      document: { configurable: true, value: win.document },
    });
  });

  afterEach(() => {
    for (const key of keys) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  });

  test("correcting an old bookmark adds no history entry", () => {
    /*
     * The whole reason `replaceTo` exists rather than a push: a user arriving
     * on `#api` must not need two Backs to leave, with the first one landing
     * on a hash the router immediately corrects again.
     */
    const before = win.history.length;
    const action = resolveAppHashChange(normalizeHashPath(win.location.hash));
    expect(action.replaceTo).toBe("integrations/keys");
    replaceHash(action.replaceTo!, win as unknown as Window & typeof globalThis);
    expect(normalizeHashPath(win.location.hash)).toBe("integrations/keys");
    expect(win.history.length).toBe(before);
  });

  test("the corrected hash is itself a registered route, so it settles", () => {
    // A redirect that lands on something the resolver would rewrite again is
    // a loop; assert the destination is terminal.
    for (const [, destination] of LEGACY_DESTINATIONS) {
      expect(resolveAppHashChange(destination).replaceTo).toBeNull();
    }
  });
});

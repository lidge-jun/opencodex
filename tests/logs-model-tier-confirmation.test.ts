import { describe, expect, test } from "bun:test";
import { modelTitle, type ModelTitleEntry } from "../gui/src/pages/logs-model-title";

/**
 * #2455: a user routing gpt-5.x through the proxy asked for `service_tier: priority`,
 * saw the backend echo something else, and had no way to tell whether Fast was granted.
 *
 * The echo alone cannot answer it. The ChatGPT-internal Codex backend returns
 * `service_tier: "default"` on turns it in fact scheduled as priority, so its echo is
 * marked non-authoritative and the outcome stays `assumed` rather than being read as a
 * downgrade (#2558). That is the honest answer — but it was computed in `tierOutcome`
 * and never shown, so the tooltip printed a bare echoed value that looked like a denial.
 */
const t = ((key: string) => key.replace("logs.modelTooltip.", "")) as never;

function entry(over: Partial<ModelTitleEntry> = {}): ModelTitleEntry {
  return { model: "gpt-5.6-terra", ...over };
}

describe("model tooltip tier confirmation (#2455)", () => {
  test("qualifies the echoed tier with the outcome", () => {
    const title = modelTitle(
      entry({ responseServiceTier: "default", tierOutcome: { confirmation: "assumed" } }),
      t,
    );
    expect(title).toContain("responseTier=default (assumed)");
  });

  test("names the reason when the tier was actually declined", () => {
    const title = modelTitle(
      entry({
        responseServiceTier: "default",
        tierOutcome: { confirmation: "downgraded", fastDowngradeReason: "response-declined" },
      }),
      t,
    );
    expect(title).toContain("responseTier=default (downgraded: response-declined)");
  });

  test("a confirmed grant reads as confirmed", () => {
    const title = modelTitle(
      entry({ responseServiceTier: "priority", tierOutcome: { confirmation: "confirmed" } }),
      t,
    );
    expect(title).toContain("responseTier=priority (confirmed)");
  });

  test("no outcome leaves the existing tooltip byte-for-byte unchanged", () => {
    // Every route that never carried a tierOutcome must render exactly as before.
    const before = modelTitle(entry({ responseServiceTier: "default" }), t);
    expect(before).toContain("responseTier=default");
    expect(before).not.toContain("(");
  });

  test("an outcome without an echoed tier adds nothing", () => {
    // The qualifier explains an echoed value; with nothing echoed there is nothing to
    // qualify, and inventing a standalone field would need a new i18n key in 9 locales.
    const title = modelTitle(entry({ tierOutcome: { confirmation: "assumed" } }), t);
    expect(title).not.toContain("assumed");
    expect(title).toBe("model=gpt-5.6-terra");
  });

  test("a downgrade with no recorded reason omits the colon", () => {
    const title = modelTitle(
      entry({ responseServiceTier: "default", tierOutcome: { confirmation: "downgraded" } }),
      t,
    );
    expect(title).toContain("responseTier=default (downgraded)");
    expect(title).not.toContain("downgraded:");
  });
});

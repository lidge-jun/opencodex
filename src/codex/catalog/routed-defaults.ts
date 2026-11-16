import type { RoutedCatalogDefaults } from "../../config/schema/routed-catalog-defaults";
import type { RawEntry } from "./parsing";

/**
 * Project operator `routedCatalogDefaults` (#6872) onto a freshly derived routed row.
 *
 * `deriveEntry` calls this after the inherited template has been normalized for routing and
 * before provider/model metadata is applied, which fixes the precedence: concrete provider/model
 * declarations > these defaults > template values > strict-field fallbacks. The final
 * `ensureStrictCatalogFields` pass still removes `default_verbosity` from a row whose
 * `support_verbosity` ended up false, so a model without verbosity support never advertises an
 * operator default. Verbosity support itself is never set here: it stays the provider's,
 * model's or template's own declaration.
 *
 * Only the four allowlisted serialized fields are written. Values of any other type are ignored,
 * so a caller that bypassed config validation cannot smuggle other row fields through here.
 */
export function applyRoutedCatalogDefaults(
  entry: RawEntry,
  defaults: Readonly<RoutedCatalogDefaults> | undefined,
): void {
  if (!defaults) return;
  if (typeof defaults.includeSkillsUsageInstructions === "boolean") {
    entry.include_skills_usage_instructions = defaults.includeSkillsUsageInstructions;
  }
  if (typeof defaults.includeAppsUsageInstructions === "boolean") {
    entry.include_apps_usage_instructions = defaults.includeAppsUsageInstructions;
  }
  if (typeof defaults.includePluginUsageInstructions === "boolean") {
    entry.include_plugin_usage_instructions = defaults.includePluginUsageInstructions;
  }
  if (defaults.defaultVerbosity === "low" || defaults.defaultVerbosity === "medium" || defaults.defaultVerbosity === "high") {
    entry.default_verbosity = defaults.defaultVerbosity;
  }
}

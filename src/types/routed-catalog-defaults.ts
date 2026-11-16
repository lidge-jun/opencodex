/**
 * Operator defaults for routed Codex catalog rows (#6872), stored as top-level
 * `routedCatalogDefaults` in config.json. Every field is optional: omission keeps the derived
 * value and explicit `false` stays `false`. Concrete provider/model declarations still win, and
 * a row without verbosity support never carries `default_verbosity`. Validation lives in
 * src/config/schema/routed-catalog-defaults.ts; derivation in src/codex/catalog/routed-defaults.ts.
 */
export interface OcxRoutedCatalogDefaultsConfig {
  /** Serialized as `include_skills_usage_instructions`. */
  includeSkillsUsageInstructions?: boolean;
  /** Serialized as `include_apps_usage_instructions`. */
  includeAppsUsageInstructions?: boolean;
  /** Serialized as `include_plugin_usage_instructions`. */
  includePluginUsageInstructions?: boolean;
  /** Serialized as `default_verbosity`; applies only to rows that support verbosity, and never turns support on. */
  defaultVerbosity?: "low" | "medium" | "high";
}

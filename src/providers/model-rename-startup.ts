import { mutatePersistedConfig } from "../config";
import { projectModelRenames } from "./model-rename-migration";
import type { OcxConfig } from "../types";

export interface ModelRenameStartupDeps {
  project: typeof projectModelRenames;
  /** Injected writer for tests and callers that own their own persistence. */
  save?: (config: OcxConfig) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive key-by-key adopt: descend into a changed container, replace only changed leaves. */
function adoptRecord(live: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(live)) {
    if (!(key in next)) delete live[key];
  }
  for (const [key, value] of Object.entries(next)) {
    const current = live[key];
    if (JSON.stringify(current) === JSON.stringify(value)) continue;
    if (isPlainObject(current) && isPlainObject(value)) {
      adoptRecord(current, value);
      continue;
    }
    live[key] = value;
  }
}

/**
 * Copy `source` onto `target` in place, touching only the keys that actually differ.
 *
 * A clear-and-reassign preserves the top-level object identity while silently detaching every
 * nested sub-object a caller still holds a live reference to. The renames rewrite one provider
 * row at a time, so every sibling row — and the `providers` container itself — must survive
 * with its identity intact.
 */
function adoptConfig(target: OcxConfig, source: OcxConfig): void {
  if (target === source) return;
  adoptRecord(
    target as unknown as Record<string, unknown>,
    structuredClone(source) as unknown as Record<string, unknown>,
  );
}

/**
 * Apply registry model renames to the saved config at startup (issue #1610).
 *
 * No backup is taken, unlike the OpenAI tier and Alibaba region migrations: those
 * rewrite credentials and provider identity, where a bad projection is not
 * recoverable from the config alone. This one only rewrites model ids that the
 * registry itself no longer seeds, and the pre-migration value is a string this
 * file still names, so the change is reversible by hand.
 *
 * Persistence failure is not fatal. This runs inside `startServer`, so a missing, malformed or
 * contended config degrades to a warning plus the in-memory projection rather than taking the
 * boot path down.
 */
export function runModelRenameStartupMigration(
  config: OcxConfig,
  deps: ModelRenameStartupDeps = { project: projectModelRenames },
): OcxConfig {
  const projection = deps.project(structuredClone(config));
  if (!projection.changed) {
    for (const warning of projection.warnings) console.warn(`[model-rename-migration] ${warning}`);
    return config;
  }
  if (deps.save) {
    deps.save(projection.config);
    adoptConfig(config, projection.config);
    for (const warning of projection.warnings) console.warn(`[model-rename-migration] ${warning}`);
    return config;
  }
  const outcome = mutatePersistedConfig(fresh => {
    const next = deps.project(fresh);
    if (next.changed) adoptConfig(fresh, next.config);
    return { changed: next.changed, value: next };
  });
  if (outcome.status === "unavailable") {
    console.warn(
      `[model-rename-migration] persistence unavailable (${outcome.reason}); applying the renames `
      + "in memory for this run only.",
    );
    adoptConfig(config, projection.config);
    for (const warning of projection.warnings) console.warn(`[model-rename-migration] ${warning}`);
    return config;
  }
  adoptConfig(config, outcome.value.config);
  for (const warning of outcome.value.warnings) console.warn(`[model-rename-migration] ${warning}`);
  return config;
}

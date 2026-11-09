import type { OcxProviderConfig } from "../../types";
import { thinkingDisplayConfigError } from "../../config/provider-validation";
import { isPlainRecord } from "./shared";

type ThinkingDisplay = NonNullable<OcxProviderConfig["thinkingDisplay"]>;

/**
 * Apply the `thinkingDisplay` / `modelThinkingDisplay` PATCH mask (#8363).
 *
 * Split out of provider-routes.ts, which sits under the 2,000-line file-size threshold; the
 * behaviour stays identical to the sibling per-model map patches there. A model entry of
 * `null` deletes one key, `null` on the whole map clears it, and provider-level `null` or ""
 * clears the scalar.
 */
export function applyThinkingDisplayPatchFields(
  next: OcxProviderConfig,
  rawBody: Record<string, unknown>,
): { error: string } | null {
  if (Object.hasOwn(rawBody, "thinkingDisplay")) {
    const value = rawBody.thinkingDisplay;
    if (value === null || value === "") {
      delete next.thinkingDisplay;
    } else {
      const error = thinkingDisplayConfigError(value);
      if (error) return { error };
      next.thinkingDisplay = value as ThinkingDisplay;
    }
  }
  if (Object.hasOwn(rawBody, "modelThinkingDisplay")) {
    const value = rawBody.modelThinkingDisplay;
    if (value === null) {
      delete next.modelThinkingDisplay;
    } else {
      if (!isPlainRecord(value)) return { error: "modelThinkingDisplay must be a plain object or null" };
      const merged = Object.assign(
        Object.create(null) as Record<string, ThinkingDisplay>,
        next.modelThinkingDisplay ?? {},
      );
      for (const [model, policy] of Object.entries(value as Record<string, unknown>)) {
        if (!model.trim()) return { error: "modelThinkingDisplay keys must be nonblank model ids" };
        if (policy === null) delete merged[model];
        else {
          const entryError = thinkingDisplayConfigError(policy, `modelThinkingDisplay.${JSON.stringify(model)}`);
          if (entryError) return { error: entryError };
          merged[model] = policy as ThinkingDisplay;
        }
      }
      if (Object.keys(merged).length > 0) next.modelThinkingDisplay = merged;
      else delete next.modelThinkingDisplay;
    }
  }
  return null;
}


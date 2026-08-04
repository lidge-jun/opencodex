/**
 * Write-path validation for the Desktop 3P model list.
 *
 * The request path has its own guards (anthropic-image-guard.ts); this is the
 * config-output counterpart. A bad entry here ships inside a user-visible config file,
 * so it fails LOUD at the write boundary rather than silently producing a config
 * Desktop rejects or mislabels.
 */
import type { Desktop3pModelEntry } from "./desktop-3p";

const NAME_PATTERN = /^claude-[a-z0-9-]+$/;
const MAX_LABEL_CHARS = 80;
/** Bracket capability markers must already have been normalized away by displayModelId. */
const FORBIDDEN_LABEL_CHARS = /[[\]]/;

export function assertDesktop3pModelsValid(models: readonly Desktop3pModelEntry[]): void {
  const seen = new Set<string>();
  for (const model of models) {
    if (!NAME_PATTERN.test(model.name)) {
      throw new Error(`Desktop 3P model name is not a valid Claude-shaped id: ${model.name}`);
    }
    // Alias collisions are skipped upstream; if that skip ever regresses, a duplicate
    // must fail here instead of writing a config Desktop cannot decode.
    if (seen.has(model.name)) {
      throw new Error(`Desktop 3P model name duplicated: ${model.name}`);
    }
    seen.add(model.name);
    if (FORBIDDEN_LABEL_CHARS.test(model.labelOverride)) {
      throw new Error(`Desktop 3P label carries a raw capability marker: ${model.labelOverride}`);
    }
    if (model.labelOverride.length > MAX_LABEL_CHARS) {
      throw new Error(`Desktop 3P label exceeds ${MAX_LABEL_CHARS} chars: ${model.labelOverride}`);
    }
  }
}

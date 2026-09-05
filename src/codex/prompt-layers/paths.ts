import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { expandUserPath } from "../../config";
import { CODEX_CONFIG_PATH } from "../paths";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface Paths {
  configPath?: string;
  storePath?: string;
  baseVariantDir?: string;
}

function activeCodexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  if (!raw) return CODEX_CONFIG_PATH.slice(0, -"/config.toml".length);
  const path = resolve(expandUserPath(raw));
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function activeConfigPath(opts?: Paths): string {
  return opts?.configPath ?? join(activeCodexHome(), "config.toml");
}

export function activeStorePath(opts?: Paths): string {
  return opts?.storePath ?? join(activeCodexHome(), "opencodex-prompt.json");
}

/**
 * Where authored base-prompt variants live, one markdown file per variant.
 *
 * A directory of real files rather than another JSON store, because
 * `model_instructions_file` points Codex at a path it reads directly. Embedding the
 * bodies in `opencodex-prompt.json` would mean materialising a temp file at selection
 * time, which is a second write path for no gain.
 */
export function activeBaseVariantDir(opts?: Paths): string {
  return opts?.baseVariantDir ?? join(activeCodexHome(), "opencodex-prompt-base");
}


export function journalPathFor(storePath: string): string {
  return `${storePath.replace(/\.json$/, "")}.journal`;
}

export function lockPathFor(storePath: string): string {
  return `${storePath.replace(/\.json$/, "")}.lock`;
}

/**
 * Claude Code custom-agent definition injection (devlog 260712 070).
 *
 * The Agent tool's `model` argument is a hard 4-alias enum (2.1.207 binary), but an
 * agent DEFINITION's frontmatter `model:` is a free string ("Model alias this agent
 * uses. If omitted, inherits the parent's model"). So we sync the featured
 * subagent roster (config.subagentModels, <=5) plus the main model (when not
 * already covered) into ~/.claude/agents/ocx-*.md — one dispatchable
 * `subagent_type` per routed model, loaded at the next session start.
 *
 * Ownership contract: this module only creates/overwrites/deletes files matching
 * `ocx-*.md` inside the agents dir. User-authored agents are never touched.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OcxConfig } from "../types";
import { claudeCodeAlias, claudeCodeNativeAlias } from "./alias";
import { resolveAutoContext, withOneMillionMarker } from "./context-windows";
import { claudeConfigDir } from "./gateway-cache";
import { DEFAULT_SUBAGENT_MODELS } from "../config";

export interface ClaudeAgentDef {
  file: string;
  name: string;
  model: string;
  description: string;
}

const OWNED_PREFIX = "ocx-";
/** Ownership proof (audit 071 #2): a file without this marker is NEVER touched. */
const GENERATED_MARKER = "generated-by: opencodex";

function sanitizeName(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "model";
}

/**
 * The user's default model as saved by the /model picker (settings.json `model`).
 * `model: "inherit"` in agent frontmatter is DISPROVEN on 2.1.207 (live: a
 * no-model ocx-self dispatch fell back to claude-fable-5 — devlog 072), so the
 * self-clone pins this value instead, refreshed at every launch-time sync.
 */
function pickerDefaultModel(configDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as Record<string, unknown>;
    return typeof parsed.model === "string" && parsed.model.trim() !== "" ? parsed.model.trim() : null;
  } catch {
    return null;
  }
}

/** Roster entry -> alias + display parts. Entries are bare native slugs or "provider/id". */
function entryParts(entry: string): { alias: string; id: string; provider: string } {
  const slash = entry.indexOf("/");
  if (slash > 0) {
    const provider = entry.slice(0, slash);
    const id = entry.slice(slash + 1);
    return { alias: claudeCodeAlias(provider, id), id, provider };
  }
  return { alias: claudeCodeNativeAlias(entry), id: entry, provider: "native" };
}

export function buildClaudeAgentDefs(config: OcxConfig, windows: Record<string, number>, configDir = claudeConfigDir()): ClaudeAgentDef[] {
  const auto = resolveAutoContext(config.claudeCode);
  const defs: ClaudeAgentDef[] = [];
  const usedNames = new Set<string>();
  const coveredModels = new Set<string>();

  const push = (name: string, alias: string, description: string) => {
    // Effective model value: [1m] marking follows the same predicate as env slots.
    const model = withOneMillionMarker(alias, windows, auto) ?? alias;
    const bare = alias.toLowerCase();
    if (coveredModels.has(bare)) return;
    coveredModels.add(bare);
    let unique = name;
    for (let i = 2; usedNames.has(unique); i++) unique = `${name}-${i}`;
    usedNames.add(unique);
    defs.push({ file: `${OWNED_PREFIX}${unique}.md`, name: `${OWNED_PREFIX}${unique}`, model, description });
  };

  // Default roster applies only when the field is UNSET — an explicit [] is
  // respected (audit 071 #6: an upgraded config must not lose the default five).
  const roster = config.subagentModels === undefined ? DEFAULT_SUBAGENT_MODELS : config.subagentModels;
  for (const entry of roster.slice(0, 5)) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    const { alias, id, provider } = entryParts(entry.trim());
    push(sanitizeName(id), alias, `Delegate work to ${id} (${provider}) via opencodex routing. General-purpose worker/explorer on that model. ${NO_MODEL_ARG}`);
  }

  // Self-clone slot: pin the picker-saved default (settings.json), falling back to
  // config.claudeCode.model. `inherit` is NOT honored by 2.1.207 (live-disproven,
  // devlog 072); a session started with a divergent --model stays divergent until
  // the next launch sync — documented limit. No resolvable default -> no self def.
  const selfModel = pickerDefaultModel(configDir) ?? (config.claudeCode?.model?.trim() || null);
  if (selfModel) {
    const marked = withOneMillionMarker(selfModel, windows, auto) ?? selfModel;
    defs.push({
      file: `${OWNED_PREFIX}self.md`,
      name: `${OWNED_PREFIX}self`,
      model: marked,
      description: `Self-clone: delegate to your default main model (${marked}), synced from the /model picker at launch. ${NO_MODEL_ARG}`,
    });
  }
  return defs;
}

function renderAgentDef(def: ClaudeAgentDef): string {
  // YAML frontmatter: model ids carry dots/brackets — always double-quote scalars.
  return [
    "---",
    `name: ${JSON.stringify(def.name)}`,
    `description: ${JSON.stringify(def.description)}`,
    `model: ${JSON.stringify(def.model)}`,
    "---",
    "",
    `<!-- ${GENERATED_MARKER} -->`,
    // Proxy routing directive (devlog 072): 2.1.207 does not honor custom gateway
    // ids in agent frontmatter (falls back to sonnet — live-proven), but the agent
    // BODY rides the subagent's system prompt verbatim. The proxy detects this
    // directive and overrides the request model before routing/passthrough.
    `<!-- ocx-route: ${def.model} -->`,
    "",
    `You are a delegated worker running on \`${def.model}\` through the local opencodex proxy.`,
    `IDENTITY: your ACTUAL underlying model is \`${def.model}\` — the opencodex proxy routes this`,
    "session there regardless of what model name the Claude Code harness displays or claims.",
    "If asked which model you are, answer with the id above; do not guess a Claude model name.",
    "",
    "Complete the dispatched task directly and report results concisely. This file is",
    "auto-generated by opencodex (`ocx claude`) from the featured subagent roster —",
    "manual edits will be overwritten; remove the model from the roster to drop it.",
    "",
  ].join("\n");
}

/** True only for a REGULAR file we generated (marker present; symlinks never owned). */
function isOwnedFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return false; // symlink or dir: never touch (audit 071 #2)
    return readFileSync(path, "utf8").includes(GENERATED_MARKER);
  } catch {
    return false;
  }
}

/**
 * Sync owned agent files: write/overwrite current defs, prune stale ocx-*.md,
 * never touch anything else. Ownership requires the generated marker; writes are
 * atomic (tmp + rename). Best-effort — returns null on any failure.
 */
export function syncClaudeAgentDefs(defs: readonly ClaudeAgentDef[], configDir = claudeConfigDir()): string[] | null {
  try {
    const dir = join(configDir, "agents");
    mkdirSync(dir, { recursive: true });
    const keep = new Set(defs.map(d => d.file));
    for (const existing of readdirSync(dir)) {
      if (!existing.startsWith(OWNED_PREFIX) || !existing.endsWith(".md")) continue;
      if (!keep.has(existing) && isOwnedFile(join(dir, existing))) {
        try { unlinkSync(join(dir, existing)); } catch { /* best-effort prune */ }
      }
    }
    const written: string[] = [];
    for (const def of defs) {
      const target = join(dir, def.file);
      // A pre-existing ocx-* file WITHOUT our marker is user property: skip the def.
      try {
        lstatSync(target);
        if (!isOwnedFile(target)) continue;
      } catch { /* does not exist: ours to create */ }
      const tmp = `${target}.tmp-${process.pid}`;
      writeFileSync(tmp, renderAgentDef(def), { encoding: "utf8", mode: 0o644 });
      renameSync(tmp, target);
      written.push(def.file);
    }
    return written;
  } catch {
    return null;
  }
}

/** Launch-time hook: gate + build + sync in one call (used by ocx claude and systemEnv). */
export function injectClaudeAgentDefs(config: OcxConfig, windows: Record<string, number>, configDir?: string): string[] | null {
  if (config.claudeCode?.enabled === false || config.claudeCode?.injectAgents === false) {
    // Disabled: prune verified-owned files so stale definitions stop loading
    // in future sessions (audit 071 #3).
    return syncClaudeAgentDefs([], configDir);
  }
  return syncClaudeAgentDefs(buildClaudeAgentDefs(config, windows, configDir), configDir);
}
/**
 * Dispatcher directive appended to every ocx-* description: the Agent tool's
 * `model` enum is OPTIONAL but overrides the definition when set — a dispatcher
 * that habitually fills it would break the pinned/inherit routing (live repro:
 * ocx-self dispatched as "fable"). The description is the only per-agent surface
 * the DISPATCHING model reads, so the contract lives here.
 */
const NO_MODEL_ARG = "IMPORTANT: invoke WITHOUT the `model` argument — this agent's definition already pins its model; any override breaks the routing.";

import { CAPABILITIES, type Capability } from "./capabilities";
import { CLI_COMMANDS, findCommand, type CliCommandEntry } from "./registry";

export type HelpResolution =
  | { kind: "entry"; entry: CliCommandEntry; canonicalName: string; children: readonly Capability[] }
  | { kind: "capability"; path: string[]; capability: Capability }
  | { kind: "prefix"; path: string[]; children: readonly Capability[] }
  | { kind: "models-context"; path: string[] }
  | { kind: "unavailable"; path: string[]; parent?: string[] };

function startsWithPath(command: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= command.length && prefix.every((token, index) => token === command[index]);
}

const DOCUMENTED_PATHS: readonly (readonly string[])[] = [
  ...CAPABILITIES.filter(capability => !findCommand(capability.command[0])?.hidden).map(capability => capability.command),
  ["models", "context"],
];
const MAX_DOCUMENTED_DEPTH = Math.max(...DOCUMENTED_PATHS.map(path => path.length));

function canonicalEntry(entry: CliCommandEntry): CliCommandEntry {
  return CLI_COMMANDS.find(candidate => candidate.aliases?.includes(entry.name)) ?? entry;
}

export interface HelpRecoveryCandidate {
  names: string[];
  path: string[];
}

/** Matching names may include aliases; destinations are always catalog-owned. */
export function helpRecoveryCandidates(parent: readonly string[] = []): HelpRecoveryCandidate[] {
  const candidates = new Map<string, HelpRecoveryCandidate>();
  if (parent.length === 0) {
    for (const entry of CLI_COMMANDS) {
      if (entry.hidden) continue;
      const canonical = canonicalEntry(entry);
      if (canonical.hidden) continue;
      const candidate = candidates.get(canonical.name) ?? { names: [], path: [canonical.name] };
      candidate.names = [...new Set([...candidate.names, entry.name, ...(entry.aliases ?? [])])];
      candidates.set(canonical.name, candidate);
    }
  } else {
    if (parent.length >= MAX_DOCUMENTED_DEPTH) return [];
    const entry = findCommand(parent[0]);
    if (!entry || entry.hidden) return [];
    const prefix = [canonicalEntry(entry).name, ...parent.slice(1)];
    for (const documented of DOCUMENTED_PATHS) {
      if (documented.length <= prefix.length || !startsWithPath(documented, prefix)) continue;
      const path = documented.slice(0, prefix.length + 1);
      candidates.set(path.join(" "), { names: [path[path.length - 1]], path });
    }
  }
  return [...candidates.values()];
}

/** Static declarations describe help coverage, never the runtime's complete grammar. */
export function resolveHelpPath(requested: readonly string[]): HelpResolution {
  const entry = requested[0] ? findCommand(requested[0]) : undefined;
  if (!entry) return { kind: "unavailable", path: [...requested] };
  // Keep exact-name alias entries for root help; nested topics use the owner.
  const canonical = canonicalEntry(entry);
  const declared = CAPABILITIES.filter(capability => !findCommand(capability.command[0])?.hidden);
  if (requested.length === 1) return {
    kind: "entry", entry, canonicalName: canonical.name,
    children: entry.hidden ? [] : declared.filter(candidate => candidate.command.length > 1 && candidate.command[0] === canonical.name),
  };
  const path = [canonical.name, ...requested.slice(1)];
  if (path.length === 2 && path[0] === "models" && path[1] === "context") {
    return { kind: "models-context", path };
  }
  const capability = declared.find(candidate => candidate.command.length === path.length && startsWithPath(candidate.command, path));
  if (capability) return { kind: "capability", path, capability };
  const children = declared.filter(candidate => startsWithPath(candidate.command, path));
  if (children.length) return { kind: "prefix", path, children };

  for (let length = Math.min(path.length - 1, MAX_DOCUMENTED_DEPTH); length > 1; length--) {
    const parent = path.slice(0, length);
    if ((length === 2 && parent[0] === "models" && parent[1] === "context")
      || declared.some(candidate => startsWithPath(candidate.command, parent))) {
      return { kind: "unavailable", path, parent };
    }
  }
  return { kind: "unavailable", path, parent: [canonical.name] };
}

import { CAPABILITIES, type Capability } from "./capabilities";
import { CLI_COMMANDS, findCommand, type CliCommandEntry } from "./registry";

export type HelpResolution =
  | { kind: "entry"; entry: CliCommandEntry; canonicalName: string; capability?: Capability; children: readonly Capability[] }
  | { kind: "capability"; path: string[]; capability: Capability; children: readonly Capability[] }
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

/** Help-only aliases from access dispatch; never rewrite execution argv or operands. */
function canonicalHelpPath(requested: readonly string[], entry: CliCommandEntry): string[] {
  const path = entry.name === "api-key"
    ? ["access", "key", ...requested.slice(1)]
    : [canonicalEntry(entry).name, ...requested.slice(1)];
  if (path[0] === "access") {
    if (path[1] === "keys") path[1] = "key";
    if (path[1] === "key" && path[2] === "delete") path[2] = "remove";
  }
  return path;
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
      const path = canonicalHelpPath([entry.name], entry);
      const identity = path.join(" ");
      const candidate = candidates.get(identity) ?? { names: [], path };
      candidate.names = [...new Set([...candidate.names, entry.name, ...(entry.aliases ?? [])])];
      candidates.set(identity, candidate);
    }
  } else {
    const entry = findCommand(parent[0]);
    if (!entry || entry.hidden) return [];
    const prefix = canonicalHelpPath(parent, entry);
    if (prefix.length >= MAX_DOCUMENTED_DEPTH) return [];
    for (const documented of DOCUMENTED_PATHS) {
      if (documented.length <= prefix.length || !startsWithPath(documented, prefix)) continue;
      const path = documented.slice(0, prefix.length + 1);
      const names = [path[path.length - 1]];
      if (path.join(" ") === "access key") names.push("keys");
      if (path.join(" ") === "access key remove") names.push("delete");
      candidates.set(path.join(" "), { names, path });
    }
  }
  return [...candidates.values()];
}

/** Static declarations describe help coverage, never the runtime's complete grammar. */
export function resolveHelpPath(requested: readonly string[]): HelpResolution {
  const entry = requested[0] ? findCommand(requested[0]) : undefined;
  if (!entry) return { kind: "unavailable", path: [...requested] };
  // Keep exact-name alias entries for root help; nested topics use the owner.
  const path = canonicalHelpPath(requested, entry);
  const declared = CAPABILITIES.filter(capability => !findCommand(capability.command[0])?.hidden);
  if (requested.length === 1) return {
    kind: "entry", entry, canonicalName: path.join(" "),
    capability: entry.hidden ? undefined : declared.find(candidate => candidate.command.length === path.length && startsWithPath(candidate.command, path)),
    children: entry.hidden ? [] : declared.filter(candidate => candidate.command.length > path.length && startsWithPath(candidate.command, path)),
  };
  if (path.length === 2 && path[0] === "models" && path[1] === "context") {
    return { kind: "models-context", path };
  }
  const capability = declared.find(candidate => candidate.command.length === path.length && startsWithPath(candidate.command, path));
  const children = declared.filter(candidate => candidate.command.length > path.length && startsWithPath(candidate.command, path));
  if (capability) return { kind: "capability", path, capability, children };
  if (children.length) return { kind: "prefix", path, children };

  for (let length = Math.min(path.length - 1, MAX_DOCUMENTED_DEPTH); length > 1; length--) {
    const parent = path.slice(0, length);
    if ((length === 2 && parent[0] === "models" && parent[1] === "context")
      || declared.some(candidate => startsWithPath(candidate.command, parent))) {
      return { kind: "unavailable", path, parent };
    }
  }
  return { kind: "unavailable", path, parent: [path[0]] };
}

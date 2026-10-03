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

/** Static declarations describe help coverage, never the runtime's complete grammar. */
export function resolveHelpPath(requested: readonly string[]): HelpResolution {
  const entry = requested[0] ? findCommand(requested[0]) : undefined;
  if (!entry) return { kind: "unavailable", path: [...requested] };
  // Keep exact-name alias entries for root help; nested topics use the owner.
  const canonical = CLI_COMMANDS.find(candidate => candidate.aliases?.includes(requested[0])) ?? entry;
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

  for (let length = path.length - 1; length > 1; length--) {
    const parent = path.slice(0, length);
    if ((length === 2 && parent[0] === "models" && parent[1] === "context")
      || declared.some(candidate => startsWithPath(candidate.command, parent))) {
      return { kind: "unavailable", path, parent };
    }
  }
  return { kind: "unavailable", path, parent: [canonical.name] };
}

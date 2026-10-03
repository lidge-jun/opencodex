import { helpRecoveryCandidates, resolveHelpPath } from "./help-catalog";
import { redactSecretString } from "../lib/redact";

const MAX_TOKEN_LENGTH = 64;
const MAX_PATH_DEPTH = 8;
const MAX_SUGGESTIONS = 3;

function safeToken(value: string | undefined): value is string {
  return value !== undefined && value.length >= 3 && value.length <= MAX_TOKEN_LENGTH
    && /^[a-z][a-z0-9-]*$/i.test(value) && redactSecretString(value) === value;
}

/** Banded edit distance with adjacent transposition, over already bounded tokens. */
function distance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let older = previous;
  for (let i = 1; i <= left.length; i++) {
    const current: number[] = Array(right.length + 1).fill(limit + 1);
    current[0] = i;
    for (let j = Math.max(1, i - limit); j <= Math.min(right.length, i + limit); j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        current[j] = Math.min(current[j], older[j - 2] + 1);
      }
    }
    older = previous;
    previous = current;
  }
  return previous[right.length];
}

/** Return complete help destinations, never user-supplied trailing operands. */
export function suggestHelpPaths(path: readonly string[]): string[][] {
  if (!path.length || path.length > MAX_PATH_DEPTH || !path.every(safeToken)) return [];
  const result = resolveHelpPath(path);
  if (result.kind !== "unavailable") return [];
  const parent = result.parent ?? [];
  const token = path[parent.length].toLowerCase();
  const limit = token.length < 6 ? 1 : 2;
  return helpRecoveryCandidates(parent).map(candidate => ({
    path: candidate.path,
    name: candidate.path.join(" "),
    distance: Math.min(...candidate.names.filter(safeToken).map(name => distance(token, name.toLowerCase(), limit))),
  })).filter(candidate => candidate.distance <= limit)
    .sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_SUGGESTIONS).map(candidate => candidate.path);
}

export function formatHelpRecovery(path: readonly string[]): string {
  const result = resolveHelpPath(path);
  const parent = result.kind === "unavailable" ? result.parent : undefined;
  const lines = [parent ? "Detailed help unavailable for the requested topic."
    : safeToken(path[0]) ? `Unknown command: ${path[0]}` : "Unknown command."];
  const suggestions = suggestHelpPaths(path);
  if (suggestions.length) {
    lines.push("Did you mean:", ...suggestions.map(suggestion => `  ocx help ${suggestion.join(" ")}`));
  }
  lines.push(parent ? `See: ocx help ${parent.join(" ")}` : "See: ocx help --all");
  return lines.join("\n");
}

export function printUnknownCommand(command: string | undefined): void {
  console.error(formatHelpRecovery(command === undefined ? [] : [command]));
}

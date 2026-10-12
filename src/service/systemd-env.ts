type SystemdHomes = { codexHome: string | null; opencodexHome: string | null };
type SystemdHomeParse = { kind: "parsed"; homes: SystemdHomes } | { kind: "invalid" };

/** Inverse of systemd.ts's generated quoted values, without expanding systemd specifiers. */
function decodeQuoted(value: string): string | undefined {
  let decoded = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === "%") {
      if (value[++index] !== "%") return undefined;
      decoded += "%";
    } else if (char === "\\") {
      const escaped = value[++index];
      if (escaped === "n") decoded += "\n";
      else if (escaped === "\\" || escaped === '"') decoded += escaped;
      else return undefined;
    } else if (char === '"' || char === "\0") {
      return undefined;
    } else {
      decoded += char;
    }
  }
  return decoded;
}

/**
 * Missing homes are null; unsupported or ambiguous assignments invalidate the entire definition.
 *
 * A directive name is everything before the first `=`, stripped — systemd matches that
 * name literally and case-sensitively, so only the exact `Environment` can carry the
 * home assignments this parser decodes. Every other name must be a plain
 * non-environment identifier to be skipped: `EnvironmentFile=`, `PassEnvironment=` and
 * `UnsetEnvironment=` mutate the applied environment the same way, an escaped or
 * malformed name cannot be proven inert, and a line ending in an odd number of
 * backslashes continues into the next under systemd's parser rather than standing on
 * its own — all of them invalidate the definition instead of passing over silently.
 */
export function parseSystemdUnitHomes(body: string): SystemdHomeParse {
  const homes: SystemdHomes = { codexHome: null, opencodexHome: null };
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^[#;\[]/.test(line)) continue;
    // systemd folds physical continuations before recognizing directive names. The writer never
    // emits them; accepting individual lines could hide an override or invent a home assignment.
    const trailingBackslashes = /\\+$/.exec(rawLine)?.[0].length ?? 0;
    if (trailingBackslashes % 2 === 1) return { kind: "invalid" };
    const separator = line.indexOf("=");
    const lvalue = (separator === -1 ? line : line.slice(0, separator)).trim();
    if (lvalue !== "Environment") {
      if (!/^[A-Za-z][A-Za-z0-9_.\-]*$/.test(lvalue) || lvalue.includes("Environment")) {
        return { kind: "invalid" };
      }
      continue;
    }
    const directive = /^Environment\s*=\s*(.*)$/.exec(line);
    if (!directive) return { kind: "invalid" };
    const encoded = directive[1]!;
    let assignment: string | undefined;
    if (encoded.startsWith('"') && encoded.endsWith('"')) {
      assignment = decodeQuoted(encoded.slice(1, -1));
    } else if (encoded.length > 0 && !/[\s"'\\%\0]/.test(encoded)) {
      // Older writers emitted one unquoted assignment. Anything needing quoting stays unknown.
      assignment = encoded;
    }
    if (assignment === undefined) return { kind: "invalid" };
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(assignment);
    if (!pair) return { kind: "invalid" };
    const name = pair[1]!;
    if (name !== "CODEX_HOME" && name !== "OPENCODEX_HOME") continue;
    const key = name === "CODEX_HOME" ? "codexHome" : "opencodexHome";
    if (homes[key] !== null || pair[2] === "") return { kind: "invalid" };
    homes[key] = pair[2]!;
  }
  return { kind: "parsed", homes };
}

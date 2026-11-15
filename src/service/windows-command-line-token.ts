// Leaf module: whole-token path matching on a process command line, shared by the guarded
// manager inspection, the checked-stop binding rule and Part B without an import cycle.

/**
 * True when path appears in commandLine as a COMPLETE token — the same boundary
 * rule the windows-service-wrappers kill list uses, ported so the read-only proof
 * cannot accept a substring hit. A quoted path inside an argument string counts;
 * a suffix or prefix glued to it does not.
 */
export function commandLineHasPathToken(commandLine: string | null | undefined, path: string): boolean {
  if (!commandLine || !path) return false;
  const haystack = commandLine.toLowerCase();
  const needle = path.toLowerCase();
  const boundary = (ch: string | undefined): boolean => ch === undefined || /[\s"']/.test(ch);
  let index = 0;
  for (;;) {
    index = haystack.indexOf(needle, index);
    if (index < 0) return false;
    const end = index + needle.length;
    if (boundary(haystack[index - 1]) && boundary(haystack[end])) return true;
    index = end;
  }
}

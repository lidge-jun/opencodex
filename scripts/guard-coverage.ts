/**
 * List the refusals in the voice modules that no `tests/red.ts` guard covers.
 *
 * The Rust sibling of this took six versions to get right, and every flaw was
 * the same kind: a proxy that looked like a measurement. This one starts from
 * the end that worked — a site is covered when a red.ts entry edits the block
 * it lives in, which is evidence, because that entry has been watched to make
 * a named test fail. Everything else is a worklist, not a failure: a site may
 * well be tested without a guard.
 *
 * Carried over from the Rust version, each learned by getting it wrong:
 *   - production files only, or adding tests inflates the denominator
 *   - positional matching, because a guard that removes a *condition* shares
 *     no text with the *message* of the refusal it protects
 *   - an entry that cannot be located is a broken tool, not a clean sheet
 *   - a self-test floor, so the tool fails rather than reporting zero
 *
 * Run: bun scripts/guard-coverage.ts   (without a pipe — a pipe reports its
 * own exit status, and a failure would read as success)
 */

const FILES = [
  "src/server/audio-speech.ts",
  "src/server/audio-transcriptions.ts",
  "src/config/voice-target.ts",
];

type Site = { file: string; line: number; kind: string; text: string };

function refusals(file: string, source: string): Site[] {
  const out: Site[] = [];
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    const next = lines[index + 1] ?? "";
    if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;

    const status = line.match(/formatErrorResponse\(\s*(\d{3})/);
    if (status) {
      const message = (line.match(/"([^"]{6,})"/) ?? next.match(/"([^"]{6,})"/))?.[1];
      out.push({ file, line: index + 1, kind: status[1]!, text: message ?? `HTTP ${status[1]}` });
      return;
    }
    const invalid = line.match(/\binvalid\(\s*[`"]([^`"]{6,})/);
    if (invalid) {
      out.push({ file, line: index + 1, kind: "400", text: invalid[1]! });
      return;
    }
    const configError = line.match(/return\s+`([^`]{10,})`/);
    if (configError) {
      out.push({ file, line: index + 1, kind: "config", text: configError[1]! });
    }
  });
  return out;
}

const redSource = await Bun.file("tests/red.ts").text();

type RedEntry = { file: string; from: string };
const redEntries: RedEntry[] = [];
for (const block of redSource.split(/\n  \{\n/).slice(1)) {
  const file = block.match(/file:\s*"([^"]+)"/)?.[1];
  // The template-literal arm has to skip escaped backticks: a non-greedy
  // `([\s\S]*?)` stops at the first \` inside the entry and truncates it,
  // which showed up as four entries the tool could not locate.
  const from = block.match(
    /from:\s*(?:`((?:[^`\\]|\\.)*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/,
  );
  if (!file || !from) continue;
  const raw = from[1] ?? from[2] ?? from[3] ?? "";
  // One left-to-right pass, not a chain of replaces: chained, `\\b` becomes
  // `\b` and then the next rule reprocesses it. Each escape is consumed once.
  const source = raw.replace(/\\(.)/g, (_, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    return ch; // ` $ " ' \ and anything else stands for itself
  });
  redEntries.push({ file, from: source });
}

/** The guard's own block, by brace matching. A guard that opens no block
 *  covers only its own lines — a fixed line window over-claimed in the Rust
 *  version, scoring a refusal as guarded when nothing guarded it. */
function blockEnd(source: string, at: number, from: string): number {
  let depth = 0;
  let opened = false;
  for (let i = at; i < source.length; i++) {
    const c = source[i];
    if (c === "{") {
      depth++;
      opened = true;
    } else if (c === "}") {
      depth--;
      if (opened && depth <= 0) return i;
    }
  }
  return at + from.length;
}

const covered = new Map<string, Set<number>>();
const unlocated: string[] = [];
for (const entry of redEntries) {
  const source = await Bun.file(entry.file).text().catch(() => "");
  const at = source.indexOf(entry.from);
  if (at === -1) {
    unlocated.push(`${entry.file}: ${entry.from.split("\n")[0]!.trim()}`);
    continue;
  }
  const start = source.slice(0, at).split("\n").length;
  const end = source.slice(0, blockEnd(source, at, entry.from)).split("\n").length;
  if (!covered.has(entry.file)) covered.set(entry.file, new Set());
  const lines = covered.get(entry.file)!;
  for (let line = start; line <= end; line++) lines.add(line);
}

const MUST_PARSE = ["target.model !== undefined", "speechUrl"];
const blind = MUST_PARSE.filter(f => !redEntries.some(e => e.from.includes(f)));
if (blind.length || redEntries.length < 4 || unlocated.length) {
  console.error(`guard-coverage cannot read tests/red.ts: parsed ${redEntries.length} entries` +
    (blind.length ? `, missing ${blind.join(", ")}` : ""));
  for (const entry of unlocated) console.error(`  could not locate  ${entry}`);
  process.exit(2);
}

/**
 * Refusals that belong to the request lifecycle rather than to this branch:
 * the same client-disconnect, draining, timeout and upstream-failure handling
 * every route in the proxy has. Guarding them here would test the framework.
 *
 * Waived with a reason, not hidden — a denominator that mixes these with the
 * branch's own input validation makes the figure read worse than the
 * situation, and worse figures get ignored.
 */
const WAIVED: Record<string, string> = {
  "499": "client disconnect — lifecycle, shared by every route",
  "503": "server draining — lifecycle, shared by every route",
  "408": "request timeout — lifecycle, shared by every route",
  "504": "upstream timeout — lifecycle, shared by every route",
  "502": "upstream failure — lifecycle, shared by every route",
};

const allSites: Site[] = [];
for (const file of FILES) allSites.push(...refusals(file, await Bun.file(file).text()));
const waived = allSites.filter(site => WAIVED[site.kind]);
const sites = allSites.filter(site => !WAIVED[site.kind]);

const uncovered = sites.filter(site => !covered.get(site.file)?.has(site.line));
for (const site of uncovered) {
  console.log(`  ?     ${site.file}:${site.line}  ${site.kind}  ${site.text}`);
}
console.log(
  `\n${sites.length - uncovered.length}/${sites.length} refusal sites have a red.ts guard` +
  `\n${uncovered.length} are a worklist, not a failure — a site may well be tested without one.` +
  `\n${waived.length} waived as request lifecycle (${Object.keys(WAIVED).join(", ")}).`,
);

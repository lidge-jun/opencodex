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
  const from = block.match(/from:\s*(?:`([\s\S]*?)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/);
  if (!file || !from) continue;
  const raw = from[1] ?? from[2] ?? from[3] ?? "";
  redEntries.push({ file, from: raw.replace(/\\n/g, "\n").replace(/\\`/g, "`") });
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

const sites: Site[] = [];
for (const file of FILES) sites.push(...refusals(file, await Bun.file(file).text()));

const uncovered = sites.filter(site => !covered.get(site.file)?.has(site.line));
for (const site of uncovered) {
  console.log(`  ?     ${site.file}:${site.line}  ${site.kind}  ${site.text}`);
}
console.log(
  `\n${sites.length - uncovered.length}/${sites.length} refusal sites have a red.ts guard` +
  `\n${uncovered.length} are a worklist, not a failure — a site may well be tested without one.`,
);

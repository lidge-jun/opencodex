import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { repoPath } from "../helpers/repo-root";

/**
 * The non-English READMEs drift, and until this guard existed nothing noticed.
 * README.md moved seven times after the last translation sync; five of the seven
 * locale files still described a structure the English file had already dropped,
 * and the newest sections - the sponsor table, Docker Compose, /readyz and the
 * memory budget - existed in no translation at all. Review does not catch this:
 * the English diff looks complete on its own.
 *
 * Two independent mechanisms, because either one alone is escapable:
 *
 * - readme/i18n-manifest.json records the README.md hash each locale was synced
 *   against, so a prose rewrite inside a section every locale already has still
 *   fails, naming the lagging locales.
 * - Structural checks compare the section skeleton, shell commands, assets, links
 *   and the language navigation line, so bumping a hash without translating still
 *   fails.
 *
 * Everything is LF-normalized before parsing or hashing. .gitattributes pins
 * eol=lf, but a hash that depends on checkout line endings is a Windows CI
 * failure waiting for the one contributor who overrides it.
 *
 * What this does not do, stated so nobody mistakes it for translation QA: it
 * cannot tell a translated paragraph from the English one copied verbatim, and
 * two locales carrying identical prose both pass. It checks that a locale file
 * has the same shape, the same commands and the same links as the English
 * source, and that somebody touched it when the source moved. Whether the prose
 * is good is a review question.
 */

type LocaleEntry = {
  file: string;
  label: string;
  docsPath: string;
  sourceSha256: string;
};

type Manifest = {
  source: string;
  note?: string;
  locales: Record<string, LocaleEntry>;
};

const FENCE = /^```([A-Za-z0-9_+-]*)\s*$/;
const LOCALE_FILE = /^README\.([A-Za-z-]+)\.md$/;
const ABSOLUTE_URL = /https?:\/\/[^\s"'<>)\]]+/g;
const ASSET_REFERENCE = /(?:src|href)="([^"]*assets\/[^"]+)"/g;
const REPO_RELATIVE_LINK = /\]\(\.\/([^)\s]+)\)/g;
const QUOTED_ARGUMENT = /"[^"\n]*"/g;
const PROSE_INSIDE_QUOTES = /[\s\u0080-\uFFFF]/;
const SPONSOR_MARKER = /<!--\s*sponsors:([a-z-]+)/g;

function readNormalized(relative: string): string {
  return readFileSync(repoPath(relative), "utf8").replace(/\r\n/g, "\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Ordered structural tokens. Heading text is deliberately dropped - it is
 * translated - so only the shape of the document is compared. Fence bodies are
 * skipped so a shell comment is never read as a heading.
 */
function structure(markdown: string): string[] {
  const tokens: string[] = [];
  let insideFence = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    const fence = FENCE.exec(line);
    if (fence) {
      if (insideFence) {
        insideFence = false;
      } else {
        tokens.push(`fence:${fence[1] ?? ""}`);
        insideFence = true;
      }
      continue;
    }
    if (insideFence) continue;
    const heading = /^(#{1,6}) /.exec(line);
    if (heading) {
      tokens.push(`h${(heading[1] ?? "").length}`);
      continue;
    }
    if (line === "<details>") tokens.push("details");
    else if (line === "</details>") tokens.push("/details");
  }
  return tokens;
}

function fencedBlocks(markdown: string): { lang: string; lines: string[] }[] {
  const blocks: { lang: string; lines: string[] }[] = [];
  let open: { lang: string; lines: string[] } | null = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    const fence = FENCE.exec(line);
    if (fence) {
      if (open) {
        blocks.push(open);
        open = null;
      } else {
        open = { lang: fence[1] ?? "", lines: [] };
      }
      continue;
    }
    if (open) open.lines.push(line);
  }
  return blocks;
}

/**
 * The command half of a shell line. Only a comment introduced by a space then a
 * hash is stripped: splitting on a bare hash would truncate
 * openssl rand -hex 32.
 *
 * A double-quoted argument containing a space is prose - the example prompts in
 * the model-routing block are sentences a translator is supposed to translate -
 * so it collapses to a placeholder. A quoted argument without a space is an
 * identifier such as "anthropic/claude-opus-5" and still has to match exactly.
 *
 * Non-ASCII counts as prose too. Japanese and Chinese do not put spaces between
 * words, so a whitespace-only rule reads a translated prompt as an identifier and
 * demands it match the English sentence. Every frozen token here - model ids,
 * flags, paths, URLs - is ASCII, so widening the rule frees nothing that matters.
 *
 * The quoted arguments are matched pairwise and classified in a callback. A
 * single pattern for "quoted text containing a space" does not work: on
 * `codex -m "anthropic/claude-opus-5" "Explain this stack trace"` it matches the
 * gap between the two arguments instead of the prompt.
 */
function commandPart(line: string): string {
  const comment = line.indexOf(" #");
  const command = (comment === -1 ? line : line.slice(0, comment)).trimEnd();
  return command.replace(QUOTED_ARGUMENT, (quoted) =>
    PROSE_INSIDE_QUOTES.test(quoted.slice(1, -1)) ? '"<prose>"' : quoted,
  );
}

function absoluteUrls(markdown: string): string[] {
  return [...markdown.matchAll(ABSOLUTE_URL)].map((match) =>
    match[0].replace(/[.,*)\]]+$/, ""),
  );
}

function assetSuffixes(markdown: string): string[] {
  return [...markdown.matchAll(ASSET_REFERENCE)].map((match) => {
    const value = match[1] ?? "";
    return value.slice(value.indexOf("assets/"));
  });
}

function repoRelativeTargets(markdown: string): string[] {
  return [...markdown.matchAll(REPO_RELATIVE_LINK)].map((match) => match[1] ?? "");
}

function sponsorMarkers(markdown: string): string[] {
  return [...markdown.matchAll(SPONSOR_MARKER)].map((match) => match[1] ?? "");
}

/** The language switcher line, identified by the documentation book glyph. */
function navigationLine(markdown: string, label: string): string {
  const line = markdown.split("\n").find((candidate) => candidate.includes("\u{1F4D6}"));
  if (!line) throw new Error(`${label} has no language navigation line`);
  return line;
}

const english = readNormalized("README.md");
const manifest = JSON.parse(readNormalized("readme/i18n-manifest.json")) as Manifest;
const localeCodes = Object.keys(manifest.locales);

const englishStructure = structure(english);
const englishFences = fencedBlocks(english);
const englishAssets = [...new Set(assetSuffixes(english))];
const englishUrls = [...new Set(absoluteUrls(english))];
const englishRepoLinks = [...new Set(repoRelativeTargets(english))];
const englishSponsorMarkers = sponsorMarkers(english);

describe("README translation parity", () => {
  test("the parsers actually see the English README", () => {
    // Guard against a silently broken parser making every comparison vacuous.
    expect(englishStructure.length).toBeGreaterThanOrEqual(30);
    expect(englishFences.filter((block) => block.lang === "bash").length).toBeGreaterThanOrEqual(8);
    expect(englishAssets.length).toBeGreaterThanOrEqual(5);
    expect(englishRepoLinks.length).toBeGreaterThanOrEqual(5);
    expect(englishSponsorMarkers.length).toBeGreaterThanOrEqual(3);
    expect(englishStructure[0]).toBe("fence:bash");
    // An unclosed fence would make the tokenizer swallow the rest of the file.
    expect(english.split("\n").filter((line) => FENCE.test(line.trimEnd())).length % 2).toBe(0);
  });

  test("the manifest registers exactly the locale files on disk", () => {
    const onDisk = readdirSync(repoPath("readme"))
      .map((name) => LOCALE_FILE.exec(name)?.[1])
      .filter((code): code is string => Boolean(code))
      .sort();
    expect(onDisk).toEqual([...localeCodes].sort());

    const misfiled = localeCodes.filter(
      (code) => manifest.locales[code]?.file !== `readme/README.${code}.md`,
    );
    expect(misfiled).toEqual([]);
  });

  test("the English README links every registered locale", () => {
    const nav = navigationLine(english, "README.md");
    const missing = localeCodes.filter(
      (code) => !nav.includes(`href="readme/README.${code}.md"`),
    );
    expect(missing).toEqual([]);
  });

  test("every locale was synced against the current English README", () => {
    const current = sha256(english);
    const stale = localeCodes
      .filter((code) => manifest.locales[code]?.sourceSha256 !== current)
      .map(
        (code) =>
          `${code} was synced against ${manifest.locales[code]?.sourceSha256}; README.md is now ${current}. Resync readme/README.${code}.md and update readme/i18n-manifest.json in the same commit.`,
      );
    expect(stale).toEqual([]);
  });

  for (const code of localeCodes) {
    const entry = manifest.locales[code] as LocaleEntry;
    const source = readNormalized(entry.file);

    describe(entry.file, () => {
      test("mirrors the English section skeleton", () => {
        const actual = structure(source);
        const problems: string[] = [];
        if (actual.length !== englishStructure.length) {
          problems.push(
            `English has ${englishStructure.length} structural tokens, this file has ${actual.length}`,
          );
        }
        const shared = Math.min(actual.length, englishStructure.length);
        for (let index = 0; index < shared; index += 1) {
          if (actual[index] !== englishStructure[index]) {
            problems.push(
              `first divergence at token ${index}: English has "${englishStructure[index]}", this file has "${actual[index]}"`,
            );
            break;
          }
        }
        expect(problems).toEqual([]);
      });

      test("repeats the English shell commands verbatim", () => {
        const actualFences = fencedBlocks(source);
        const problems: string[] = [];
        englishFences.forEach((block, index) => {
          if (block.lang !== "bash" && block.lang !== "powershell") return;
          const mirrored = actualFences[index];
          if (!mirrored) {
            problems.push(`code block ${index} (${block.lang}) is missing`);
            return;
          }
          block.lines.forEach((line, lineIndex) => {
            const expected = commandPart(line);
            const found = commandPart(mirrored.lines[lineIndex] ?? "");
            if (expected !== found) {
              problems.push(
                `code block ${index} line ${lineIndex + 1}: expected "${expected}", found "${found}"`,
              );
            }
          });
        });
        expect(problems).toEqual([]);
      });

      test("references every English asset", () => {
        const missing = englishAssets.filter((asset) => !source.includes(asset));
        expect(missing).toEqual([]);
      });

      test("carries the sponsor slot markers in order", () => {
        expect(sponsorMarkers(source)).toEqual(englishSponsorMarkers);
      });

      test("keeps every English link", () => {
        const missing = englishUrls.filter((url) => {
          if (url.includes("/assets/")) return false;
          if (url.startsWith("https://opencodex.me/")) {
            // Compare the page, never the fragment. Starlight derives a heading id
            // from the heading TEXT, and the localized pages translate their
            // headings, so #docker-compose exists only on the English page. Pinning
            // the English fragment would have required every locale to ship a link
            // that scrolls nowhere.
            const page = url.split("#")[0] ?? url;
            const localized = page.replace(
              "https://opencodex.me/",
              `https://opencodex.me/${entry.docsPath}/`,
            );
            // The localized form is required: an unprefixed opencodex.me link
            // sends a reader of this file back to the English documentation, and
            // accepting it would also make the bare root URL vacuously present.
            return !source.includes(localized);
          }
          return !source.includes(url);
        });
        expect(missing).toEqual([]);
      });

      test("rewrites repository links one level up", () => {
        const missing = englishRepoLinks.filter(
          (target) => !source.includes(`](../${target})`),
        );
        expect(missing).toEqual([]);
      });

      test("links every sibling language and marks itself", () => {
        const nav = navigationLine(source, entry.file);
        const problems: string[] = [];
        if (!nav.includes('href="../README.md"')) {
          problems.push("no link back to the English README");
        }
        if (!nav.includes(`<b>${entry.label}</b>`)) {
          problems.push(`does not mark itself as <b>${entry.label}</b>`);
        }
        if (nav.includes(`href="README.${code}.md"`)) {
          problems.push("links to itself instead of marking itself");
        }
        for (const other of localeCodes) {
          if (other === code) continue;
          if (!nav.includes(`href="README.${other}.md"`)) {
            problems.push(`missing sibling link README.${other}.md`);
          }
        }
        if (!nav.includes(`https://opencodex.me/${entry.docsPath}/`)) {
          problems.push(
            `documentation link does not point at https://opencodex.me/${entry.docsPath}/`,
          );
        }
        expect(problems).toEqual([]);
      });
    });
  }
});

#!/usr/bin/env bun
/**
 * Pure helpers for GitHub release note assembly.
 * Used by `.github/workflows/release.yml` so stable (latest) releases can carry
 * matching preview changelogs, plus any delta since the last carried preview.
 *
 * CLI:
 *   bun scripts/release-notes.ts strip-carried <body-file>
 *   bun scripts/release-notes.ts matching-preview-tag <version>
 *   bun scripts/release-notes.ts matching-preview-tags <version>
 *   bun scripts/release-notes.ts previous-release-tag <version>
 *   bun scripts/release-notes.ts has-meaningful [body-file]
 *   bun scripts/release-notes.ts credit-takeovers --repo <owner/name> --in <file> --out <file>
 *   bun scripts/release-notes.ts assemble --npm-metadata ... --out ...
 */

type ParsedReleaseTag = {
  major: number;
  minor: number;
  patch: number;
  /** null = stable release; otherwise the SemVer prerelease identifier string. */
  prerelease: string | null;
};

function parseReleaseTag(tag: string): ParsedReleaseTag | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(tag.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** SemVer identifier compare: numeric parts by number; numeric < non-numeric. */
function comparePrereleaseIds(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const ap = aParts[i];
    const bp = bParts[i];
    if (ap === undefined) return -1;
    if (bp === undefined) return 1;
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) {
      const diff = Number(ap) - Number(bp);
      if (diff !== 0) return diff;
      continue;
    }
    if (aNum !== bNum) return aNum ? -1 : 1;
    const cmp = ap.localeCompare(bp);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * Ascending SemVer-aware tag compare. Stable ranks after prereleases with the
 * same core version (`v2.7.42-preview.*` < `v2.7.42`).
 */
export function compareReleaseTags(a: string, b: string): number {
  const pa = parseReleaseTag(a);
  const pb = parseReleaseTag(b);
  if (!pa || !pb) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease === null && pb.prerelease === null) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return comparePrereleaseIds(pa.prerelease, pb.prerelease);
}

function sortVersionTagsAscending(tags: string[]): string[] {
  return [...tags].sort(compareReleaseTags);
}

/** Newest matching preview tag for a stable version, or null. */
export function matchingPreviewTag(version: string, tags: string[]): string | null {
  const matches = matchingPreviewTags(version, tags);
  return matches.length === 0 ? null : matches[matches.length - 1]!;
}

/**
 * All matching preview tags for a stable version, oldest → newest.
 * Each preview's notes are incremental vs the previous preview, so stable
 * releases must aggregate in this order to avoid dropping earlier preview work.
 */
export function matchingPreviewTags(version: string, tags: string[]): string[] {
  if (!version || version.includes("-")) return [];
  const prefix = `v${version}-preview.`;
  const matches = tags
    .map(tag => tag.trim())
    .filter(tag => tag.startsWith(prefix));
  return sortVersionTagsAscending(matches);
}

/**
 * Previous release tag used as the generate-notes / changelog baseline.
 *
 * - Preview releases: newest prior tag of either channel (stable or preview).
 *   Channel-isolated preview→preview baselines skip a shipped stable and restate
 *   that stable's changelog (e.g. 2.7.41-preview → 2.7.43-preview after 2.7.42).
 * - Stable releases: newest prior stable only. Matching preview carry adjusts the
 *   notes range start separately when assembling latest notes.
 */
export function previousReleaseNotesTag(version: string, tags: string[]): string | null {
  if (!version) return null;
  const releaseTag = version.startsWith("v") ? version : `v${version}`;
  const candidates = tags
    .map(tag => tag.trim())
    .filter(tag => /^v\d/.test(tag) && compareReleaseTags(tag, releaseTag) < 0);
  const filtered = version.includes("-preview.")
    ? candidates
    : candidates.filter(tag => !tag.includes("-preview."));
  const sorted = sortVersionTagsAscending(filtered);
  return sorted.length === 0 ? null : sorted[sorted.length - 1]!;
}

/** Drop npm blurb, Commits section, and Full Changelog link from a prior release body. */
export function stripCarriedReleaseNotes(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let inCommits = false;

  for (const line of lines) {
    if (/^Published to npm as /.test(line)) continue;
    if (/^\*\*Full Changelog\*\*:/.test(line)) continue;
    if (/^## Commits\s*$/.test(line)) {
      inCommits = true;
      continue;
    }
    if (inCommits) {
      if (/^## /.test(line)) {
        inCommits = false;
      } else {
        continue;
      }
    }
    kept.push(line);
  }

  return kept.join("\n").replace(/^\n+/, "").replace(/\n+$/, "").trim();
}

/** Drop generate-notes trailing compare link (workflow re-appends its own). */
export function stripGenerateNotesCompareLink(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(line => !/^\*\*Full Changelog\*\*:/.test(line))
    .join("\n")
    .replace(/\n+$/, "")
    .trim();
}

/** True when generate-notes returned only the config comment / blank lines. */
export function isEmptyGeneratedNotes(body: string): boolean {
  const withoutComment = stripGenerateNotesCompareLink(body)
    .split("\n")
    .filter(line => !/^<!--.*-->$/.test(line.trim()))
    .join("\n");
  return !hasNonWhitespace(withoutComment);
}

/**
 * True when stripped carried notes contain a usable changelog (not blank /
 * comment-only). Commits-only preview releases strip down to empty and must not
 * move the stable notes baseline.
 */
export function hasMeaningfulCarriedNotes(stripped: string): boolean {
  return !isEmptyGeneratedNotes(stripped);
}

export function hasNonWhitespace(text: string): boolean {
  return text.replace(/\s+/g, "").length > 0;
}

/** Join multiple stripped preview bodies in chronological order. */
export function joinCarriedPreviewNotes(parts: string[]): string {
  return parts
    .map(part => part.trim())
    .filter(part => hasMeaningfulCarriedNotes(part))
    .join("\n\n")
    .trim();
}

/**
 * Newest preview tag whose GitHub Release body strips to a meaningful changelog.
 * Missing releases (`releaseBody === null`) and empty/commits-only bodies must not
 * advance the baseline — otherwise a later empty preview.2 would hide the
 * preview.1→preview.2 gap from both carried notes and the generated delta.
 */
export function selectNewestCarriedPreviewTag(
  entries: Array<{ tag: string; releaseBody: string | null }>,
): string | null {
  let newest: string | null = null;
  for (const entry of entries) {
    if (entry.releaseBody === null) continue;
    const stripped = stripCarriedReleaseNotes(entry.releaseBody);
    if (hasMeaningfulCarriedNotes(stripped)) newest = entry.tag;
  }
  return newest;
}

/**
 * Parse a maintainer-takeover source PR number from title/body text.
 * Matches forms already used in-repo: `takeover of #N`, `takeover #N`,
 * `maintainer takeover of #N` (case-insensitive).
 */
export function parseTakeoverSourcePr(title: string, body = ""): number | null {
  const text = `${title}\n${body}`;
  const match = /\b(?:maintainer\s+)?takeover(?:\s+of)?\s+#(\d+)\b/i.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const GENERATE_NOTES_PR_LINE =
  /^(?<prefix>\* .+? by @)(?<author>[A-Za-z0-9-]+)(?<mid> in https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/)(?<pr>\d+)(?<suffix>\s*)$/;

export type TakeoverCreditLookup = {
  title: string;
  body: string;
  authorLogin: string;
};

/**
 * Rewrite generate-notes lines so maintainer-takeover PRs also credit the
 * original PR creator: `by @Original (takeover by @Landing) in …/pull/P`.
 *
 * Prefer the takeover marker already present in the notes-line title (cheap,
 * no landing lookup). Fall back to `resolveLanding` only when the title
 * mentions "takeover" but does not match a known `#N` form, so body text can
 * still supply the source. Ordinary non-takeover lines never call either
 * resolver.
 */
export async function rewriteTakeoverCredits(
  notesBody: string,
  resolveLanding: (prNumber: number) => Promise<TakeoverCreditLookup | null>,
  resolveOriginalAuthor: (sourcePrNumber: number) => Promise<string | null>,
): Promise<string> {
  const lines = notesBody.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const match = GENERATE_NOTES_PR_LINE.exec(line);
    if (!match?.groups) {
      out.push(line);
      continue;
    }
    const landingPr = Number(match.groups.pr);
    const landingAuthor = match.groups.author!;
    const titleHint = match.groups.prefix
      .replace(/^\* /, "")
      .replace(/ by @$/, "");
    let sourcePr = parseTakeoverSourcePr(titleHint);
    if (sourcePr == null) {
      if (!/\btakeover\b/i.test(titleHint)) {
        out.push(line);
        continue;
      }
      const landing = await resolveLanding(landingPr);
      if (!landing) {
        out.push(line);
        continue;
      }
      sourcePr = parseTakeoverSourcePr(landing.title, landing.body);
      if (sourcePr == null) {
        out.push(line);
        continue;
      }
    }
    const original = await resolveOriginalAuthor(sourcePr);
    if (!original || original.toLowerCase() === landingAuthor.toLowerCase()) {
      out.push(line);
      continue;
    }
    out.push(
      `${match.groups.prefix}${original} (takeover by @${landingAuthor})${match.groups.mid}${match.groups.pr}${match.groups.suffix ?? ""}`,
    );
  }
  return out.join("\n");
}

export function assembleReleaseNotes(input: {
  npmMetadata: string;
  carriedPreviewNotes?: string;
  deltaPrNotes?: string;
  commits?: string;
  compareFrom?: string | null;
  compareTo?: string;
  repository?: string;
}): string {
  const parts: string[] = [];
  parts.push(input.npmMetadata.trim());

  const carried = (input.carriedPreviewNotes ?? "").trim();
  if (hasNonWhitespace(carried)) {
    parts.push(carried);
  }

  const deltaRaw = (input.deltaPrNotes ?? "").trim();
  const delta = isEmptyGeneratedNotes(deltaRaw) ? "" : stripGenerateNotesCompareLink(deltaRaw);
  if (hasNonWhitespace(delta)) {
    if (hasNonWhitespace(carried)) {
      parts.push("## Since preview\n\n" + delta);
    } else {
      parts.push(delta);
    }
  }

  const commits = (input.commits ?? "").trim();
  if (commits) {
    parts.push("## Commits\n\n" + commits);
  }

  const from = input.compareFrom?.trim();
  const to = input.compareTo?.trim();
  const repo = input.repository?.trim();
  if (from && to && repo) {
    parts.push(`**Full Changelog**: https://github.com/${repo}/compare/${from}...${to}`);
  }

  return parts.join("\n\n").replace(/\n+$/, "") + "\n";
}

async function readStdinOrFile(path: string | undefined): Promise<string> {
  if (path && path !== "-") {
    return await Bun.file(path).text();
  }
  return await new Response(Bun.stdin).text();
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === "strip-carried") {
    const stripped = stripCarriedReleaseNotes(await readStdinOrFile(rest[0]));
    process.stdout.write(stripped.endsWith("\n") ? stripped : stripped + "\n");
    return;
  }

  if (cmd === "has-meaningful") {
    const stripped = (await readStdinOrFile(rest[0])).trim();
    process.exit(hasMeaningfulCarriedNotes(stripped) ? 0 : 1);
  }

  if (cmd === "join-carried") {
    let out: string | undefined;
    const files: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === "--out") {
        const value = rest[i + 1];
        if (!value || value.startsWith("--")) {
          console.error("Missing value for --out");
          process.exit(1);
        }
        out = value;
        i += 1;
        continue;
      }
      if (arg?.startsWith("--")) {
        console.error(`Unknown flag: ${arg}`);
        process.exit(1);
      }
      if (arg) files.push(arg);
    }
    if (!out || files.length === 0) {
      console.error("Usage: bun scripts/release-notes.ts join-carried --out <file> <part-file>...");
      process.exit(1);
    }
    const parts = await Promise.all(files.map(path => Bun.file(path).text()));
    const joined = joinCarriedPreviewNotes(parts);
    await Bun.write(out, joined ? joined + "\n" : "");
    return;
  }

  if (cmd === "matching-preview-tag" || cmd === "matching-preview-tags" || cmd === "previous-release-tag") {
    const version = rest[0];
    if (!version) {
      console.error(`Usage: bun scripts/release-notes.ts ${cmd} <version>`);
      process.exit(1);
    }
    const tagsText = await new Response(Bun.stdin).text();
    const tags = tagsText.split(/\r?\n/);
    if (cmd === "matching-preview-tag") {
      const tag = matchingPreviewTag(version, tags);
      if (tag) process.stdout.write(tag + "\n");
      return;
    }
    if (cmd === "previous-release-tag") {
      const tag = previousReleaseNotesTag(version, tags);
      if (tag) process.stdout.write(tag + "\n");
      return;
    }
    for (const tag of matchingPreviewTags(version, tags)) {
      process.stdout.write(tag + "\n");
    }
    return;
  }

  if (cmd === "credit-takeovers") {
    const args = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 1) {
      const key = rest[i];
      if (!key?.startsWith("--")) continue;
      const value = rest[i + 1];
      if (!value || value.startsWith("--")) {
        console.error(`Missing value for ${key}`);
        process.exit(1);
      }
      args.set(key.slice(2), value);
      i += 1;
    }
    const repo = args.get("repo");
    const inputPath = args.get("in");
    const outPath = args.get("out");
    if (!repo || !inputPath || !outPath) {
      console.error("Usage: bun scripts/release-notes.ts credit-takeovers --repo <owner/name> --in <file> --out <file>");
      process.exit(1);
    }
    const [owner, name] = repo.split("/");
    if (!owner || !name || repo.split("/").length !== 2) {
      console.error(`Invalid --repo value: ${repo}`);
      process.exit(1);
    }

    async function ghJson(
      path: string,
      options: { allowNotFound?: boolean } = {},
    ): Promise<unknown | null> {
      const proc = Bun.spawn(["gh", "api", path], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        const detail = stderr.trim() || `exit ${exitCode}`;
        const notFound =
          /\b404\b/i.test(detail) ||
          /\bNot Found\b/i.test(detail) ||
          /\bHTTP\s+404\b/i.test(detail);
        if (options.allowNotFound && notFound) {
          return null;
        }
        console.error(`gh api ${path} failed: ${detail}`);
        process.exit(1);
      }
      try {
        return JSON.parse(stdout) as unknown;
      } catch {
        console.error(`gh api ${path} returned non-JSON`);
        process.exit(1);
      }
    }

    const body = await Bun.file(inputPath).text();
    const rewritten = await rewriteTakeoverCredits(
      body,
      async (prNumber) => {
        const data = await ghJson(`repos/${owner}/${name}/pulls/${prNumber}`, {
          allowNotFound: true,
        });
        if (data === null) return null;
        if (!data || typeof data !== "object") {
          console.error(`Landing PR #${prNumber} lookup returned no object`);
          process.exit(1);
        }
        const pr = data as { title?: unknown; body?: unknown; user?: { login?: unknown } };
        if (typeof pr.title !== "string" || typeof pr.user?.login !== "string") {
          console.error(`Landing PR #${prNumber} is missing title or author login`);
          process.exit(1);
        }
        return {
          title: pr.title,
          body: typeof pr.body === "string" ? pr.body : "",
          authorLogin: pr.user.login,
        };
      },
      async (sourcePrNumber) => {
        // Missing landing/source PRs leave the line unchanged; other lookup failures abort.
        const data = await ghJson(`repos/${owner}/${name}/pulls/${sourcePrNumber}`, {
          allowNotFound: true,
        });
        if (data === null) return null;
        if (typeof data !== "object") {
          console.error(`Source PR #${sourcePrNumber} lookup returned no object`);
          process.exit(1);
        }
        const pr = data as { user?: { login?: unknown } };
        if (typeof pr.user?.login !== "string") {
          console.error(`Source PR #${sourcePrNumber} is missing author login`);
          process.exit(1);
        }
        return pr.user.login;
      },
    );
    await Bun.write(outPath, rewritten.endsWith("\n") ? rewritten : rewritten + "\n");
    return;
  }

  if (cmd === "assemble") {
    const args = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 1) {
      const key = rest[i];
      if (!key?.startsWith("--")) continue;
      const value = rest[i + 1];
      if (!value || value.startsWith("--")) {
        console.error(`Missing value for ${key}`);
        process.exit(1);
      }
      args.set(key.slice(2), value);
      i += 1;
    }

    const npmMetadata = args.get("npm-metadata");
    const out = args.get("out");
    if (!npmMetadata || !out) {
      console.error("Usage: bun scripts/release-notes.ts assemble --npm-metadata <text> --out <file> [--carried <file>] [--delta <file>] [--commits <file>] [--compare-from <tag>] [--compare-to <tag>] [--repository <owner/name>]");
      process.exit(1);
    }

    const readOptional = async (name: string): Promise<string> => {
      const path = args.get(name);
      if (!path) return "";
      return await Bun.file(path).text();
    };

    const notes = assembleReleaseNotes({
      npmMetadata,
      carriedPreviewNotes: await readOptional("carried"),
      deltaPrNotes: await readOptional("delta"),
      commits: await readOptional("commits"),
      compareFrom: args.get("compare-from") ?? null,
      compareTo: args.get("compare-to"),
      repository: args.get("repository"),
    });
    await Bun.write(out, notes);
    return;
  }

  console.error(`Unknown command: ${cmd ?? "(none)"}
Usage:
  bun scripts/release-notes.ts strip-carried [body-file]
  bun scripts/release-notes.ts has-meaningful [body-file]
  bun scripts/release-notes.ts join-carried --out <file> <part-file>...
  bun scripts/release-notes.ts matching-preview-tag <version>   # tags on stdin
  bun scripts/release-notes.ts matching-preview-tags <version>  # tags on stdin, oldest→newest
  bun scripts/release-notes.ts previous-release-tag <version>   # tags on stdin
  bun scripts/release-notes.ts credit-takeovers --repo <owner/name> --in <file> --out <file>
  bun scripts/release-notes.ts assemble --npm-metadata ... --out ...`);
  process.exit(1);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

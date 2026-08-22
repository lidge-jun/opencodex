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
 *   bun scripts/release-notes.ts commit-fallback [commit-log-file]
 *   bun scripts/release-notes.ts credit-takeovers --repo <owner/name> --in <file> --out <file>
 *   bun scripts/release-notes.ts render --npm-metadata ... --out ... [--carried ...] [--delta ...] [--compare-from ...] [--compare-to ...] [--repository ...]
 *   bun scripts/release-notes.ts polish --in <file> --out <file> [--model ...] [--base-url ...]
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
 *
 * Callers must pass the FULL repo tag set, not `git tag --merged HEAD`. Stable
 * tags live on main's lineage, which the preview branch does not carry, and a
 * trailing same-core preview (vX.Y.Z-preview.* shipped after vX.Y.Z) must not
 * hide the stable: for `2.10.0-preview.*` after `v2.9.1` + `v2.9.1-preview.*`,
 * the baseline must be `v2.9.1`, not the trailing preview. Semver ordering
 * already ranks the stable above its own trailing preview, so the full set is
 * sufficient; restricting to merged tags is what reintroduces the bug.
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

/** True when generate-notes returned only the config comment / blank lines. */
export function isEmptyGeneratedNotes(body: string): boolean {
  const withoutComment = body
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .split("\n")
    .filter(line => !/^\*\*Full Changelog\*\*:/.test(line))
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

/**
 * A single commit considered for the commit-based changelog fallback.
 * `sha` is the full or short hash; `subject` is the commit subject line.
 */
export type ReleaseNoteCommit = {
  sha: string;
  subject: string;
  author: string;
};

/** Category order shared by the PR renderer and the commit fallback. */
const RENDER_CATEGORY_ORDER = ["New Features", "Bug Fixes", "Documentation", "Chores", "Other Changes"];

/** Conventional-commit type -> release.yml category title. */
const COMMIT_TYPE_CATEGORY: Record<string, string> = {
  feat: "New Features",
  fix: "Bug Fixes",
  perf: "Bug Fixes",
  docs: "Documentation",
  chore: "Chores",
  build: "Chores",
  ci: "Chores",
  refactor: "Chores",
  style: "Chores",
  test: "Chores",
};

/**
 * Commits that are release plumbing rather than shipped work. A merge commit's
 * content is already represented by the commits it brings in, and a `release:`
 * bump is the release itself.
 */
export function isReleasePlumbingCommit(subject: string): boolean {
  const text = subject.trim();
  if (/^Merge\s/i.test(text)) return true;
  // Real two-parent merges in this repo also use a `merge:` conventional prefix.
  if (/^merge(?:\([^)]*\))?!?:\s/i.test(text)) return true;
  if (/^release(?:\([^)]*\))?!?:\s/i.test(text)) return true;
  return false;
}

/**
 * Neutralize Markdown and mention syntax from untrusted commit text before it
 * lands in a release body. Commit subjects and author names are attacker- or
 * accident-controlled: a bare `@name` renders as a real GitHub mention (and
 * notifies that account), and backticks/brackets can restructure the notes.
 */
export function sanitizeCommitText(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    // Strip the ASCII unit separator so a subject can never forge a log field.
    .replace(/[\u0000\u001f]/g, " ")
    // Escape rather than delete: `Map<K, V> | CLI` must stay readable.
    .replace(/([`<>|[\]\\])/g, "\\$1")
    // `@name` -> `@\u200bname`: reads identically, never notifies.
    .replace(/@(?=[A-Za-z0-9_-])/g, "@\u200b")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Render commits as a generate-notes-shaped body so the existing category
 * parser/renderer can consume them unchanged.
 *
 * Why this exists: `releases/generate-notes` aggregates MERGED PULL REQUESTS
 * against the compared tag range. When work lands as direct commits on the
 * integration branch (or through PRs whose base is `dev` rather than the
 * release branch), that range contains no PRs the API will count and the body
 * collapses to the npm line plus a compare link — v2.17.0..v2.18.2 had 0 of 36
 * commits associated with a main-merged PR, and both releases shipped an empty
 * changelog. The fallback keeps the release body honest regardless of how the
 * work reached the branch.
 *
 * Commits carry no PR number, so the synthetic entries use `#0` — a sentinel
 * the renderer never prints as a link because these are emitted as plain
 * bullets under their category heading.
 */
export function renderCommitFallbackNotes(commits: ReleaseNoteCommit[]): string {
  const buckets = new Map<string, string[]>();
  for (const commit of commits) {
    const subject = commit.subject.trim();
    if (!subject) continue;
    if (isReleasePlumbingCommit(subject)) continue;
    const match = /^([a-zA-Z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(subject);
    const type = match?.[1]?.toLowerCase();
    const scope = sanitizeCommitText(match?.[2] ?? "");
    const summary = sanitizeCommitText(match?.[3] ?? subject);
    if (!summary) continue;
    const category = (type && COMMIT_TYPE_CATEGORY[type]) ?? "Other Changes";
    // Hex-only short hash: a crafted `sha` field can never inject markup.
    const shortSha = /^[0-9a-f]{7,40}$/i.test(commit.sha.trim())
      ? commit.sha.trim().slice(0, 9)
      : "";
    const scopePrefix = scope ? `${scope}: ` : "";
    // `%an` is a free-form Git display name, not a GitHub login, so it is
    // rendered as plain text rather than an @mention that would notify a
    // same-named (or non-existent) account.
    const author = sanitizeCommitText(commit.author).replace(/^@\u200b/, "");
    const trailer = [shortSha, author].filter(Boolean).join(", ");
    const line = trailer ? `- ${scopePrefix}${summary} (${trailer})` : `- ${scopePrefix}${summary}`;
    const existing = buckets.get(category);
    if (existing) existing.push(line);
    else buckets.set(category, [line]);
  }
  if (buckets.size === 0) return "";
  const parts: string[] = [];
  for (const title of RENDER_CATEGORY_ORDER) {
    const lines = buckets.get(title);
    if (!lines || lines.length === 0) continue;
    parts.push([`## ${title}`, "", ...lines].join("\n"));
  }
  return parts.join("\n\n").replace(/\n+$/, "") + "\n";
}

/**
 * Extract commit-style category sections (bullets with no `(#N)` reference)
 * from an already-rendered body.
 *
 * A preview release whose notes came from the commit fallback carries bullets
 * like `- gui: fix a thing (abc1234, Name)`. Those are meaningful prose, so the
 * workflow keeps them as carried notes and skips regenerating a fallback — but
 * the PR renderer only retains entries carrying a PR number, so without this
 * the stable release would silently collapse back to the npm-line stub.
 */
export function extractCommitBulletSections(body: string): string {
  const out: string[] = [];
  let current: { title: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (current && current.lines.length > 0) {
      out.push([`## ${current.title}`, "", ...current.lines].join("\n"));
    }
    current = null;
  };
  for (const rawLine of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("<!--")) continue;
    if (line.startsWith("## ") || line.startsWith("### ")) {
      flush();
      const title = line.replace(/^#{2,3}\s+/, "").trim();
      if (!SCAFFOLD_HEADINGS.has(title)) current = { title, lines: [] };
      continue;
    }
    if (!current) continue;
    if (!line.startsWith("- ")) continue;
    // Anything carrying a PR reference belongs to the PR pipeline, not here.
    if (/\(#\d+(?:\s*,\s*#\d+)*\)\s*$/.test(line)) continue;
    if (/^-\s+#\d+\s/.test(line)) continue;
    current.lines.push(line);
  }
  flush();
  return out.join("\n\n").replace(/\n+$/, "") + (out.length > 0 ? "\n" : "");
}

/**
 * Merge several already-rendered commit-bullet bodies into one set of category
 * sections, preserving order within a category and de-duplicating identical
 * bullets. Concatenating the bodies directly would repeat a shared heading.
 */
export function mergeCommitBulletSections(bodies: string[]): string {
  const buckets = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const body of bodies) {
    let current: string | null = null;
    for (const rawLine of (body ?? "").replace(/\r\n/g, "\n").split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("## ") || line.startsWith("### ")) {
        current = line.replace(/^#{2,3}\s+/, "").trim();
        if (!buckets.has(current)) buckets.set(current, []);
        continue;
      }
      if (!current || !line.startsWith("- ")) continue;
      const key = `${current}\u0000${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      buckets.get(current)!.push(line);
    }
  }
  const titles = [...buckets.keys()].sort((x, y) => {
    const ix = RENDER_CATEGORY_ORDER.indexOf(x);
    const iy = RENDER_CATEGORY_ORDER.indexOf(y);
    const rx = ix === -1 ? RENDER_CATEGORY_ORDER.length : ix;
    const ry = iy === -1 ? RENDER_CATEGORY_ORDER.length : iy;
    return rx - ry;
  });
  const merged: string[] = [];
  for (const title of titles) {
    const lines = buckets.get(title)!;
    if (lines.length === 0) continue;
    merged.push([`## ${title}`, "", ...lines].join("\n"));
  }
  return merged.join("\n\n").trim();
}

/**
 * Parse `git log -z --format=%H%x00%s%x00%an` output into commits.
 *
 * Records and fields are NUL-separated. Git forbids NUL in commit content, so
 * — unlike the unit separator, which Git accepts in both subjects and author
 * names — no field value can forge a boundary. Every record is read as exactly
 * three fields.
 */
export function parseCommitLog(raw: string): ReleaseNoteCommit[] {
  const commits: ReleaseNoteCommit[] = [];
  const fields = raw.split("\u0000");
  // Trailing separator from `git log -z` leaves an empty final element.
  if (fields.length > 0 && fields[fields.length - 1]!.trim() === "") fields.pop();
  for (let i = 0; i + 2 < fields.length + 1; i += 3) {
    const sha = (fields[i] ?? "").replace(/^\n+/, "").trim();
    const subject = fields[i + 1] ?? "";
    const author = fields[i + 2] ?? "";
    if (!sha || !subject.trim()) continue;
    commits.push({ sha, subject, author });
  }
  return commits;
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
  /^(?<prefix>\* .+? by @)(?<author>[A-Za-z0-9-]+(?:\[bot\])?)(?<mid> in https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/)(?<pr>\d+)(?<suffix>\s*)$/;

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

export type ReleaseNotePr = {
  number: number;
  title: string;
  author: string;
};

export type ReleaseNoteCategory = {
  title: string;
  prs: ReleaseNotePr[];
};

/**
 * Parse GitHub generate-notes output (`* <title> by @<author> in …/pull/<N>`,
 * including maintainer-takeover lines rewritten by `credit-takeovers`) into
 * category sections. Also understands the renderer's own output (`## <Category>`
 * sections with `- … (#N)` bullets and a `## Changelog` list of
 * `- #N <title> @author` lines), so already-rendered preview bodies carry into
 * stable notes losslessly. Scaffolding (`## What's Changed`, `## New
 * Contributors`, `## Commits`) never reaches the renderer. Changelog lines
 * supply the authoritative title/author for PRs first seen in bullets.
 */
const GENERATED_PR_LINE =
  /^\*\s*(?<title>.+?)\s+by\s+@(?<author>[A-Za-z0-9-]+(?:\[bot\])?)(?:\s+\(takeover\s+by\s+@[A-Za-z0-9-]+(?:\[bot\])?\))?\s+in\s+https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(?<pr>\d+)\s*$/;
const GENERATED_BULLET_LINE =
  /^-\s+(?<text>.+?)\s+\((?<refs>#\d+(?:\s*,\s*#\d+)*)\)\s*$/;
const CHANGELOG_PR_LINE =
  /^-\s+#(?<pr>\d+)\s+(?<title>.+?)\s+@(?<author>[A-Za-z0-9-]+(?:\[bot\])?)\s*$/;
const SCAFFOLD_HEADINGS = new Set(["What's Changed", "New Contributors", "Commits", "Changelog", "Since preview"]);

export function parseGeneratedNotes(body: string): ReleaseNoteCategory[] {
  const sections: ReleaseNoteCategory[] = [];
  const globalPrs = new Map<number, ReleaseNotePr>();
  let current: ReleaseNoteCategory | null = null;
  for (const rawLine of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("<!--")) continue;
    if (line.startsWith("### ")) {
      const title = line.slice(4).trim();
      current = { title, prs: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith("## ")) {
      const title = line.slice(3).trim();
      if (SCAFFOLD_HEADINGS.has(title)) {
        current = null;
      } else {
        current = { title, prs: [] };
        sections.push(current);
      }
      continue;
    }
    const changelogLine = CHANGELOG_PR_LINE.exec(line);
    if (changelogLine?.groups) {
      globalPrs.set(Number(changelogLine.groups.pr), {
        number: Number(changelogLine.groups.pr),
        title: changelogLine.groups.title!,
        author: changelogLine.groups.author!,
      });
      continue;
    }
    if (!current) continue;
    const match = GENERATED_PR_LINE.exec(line);
    if (match?.groups) {
      current.prs.push({
        number: Number(match.groups.pr),
        title: match.groups.title!,
        author: match.groups.author!,
      });
      continue;
    }
    const bullet = GENERATED_BULLET_LINE.exec(line);
    if (bullet?.groups) {
      const text = bullet.groups.text!;
      for (const ref of bullet.groups.refs!.matchAll(/#(\d+)/g)) {
        current.prs.push({ number: Number(ref[1]), title: text, author: "" });
      }
    }
  }
  for (const section of sections) {
    section.prs = section.prs.map(pr => globalPrs.get(pr.number) ?? pr);
  }
  return sections;
}

/**
 * Strip a conventional-commit prefix (`feat(scope): …`, `fix: …`, …) and a
 * trailing `(#N)` that repeats the PR's own number, then sentence-case the
 * remaining title for the curated section bullets.
 */
const CONVENTIONAL_COMMIT_PREFIX =
  /^(?:feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert|merge|release)(?:\(([^)]+)\))?:\s*(.+)$/i;

export function cleanPrTitle(title: string, prNumber: number | null = null): { scope: string | null; text: string } {
  let text = title.trim();
  let scope: string | null = null;
  const prefix = CONVENTIONAL_COMMIT_PREFIX.exec(text);
  if (prefix) {
    scope = prefix[1] ?? null;
    text = prefix[2]!.trim();
  }
  if (prNumber !== null) {
    const selfRef = `(#${prNumber})`;
    const trimmed = text.trimEnd();
    if (trimmed.endsWith(selfRef)) {
      text = trimmed.slice(0, -selfRef.length);
    }
  }
  text = text.trim();
  if (text.length > 0) {
    text = text[0]!.toUpperCase() + text.slice(1);
  }
  return { scope, text };
}

/** "release-notes" → "Release-Notes" for group-bullet scope labels. */
export function scopeLabel(scope: string): string {
  return scope
    .split("-")
    .map(part => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join("-");
}

/** Group PRs by conventional-commit scope, preserving first-appearance order. */
export function groupPrsByScope(prs: ReleaseNotePr[]): Array<{ scope: string | null; prs: ReleaseNotePr[] }> {
  const groups: Array<{ scope: string | null; prs: ReleaseNotePr[] }> = [];
  for (const pr of prs) {
    const { scope } = cleanPrTitle(pr.title, pr.number);
    const group = groups.find(candidate => candidate.scope === scope);
    if (group) {
      group.prs.push(pr);
    } else {
      groups.push({ scope, prs: [pr] });
    }
  }
  return groups;
}

/**
 * Render OpenAI-Codex-style release notes from the generate-notes pieces:
 * H2 category sections with scope-grouped, prefix-free summary bullets, then a
 * `## Changelog` section with every PR (`- #N <title> @author`) and the compare
 * link. Carried preview notes and the since-preview delta merge by category;
 * duplicate PR numbers (defensive; ranges are normally disjoint) keep the
 * first occurrence.
 */
export function renderReleaseNotes(input: {
  npmMetadata: string;
  carriedPreviewNotes?: string;
  deltaPrNotes?: string;
  /**
   * Pre-rendered category sections for commit-based entries (no PR numbers).
   * Used only when the PR pipeline yields nothing, so a release body can never
   * collapse to the npm line plus a compare link.
   */
  commitFallbackNotes?: string;
  compareFrom?: string | null;
  compareTo?: string;
  repository?: string;
}): string {
  const categories = new Map<string, ReleaseNotePr[]>();
  const order: string[] = [];
  const claimed = new Set<number>();
  const add = (body: string): void => {
    for (const section of parseGeneratedNotes(body)) {
      const existing = categories.get(section.title);
      if (!existing) {
        categories.set(section.title, []);
        order.push(section.title);
      }
      for (const pr of section.prs) {
        if (claimed.has(pr.number)) continue;
        claimed.add(pr.number);
        categories.get(section.title)!.push(pr);
      }
    }
  };
  add(input.carriedPreviewNotes ?? "");
  add(input.deltaPrNotes ?? "");

  const parts: string[] = [];
  const npmMetadata = input.npmMetadata.trim();
  if (npmMetadata) parts.push(npmMetadata);

  const sortedOrder = [...order].sort((a, b) => {
    const ia = RENDER_CATEGORY_ORDER.indexOf(a);
    const ib = RENDER_CATEGORY_ORDER.indexOf(b);
    const rankA = ia === -1 ? RENDER_CATEGORY_ORDER.length : ia;
    const rankB = ib === -1 ? RENDER_CATEGORY_ORDER.length : ib;
    if (rankA !== rankB) return rankA - rankB;
    return order.indexOf(a) - order.indexOf(b);
  });

  for (const title of sortedOrder) {
    const prs = categories.get(title)!;
    if (prs.length === 0) continue;
    const lines: string[] = [`## ${title}`, ""];
    for (const group of groupPrsByScope(prs)) {
      if (group.prs.length === 1) {
        const pr = group.prs[0]!;
        lines.push(`- ${cleanPrTitle(pr.title, pr.number).text} (#${pr.number})`);
      } else {
        const label = group.scope ? scopeLabel(group.scope) : null;
        const texts = group.prs.map(pr => cleanPrTitle(pr.title, pr.number).text);
        const refs = group.prs.map(pr => `#${pr.number}`).join(", ");
        lines.push(`- ${label ? `${label}: ` : ""}${texts.join("; ")} (${refs})`);
      }
    }
    parts.push(lines.join("\n"));
  }

  // Commit fallback: only when the PR pipeline produced no category content at
  // all. Its sections are already rendered, so they are appended verbatim.
  const renderedAnyPrSection = parts.length > (npmMetadata ? 1 : 0);
  if (!renderedAnyPrSection) {
    // Carried commit bullets first (older preview work), then this range's own.
    // They are merged BY CATEGORY: concatenating two rendered bodies would emit
    // `## Bug Fixes` twice when both halves touched the same category.
    const merged = mergeCommitBulletSections([
      extractCommitBulletSections(input.carriedPreviewNotes ?? ""),
      input.commitFallbackNotes ?? "",
    ]);
    if (merged) parts.push(merged);
  }

  const allPrs = [...categories.values()].flat().sort((a, b) => a.number - b.number);
  const from = input.compareFrom?.trim();
  const to = input.compareTo?.trim();
  const repo = input.repository?.trim();
  const hasCompare = Boolean(from && to && repo);
  if (allPrs.length > 0 || hasCompare) {
    const changelog: string[] = ["## Changelog", ""];
    if (hasCompare) {
      changelog.push(`Full Changelog: https://github.com/${repo}/compare/${from}...${to}`, "");
    }
    for (const pr of allPrs) {
      changelog.push(`- #${pr.number} ${pr.title.trim()} @${pr.author}`);
    }
    parts.push(changelog.join("\n"));
  }

  if (parts.length === 0) return "";
  return parts.join("\n\n").replace(/\n+$/, "") + "\n";
}

/** Every `#N` reference in a text, deduplicated and ascending. */
export function extractPrNumbers(text: string): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(/#(\d+)/g)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

/**
 * The leading `#N` identifier of every `- #N <title> @author` changelog entry.
 * Used as the polish validation baseline so incidental PR references inside
 * titles (e.g. a takeover line mentioning `#424`) never become mandatory.
 */
export function extractChangelogPrNumbers(changelog: string): number[] {
  const numbers = new Set<number>();
  for (const rawLine of changelog.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^-\s+#(\d+)\s+/.exec(rawLine.trim());
    if (match) numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Occurrence counts of every `#N` reference in a text. */
function countPrNumbers(text: string): Map<number, number> {
  const counts = new Map<number, number>();
  for (const match of text.matchAll(/#(\d+)/g)) {
    const number = Number(match[1]);
    counts.set(number, (counts.get(number) ?? 0) + 1);
  }
  return counts;
}

/** H2 headings in a section, excluding the machine-rendered Changelog. */
export function parseSectionHeadings(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => /^##\s+(.+)$/.exec(line.trim())?.[1])
    .filter((title): title is string => typeof title === "string" && title !== "Changelog");
}

/**
 * Guard rails for the optional LLM polish step: the rewritten head must keep
 * the exact PR set and the exact category headings. Any missing/invented PR or
 * category is a hard failure so a summarizer can never silently corrupt notes.
 * `allowedExtraPrs` tolerates incidental references the original head carried
 * inside titles (they may legitimately be dropped or kept by the rewrite).
 */
export function validatePolishedSections(
  head: string,
  expectedPrs: number[],
  expectedHeadings: string[],
  allowedExtraPrs: number[] = [],
): string[] {
  const errors: string[] = [];
  const actualPrs = extractPrNumbers(head);
  const missing = expectedPrs.filter(number => !actualPrs.includes(number));
  const unexpected = actualPrs.filter(
    number => !expectedPrs.includes(number) && !allowedExtraPrs.includes(number),
  );
  if (missing.length > 0) errors.push(`missing PR references: #${missing.join(", #")}`);
  if (unexpected.length > 0) errors.push(`unexpected PR references: #${unexpected.join(", #")}`);

  const counts = countPrNumbers(head);
  const repeated = expectedPrs.filter(number => (counts.get(number) ?? 0) > 1);
  if (repeated.length > 0) errors.push(`repeated PR references: #${repeated.join(", #")}`);

  const headings = parseSectionHeadings(head);
  const missingHeadings = expectedHeadings.filter(title => !headings.includes(title));
  const extraHeadings = headings.filter(title => !expectedHeadings.includes(title));
  if (missingHeadings.length > 0) errors.push(`missing headings: ${missingHeadings.join(", ")}`);
  if (extraHeadings.length > 0) errors.push(`unexpected headings: ${extraHeadings.join(", ")}`);
  return errors;
}

const POLISH_SYSTEM_PROMPT = `You are the release notes editor for opencodex, a universal provider proxy for OpenAI Codex and Claude Code.
Rewrite the release-notes sections below (everything before "## Changelog") in the style of OpenAI Codex release notes:

- Keep the exact same markdown headings and their order.
- Group related pull requests into single bullets: one human-readable sentence (or two) summarizing what changed, ending with the full PR reference list in parentheses, e.g. "- Honor configured proxies across authentication, plugin downloads, and redirects. (#123, #456)".
- Every PR number must appear exactly once across the bullets; never invent PR numbers or features.
- Do not add or remove categories. Omit a category only when it has no PRs.
- The npm metadata line is handled outside this rewrite; do not include it.
- Do not output the "## Changelog" section.
Output only the rewritten markdown.`;

const POLISH_REQUEST_TIMEOUT_MS = 120_000;

async function callChatCompletion(apiKey: string, baseUrl: string, model: string, head: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(POLISH_REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: POLISH_SYSTEM_PROMPT },
          { role: "user", content: head },
        ],
      }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`✗ polish LLM request did not complete: ${reason}`);
    process.exit(1);
  }
  if (!response.ok) {
    const detail = await response.text();
    console.error(`✗ polish LLM request failed (HTTP ${response.status}): ${detail.slice(0, 500)}`);
    process.exit(1);
  }
  let data: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  } catch {
    console.error("✗ polish LLM returned a non-JSON response body");
    process.exit(1);
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    console.error("✗ polish LLM returned no content");
    process.exit(1);
  }
  return content;
}

/**
 * Split a rendered body into the npm metadata line (held out of the model
 * rewrite and re-attached deterministically), the category head, and the
 * machine-rendered changelog tail.
 */
export function splitPolishInput(body: string): { metadata: string; head: string; changelog: string } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex(line => /^##\s+Changelog\s*$/.test(line.trim()));
  if (index === -1) {
    console.error("✗ polish input has no `## Changelog` section to validate against");
    process.exit(1);
  }
  const headLines = lines.slice(0, index);
  const firstContent = headLines.findIndex(line => line.trim().length > 0);
  const isMetadata = firstContent !== -1 && /^Published to npm as /.test(headLines[firstContent]!);
  return {
    metadata: isMetadata ? headLines[firstContent]!.trim() : "",
    head: (isMetadata ? headLines.slice(firstContent + 1) : headLines).join("\n").trim(),
    changelog: lines.slice(index).join("\n").trim(),
  };
}

/**
 * The polish API key must never travel in plaintext: https is always allowed,
 * plain http only for loopback hosts (IPv4, IPv6 bracket form, `localhost`,
 * and `.localhost` names).
 */
export function isPolishBaseUrlAllowed(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    return (
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        (hostname === "localhost" ||
          hostname === "127.0.0.1" ||
          hostname === "::1" ||
          hostname.endsWith(".localhost")))
    );
  } catch {
    return false;
  }
}

async function readStdinOrFile(path: string | undefined): Promise<string> {
  if (path && path !== "-") {
    return await Bun.file(path).text();
  }
  return await new Response(Bun.stdin).text();
}

function parseFlagArgs(rest: string[], known?: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key?.startsWith("--")) {
      console.error(`Unexpected argument: ${key}`);
      process.exit(1);
    }
    const name = key.slice(2);
    if (known && !known.includes(name)) {
      console.error(`Unknown flag: ${key}`);
      process.exit(1);
    }
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) {
      console.error(`Missing value for ${key}`);
      process.exit(1);
    }
    args.set(name, value);
    i += 1;
  }
  return args;
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

  if (cmd === "commit-fallback") {
    // stdin: `git log --format=%H%x1f%s%x1f%an <range>` output.
    const rendered = renderCommitFallbackNotes(parseCommitLog(await readStdinOrFile(rest[0])));
    process.stdout.write(rendered);
    return;
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
    const args = parseFlagArgs(rest, ["repo", "in", "out"]);
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

  if (cmd === "render") {
    const args = parseFlagArgs(rest, [
      "npm-metadata",
      "out",
      "carried",
      "delta",
      "commit-fallback",
      "compare-from",
      "compare-to",
      "repository",
    ]);
    const npmMetadata = args.get("npm-metadata");
    const out = args.get("out");
    if (!npmMetadata || !out) {
      console.error("Usage: bun scripts/release-notes.ts render --npm-metadata <text> --out <file> [--carried <file>] [--delta <file>] [--compare-from <tag>] [--compare-to <tag>] [--repository <owner/name>]");
      process.exit(1);
    }
    const readOptional = async (name: string): Promise<string> => {
      const path = args.get(name);
      if (!path) return "";
      if (!(await Bun.file(path).exists())) return "";
      return await Bun.file(path).text();
    };

    const notes = renderReleaseNotes({
      npmMetadata,
      carriedPreviewNotes: await readOptional("carried"),
      deltaPrNotes: await readOptional("delta"),
      commitFallbackNotes: await readOptional("commit-fallback"),
      compareFrom: args.get("compare-from") ?? null,
      compareTo: args.get("compare-to"),
      repository: args.get("repository"),
    });
    await Bun.write(out, notes);
    return;
  }

  if (cmd === "polish") {
    const args = parseFlagArgs(rest, ["in", "out", "model", "base-url"]);
    const inputPath = args.get("in");
    const outPath = args.get("out");
    if (!inputPath || !outPath) {
      console.error("Usage: bun scripts/release-notes.ts polish --in <file> --out <file> [--model <model>] [--base-url <url>]");
      process.exit(1);
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("✗ polish needs an OpenAI-compatible API key: set OPENAI_API_KEY");
      process.exit(1);
    }
    const baseUrl = (args.get("base-url") ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    if (!isPolishBaseUrlAllowed(baseUrl)) {
      console.error("✗ polish --base-url must be https: or a loopback http: host (the API key must not travel in plaintext)");
      process.exit(1);
    }
    const model = args.get("model") ?? process.env.OPENAI_MODEL ?? "gpt-5.4";

    if (!(await Bun.file(inputPath).exists())) {
      console.error(`✗ polish input not found: ${inputPath}`);
      process.exit(1);
    }
    const body = await Bun.file(inputPath).text();
    const { metadata, head, changelog } = splitPolishInput(body);
    if (!metadata) {
      console.error("✗ polish input has no recognizable npm metadata line; refusing to send it to the model");
      process.exit(1);
    }
    const expectedPrs = extractChangelogPrNumbers(changelog);
    const allowedExtraPrs = extractPrNumbers(changelog).filter(number => !expectedPrs.includes(number));
    const expectedHeadings = parseSectionHeadings(head);
    if (expectedPrs.length === 0) {
      console.error("✗ polish input Changelog contains no PR references");
      process.exit(1);
    }

    const rewritten = await callChatCompletion(apiKey, baseUrl, model, head);
    const errors = validatePolishedSections(rewritten, expectedPrs, expectedHeadings, allowedExtraPrs);
    if (errors.length > 0) {
      console.error("✗ polished notes failed validation:");
      for (const error of errors) console.error(`  - ${error}`);
      process.exit(1);
    }
    const sections = [metadata, rewritten.trimEnd(), changelog].filter(part => part.length > 0);
    const out = sections.join("\n\n");
    await Bun.write(outPath, out.endsWith("\n") ? out : out + "\n");
    return;
  }

  console.error(`Unknown command: ${cmd ?? "(none)"}
Usage:
  bun scripts/release-notes.ts strip-carried [body-file]
  bun scripts/release-notes.ts has-meaningful [body-file]
  bun scripts/release-notes.ts commit-fallback [commit-log-file]
  bun scripts/release-notes.ts join-carried --out <file> <part-file>...
  bun scripts/release-notes.ts matching-preview-tag <version>   # tags on stdin
  bun scripts/release-notes.ts matching-preview-tags <version>  # tags on stdin, oldest→newest
  bun scripts/release-notes.ts previous-release-tag <version>   # tags on stdin
  bun scripts/release-notes.ts credit-takeovers --repo <owner/name> --in <file> --out <file>
  bun scripts/release-notes.ts render --npm-metadata ... --out ... [--carried ...] [--delta ...] [--compare-from ...] [--compare-to ...] [--repository ...]
  bun scripts/release-notes.ts polish --in <file> --out <file> [--model ...] [--base-url ...]`);
  process.exit(1);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

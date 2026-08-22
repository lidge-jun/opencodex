#!/usr/bin/env bun
/**
 * Build release notes from the actual Git commit range, using GitHub-generated
 * PR notes as enrichment rather than as the source of truth.
 *
 * Release invariants:
 * - preview notes are incremental since the previous release tag;
 * - stable notes always cover the full range since the previous stable tag;
 * - every non-release-metadata commit is represented by a PR, a direct commit,
 *   or an explicit skip-changelog PR;
 * - a non-empty change range may never publish an empty changelog.
 */

import {
  cleanPrTitle,
  compareReleaseTags,
  parseGeneratedNotes,
  rewriteTakeoverCredits,
  sanitizeCommitText,
} from "./release-notes";

export type AssociatedPullRequest = {
  number: number;
  title: string;
  author: string;
  labels: string[];
  merged: boolean;
};

export type ReleaseCommit = {
  sha: string;
  subject: string;
  body: string;
  pulls: AssociatedPullRequest[];
};

type PullChange = {
  kind: "pr";
  category: string;
  number: number;
  title: string;
  author: string;
};

type CommitChange = {
  kind: "commit";
  category: string;
  sha: string;
  title: string;
};

type ChangeEntry = PullChange | CommitChange;

type Coverage =
  | { kind: "pr"; ids: number[] }
  | { kind: "commit"; sha: string }
  | { kind: "ignored"; reason: string };

export type ReleaseNotesBuildResult = {
  body: string;
  baseline: string | null;
  releasableCommitCount: number;
  ignoredCommitCount: number;
  errors: string[];
};

const CATEGORY_ORDER = [
  "New Features",
  "Bug Fixes",
  "Documentation",
  "Chores",
  "Other Changes",
];

const RELEASE_METADATA_COMMIT =
  /^(?:release|chore\(release\)):\s*v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s*$/i;
const RELEASE_VERSION = /^v?\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?$/;

export function isReleaseMetadataCommit(subject: string): boolean {
  return RELEASE_METADATA_COMMIT.test(subject.trim());
}

export function isPrereleaseVersion(version: string): boolean {
  return RELEASE_VERSION.exec(version.trim())?.[1] !== undefined;
}

export function categoryForTitle(title: string): string {
  const conventional = /^([a-z]+)(?:\([^)]+\))?!?:\s*/i.exec(title.trim());
  switch (conventional?.[1]?.toLowerCase()) {
    case "feat":
      return "New Features";
    case "fix":
      return "Bug Fixes";
    case "docs":
      return "Documentation";
    case "chore":
    case "build":
    case "ci":
    case "test":
      return "Chores";
    default:
      return "Other Changes";
  }
}

export function categoryForPull(pr: AssociatedPullRequest): string {
  const labels = new Set(pr.labels.map(label => label.toLowerCase()));
  if (labels.has("enhancement")) return "New Features";
  if (labels.has("bug")) return "Bug Fixes";
  if (labels.has("documentation")) return "Documentation";
  if (labels.has("chore")) return "Chores";
  return categoryForTitle(pr.title);
}

/**
 * Select the release-note baseline from the full repository tag set.
 *
 * Prerelease: newest prior release of either channel, so previews stay incremental.
 * Stable: newest prior stable only, so the final changelog always reconstructs
 * the complete stable-to-stable range and cannot lose prerelease changes.
 *
 * `isAncestor` filters to tags actually reachable from the target. Without it a
 * preview could select the newest STABLE tag, which lives on `main` and is not
 * reachable from `preview` — the ancestry guard then threw and no preview could
 * be released at all once the stable lineage advanced. Selecting the newest
 * REACHABLE release keeps previews incremental and keeps the range honest.
 */
export function selectReleaseBaseline(
  version: string,
  tags: string[],
  isAncestor?: (tag: string) => boolean,
): string | null {
  const releaseTag = version.startsWith("v") ? version : `v${version}`;
  const targetIsPrerelease = isPrereleaseVersion(version);
  const candidates = tags
    .map(tag => tag.trim())
    .filter(tag => /^v\d/.test(tag) && compareReleaseTags(tag, releaseTag) < 0)
    .filter(tag => targetIsPrerelease || !isPrereleaseVersion(tag))
    .filter(tag => isAncestor === undefined || isAncestor(tag))
    .sort(compareReleaseTags);
  return candidates.length > 0 ? candidates[candidates.length - 1]! : null;
}

/** A squash-style landing PR reference, e.g. `fix: thing (#123)`. */
export function trailingLandingPr(subject: string): number | null {
  const match = /\(#(\d+)\)\s*$/.exec(subject.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function hasRenderedPullReference(body: string, number: number): boolean {
  return new RegExp(`#${number}(?!\\d)`).test(body);
}

function hasSkipChangelog(pr: AssociatedPullRequest): boolean {
  return pr.labels.some(label => label.toLowerCase() === "skip-changelog");
}

function generatedPullChanges(body: string): Map<number, PullChange> {
  const changes = new Map<number, PullChange>();
  for (const section of parseGeneratedNotes(body)) {
    for (const pr of section.prs) {
      if (changes.has(pr.number)) continue;
      changes.set(pr.number, {
        kind: "pr",
        category: section.title,
        number: pr.number,
        title: pr.title,
        author: pr.author,
      });
    }
  }
  return changes;
}

function sortedCategories(entries: ChangeEntry[]): string[] {
  const seen = new Set(entries.map(entry => entry.category));
  return [...seen].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    const ar = ai === -1 ? CATEGORY_ORDER.length : ai;
    const br = bi === -1 ? CATEGORY_ORDER.length : bi;
    if (ar !== br) return ar - br;
    return a.localeCompare(b);
  });
}

function renderReleaseNotes(input: {
  npmMetadata: string;
  entries: ChangeEntry[];
  compareFrom: string | null;
  compareTo: string;
  repository: string;
}): string {
  const parts: string[] = [];
  if (input.npmMetadata.trim()) parts.push(input.npmMetadata.trim());

  for (const category of sortedCategories(input.entries)) {
    const categoryEntries = input.entries.filter(entry => entry.category === category);
    if (categoryEntries.length === 0) continue;
    const lines = [`## ${category}`, ""];
    for (const entry of categoryEntries) {
      if (entry.kind === "pr") {
        lines.push(`- ${cleanPrTitle(entry.title, entry.number).text} (#${entry.number})`);
      } else {
        const short = entry.sha.slice(0, 8);
        // Direct-commit subjects are author-controlled text rendered as release
        // Markdown. Without sanitizing, a subject can inject images/links and an
        // `@mention` that rewrites the release's Contributors list. PR titles
        // already pass through cleanPrTitle upstream; commits did not.
        const title = sanitizeCommitText(cleanPrTitle(entry.title).text);
        lines.push(
          `- ${title} ([${short}](https://github.com/${input.repository}/commit/${entry.sha}))`,
        );
      }
    }
    parts.push(lines.join("\n"));
  }

  const changelog: string[] = ["## Changelog", ""];
  if (input.compareFrom) {
    changelog.push(
      `Full Changelog: https://github.com/${input.repository}/compare/${input.compareFrom}...${input.compareTo}`,
      "",
    );
  }

  const prs = input.entries
    .filter((entry): entry is PullChange => entry.kind === "pr")
    .sort((a, b) => a.number - b.number);
  const commits = input.entries.filter((entry): entry is CommitChange => entry.kind === "commit");

  for (const pr of prs) {
    changelog.push(`- #${pr.number} ${pr.title.trim()} @${pr.author || "unknown"}`);
  }
  for (const commit of commits) {
    const short = commit.sha.slice(0, 8);
    changelog.push(
      `- [${short}](https://github.com/${input.repository}/commit/${commit.sha}) ${sanitizeCommitText(commit.title)}`,
    );
  }

  parts.push(changelog.join("\n").replace(/\n+$/, ""));
  return parts.join("\n\n").replace(/\n+$/, "") + "\n";
}

export function buildReleaseNotes(input: {
  version: string;
  tags: string[];
  npmMetadata: string;
  generatedNotes: string;
  commits: ReleaseCommit[];
  repository: string;
}): ReleaseNotesBuildResult {
  const baseline = selectReleaseBaseline(input.version, input.tags);
  const releaseTag = input.version.startsWith("v") ? input.version : `v${input.version}`;
  const generated = generatedPullChanges(input.generatedNotes);
  const fallbackPrs = new Map<number, PullChange>();
  const directCommits: CommitChange[] = [];
  const coverage = new Map<string, Coverage>();

  const releasableCommits = input.commits.filter(commit => !isReleaseMetadataCommit(commit.subject));

  for (const commit of releasableCommits) {
    const landing = trailingLandingPr(commit.subject);
    if (landing !== null && generated.has(landing)) {
      coverage.set(commit.sha, { kind: "pr", ids: [landing] });
      continue;
    }

    const mergedPulls = commit.pulls.filter(pr => pr.merged);
    const visiblePulls = mergedPulls.filter(pr => !hasSkipChangelog(pr));
    const generatedPulls = visiblePulls.filter(pr => generated.has(pr.number));
    if (generatedPulls.length > 0) {
      coverage.set(commit.sha, {
        kind: "pr",
        ids: generatedPulls.map(pr => pr.number),
      });
      continue;
    }

    if (visiblePulls.length > 0) {
      for (const pr of visiblePulls) {
        if (!fallbackPrs.has(pr.number)) {
          fallbackPrs.set(pr.number, {
            kind: "pr",
            category: categoryForPull(pr),
            number: pr.number,
            title: pr.title,
            author: pr.author,
          });
        }
      }
      coverage.set(commit.sha, {
        kind: "pr",
        ids: visiblePulls.map(pr => pr.number),
      });
      continue;
    }

    if (mergedPulls.length > 0 && mergedPulls.every(hasSkipChangelog)) {
      coverage.set(commit.sha, {
        kind: "ignored",
        reason: mergedPulls.map(pr => `#${pr.number}`).join(", ") + " has skip-changelog",
      });
      continue;
    }

    directCommits.push({
      kind: "commit",
      category: categoryForTitle(commit.subject),
      sha: commit.sha,
      title: commit.subject,
    });
    coverage.set(commit.sha, { kind: "commit", sha: commit.sha });
  }

  const entries: ChangeEntry[] = [
    ...generated.values(),
    ...fallbackPrs.values(),
    ...directCommits,
  ];

  const body = renderReleaseNotes({
    npmMetadata: input.npmMetadata,
    entries,
    compareFrom: baseline,
    compareTo: releaseTag,
    repository: input.repository,
  });

  const errors: string[] = [];
  for (const commit of releasableCommits) {
    const covered = coverage.get(commit.sha);
    if (!covered) {
      errors.push(`commit ${commit.sha.slice(0, 12)} is not represented`);
      continue;
    }
    if (covered.kind === "commit" && !body.includes(commit.sha.slice(0, 8))) {
      errors.push(`direct commit ${commit.sha.slice(0, 12)} is missing from rendered notes`);
    }
    if (covered.kind === "pr" && !covered.ids.some(number => hasRenderedPullReference(body, number))) {
      errors.push(
        `commit ${commit.sha.slice(0, 12)} is mapped to PR ${covered.ids.map(number => `#${number}`).join(", ")}, but none are rendered`,
      );
    }
  }

  const visibleEntryCount = entries.length;
  if (releasableCommits.length > 0 && visibleEntryCount === 0) {
    errors.push(
      `${releasableCommits.length} changed commit(s) exist, but the changelog has no visible entries`,
    );
  }

  const ignoredCommitCount = [...coverage.values()].filter(item => item.kind === "ignored").length;
  return {
    body,
    baseline,
    releasableCommitCount: releasableCommits.length,
    ignoredCommitCount,
    errors,
  };
}

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function runCommand(args: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function commandText(args: string[]): Promise<string> {
  const result = await runCommand(args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit ${result.exitCode}`;
    throw new Error(`${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

async function ghJson(path: string, allowNotFound = false): Promise<unknown | null> {
  const result = await runCommand(["gh", "api", path]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit ${result.exitCode}`;
    if (allowNotFound && (/\b404\b/.test(detail) || /\bNot Found\b/i.test(detail))) {
      return null;
    }
    throw new Error(`gh api ${path} failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(`gh api ${path} returned non-JSON`);
  }
}

async function generateGitHubNotes(
  repository: string,
  releaseTag: string,
  target: string,
  baseline: string | null,
): Promise<string> {
  if (!baseline) return "";
  return await commandText([
    "gh",
    "api",
    `repos/${repository}/releases/generate-notes`,
    "-f",
    `tag_name=${releaseTag}`,
    "-f",
    `target_commitish=${target}`,
    "-f",
    `previous_tag_name=${baseline}`,
    "--jq",
    ".body",
  ]);
}

const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function parseGitLog(raw: string): Array<Omit<ReleaseCommit, "pulls">> {
  if (raw === "") return [];
  if (!raw.endsWith("\0")) {
    throw new Error("git log produced a malformed release commit record");
  }

  const fields = raw.split("\0");
  fields.pop();
  if (fields.length % 3 !== 0) {
    throw new Error("git log produced a malformed release commit record");
  }

  const commits: Array<Omit<ReleaseCommit, "pulls">> = [];
  for (let index = 0; index < fields.length; index += 3) {
    const [sha, subject, body] = fields.slice(index, index + 3);
    if (!sha || !GIT_OBJECT_ID_PATTERN.test(sha) || !subject?.trim() || body === undefined) {
      throw new Error("git log produced a malformed release commit record");
    }
    commits.push({
      sha,
      subject: subject.trim(),
      body: body.trim(),
    });
  }
  return commits;
}

async function releaseCommits(
  baseline: string | null,
  target: string,
): Promise<Array<Omit<ReleaseCommit, "pulls">>> {
  const range = baseline ? `${baseline}..${target}` : target;
  // Merge commits are included deliberately. `--no-merges` made the
  // "every commit is represented" invariant false: a merge whose tree carries a
  // conflict-resolution-only change contributes real content that exists in no
  // other commit, and dropping it hid that change from coverage validation AND
  // from the released notes. `--first-parent` keeps the range to this branch's
  // own history so an ordinary merge does not re-list every commit it brought
  // in; the merge itself is then represented by exactly one entry.
  const raw = await commandText([
    "git",
    "log",
    "--first-parent",
    "--reverse",
    "-z",
    "--format=%H%x00%s%x00%B",
    range,
  ]);
  return parseGitLog(raw);
}

export function parseAssociatedPulls(data: unknown): AssociatedPullRequest[] {
  if (!Array.isArray(data)) throw new Error("commit PR lookup returned non-array JSON");
  const pulls: AssociatedPullRequest[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const pr = item as {
      number?: unknown;
      title?: unknown;
      merged_at?: unknown;
      user?: { login?: unknown } | null;
      labels?: Array<{ name?: unknown }>;
    };
    if (typeof pr.number !== "number" || typeof pr.title !== "string") continue;
    pulls.push({
      number: pr.number,
      title: pr.title,
      author: typeof pr.user?.login === "string" ? pr.user.login : "unknown",
      labels: Array.isArray(pr.labels)
        ? pr.labels
            .map(label => label?.name)
            .filter((name): name is string => typeof name === "string")
        : [],
      merged: typeof pr.merged_at === "string" && pr.merged_at.length > 0,
    });
  }
  return pulls;
}

function parseFlags(rest: string[]): Map<string, string> {
  const known = new Set(["version", "dist-tag", "repository", "target", "out"]);
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (!known.has(name)) throw new Error(`Unknown flag: ${arg}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

async function readPackageName(): Promise<string> {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
    name?: unknown;
  };
  if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) {
    throw new Error("package.json is missing a valid package name");
  }
  return manifest.name.trim();
}

async function main(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const version = flags.get("version");
  const distTag = flags.get("dist-tag");
  const repository = flags.get("repository");
  const target = flags.get("target");
  const out = flags.get("out");
  if (!version || !distTag || !repository || !target || !out) {
    throw new Error(
      "Usage: bun scripts/build-release-changelog.ts --version <version> --dist-tag <tag> --repository <owner/name> --target <sha> --out <file>",
    );
  }

  await commandText(["git", "fetch", "--force", "--tags", "origin"]);
  const tags = (await commandText(["git", "tag", "--list", "v[0-9]*"]))
    .split(/\r?\n/)
    .filter(Boolean);
  // Resolve reachability once per tag, then let selection skip anything not in
  // this target's history. Previously selection ignored ancestry and the guard
  // below threw, so a preview became unreleasable the moment the stable lineage
  // moved ahead of it.
  const ancestryCache = new Map<string, boolean>();
  for (const tag of tags) {
    const probe = await runCommand(["git", "merge-base", "--is-ancestor", tag, target]);
    ancestryCache.set(tag, probe.exitCode === 0);
  }
  const baseline = selectReleaseBaseline(version, tags, tag => ancestryCache.get(tag) === true);
  const releaseTag = version.startsWith("v") ? version : `v${version}`;

  // Selection above already filters to reachable tags, so this is now a
  // belt-and-braces assertion rather than the primary gate. It stays because a
  // non-ancestral baseline cannot describe a range at all, and a future caller
  // that skips the filter must still fail closed rather than emit notes drawn
  // from an unrelated lineage.
  if (baseline) {
    const ancestry = await runCommand(["git", "merge-base", "--is-ancestor", baseline, target]);
    if (ancestry.exitCode !== 0) {
      const channel = isPrereleaseVersion(version) ? "previous release" : "previous stable";
      throw new Error(
        `${channel} ${baseline} is not an ancestor of ${target}; refusing an ambiguous changelog range`,
      );
    }
  }

  const rawGeneratedNotes = await generateGitHubNotes(repository, releaseTag, target, baseline);
  const pullCache = new Map<number, {
    title: string;
    body: string;
    author: string;
  } | null>();

  const fetchPull = async (number: number) => {
    if (pullCache.has(number)) return pullCache.get(number)!;
    const data = await ghJson(`repos/${repository}/pulls/${number}`, true);
    if (data === null) {
      pullCache.set(number, null);
      return null;
    }
    if (!data || typeof data !== "object") {
      throw new Error(`PR #${number} lookup returned no object`);
    }
    const pr = data as { title?: unknown; body?: unknown; user?: { login?: unknown } };
    if (typeof pr.title !== "string") throw new Error(`PR #${number} is missing a title`);
    const parsed = {
      title: pr.title,
      body: typeof pr.body === "string" ? pr.body : "",
      author: typeof pr.user?.login === "string" ? pr.user.login : "unknown",
    };
    pullCache.set(number, parsed);
    return parsed;
  };

  const generatedNotes = await rewriteTakeoverCredits(
    rawGeneratedNotes,
    async number => {
      const pr = await fetchPull(number);
      return pr
        ? { title: pr.title, body: pr.body, authorLogin: pr.author }
        : null;
    },
    async number => (await fetchPull(number))?.author ?? null,
  );

  const generatedNumbers = new Set<number>();
  for (const section of parseGeneratedNotes(generatedNotes)) {
    for (const pr of section.prs) generatedNumbers.add(pr.number);
  }

  const rawCommits = await releaseCommits(baseline, target);
  const commits: ReleaseCommit[] = [];
  for (const commit of rawCommits) {
    if (isReleaseMetadataCommit(commit.subject)) {
      commits.push({ ...commit, pulls: [] });
      continue;
    }
    const landing = trailingLandingPr(commit.subject);
    if (landing !== null && generatedNumbers.has(landing)) {
      commits.push({ ...commit, pulls: [] });
      continue;
    }
    const data = await ghJson(`repos/${repository}/commits/${commit.sha}/pulls`);
    commits.push({ ...commit, pulls: parseAssociatedPulls(data) });
  }

  const packageName = await readPackageName();
  const npmMetadata =
    `Published to npm as \`${packageName}@${version}\` with dist-tag \`${distTag}\`.`;
  const built = buildReleaseNotes({
    version,
    tags,
    npmMetadata,
    generatedNotes,
    commits,
    repository,
  });

  if (built.errors.length > 0) {
    console.error("✗ release changelog failed coverage validation:");
    for (const error of built.errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  await Bun.write(out, built.body);
  console.log(
    `✓ release changelog: baseline=${built.baseline ?? "none"} commits=${built.releasableCommitCount} ignored=${built.ignoredCommitCount}`,
  );
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`✗ release changelog build failed: ${detail}`);
    process.exit(1);
  }
}

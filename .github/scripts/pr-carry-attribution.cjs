"use strict";

/**
 * Attribution for work carried from another author's pull request.
 *
 * When a maintainer lands someone else's pull request by reimplementing,
 * carrying, or rebasing it, the resulting commit is authored by the maintainer.
 * The contributor survives only through a Co-authored-by trailer -- that trailer
 * is what GitHub reads for the contributor graph, the repository's contributor
 * list, and the author's own profile activity.
 *
 * This exists because the repository did it both ways for months. 53c09a247
 * says "Clean reimplementation of #3193" and names alan7629 in a trailer;
 * 5734a1caf says "Reimplements #2797 by @rrmlima" and names nobody. Both
 * sentences are equally sincere, and only the first is data. A scan of dev
 * found 27 landings whose author is named in prose and nowhere a tool can read;
 * CREDITS.md is the record of those, and this check is why the list should not
 * grow.
 *
 * The check reads the pull request's own text, not its diff, because that is
 * where a carry declares itself.
 */

const CARRY_VERB_RE =
  /\b(?:re-?implement(?:s|ed|ing|ation of)?|supersed(?:e|es|ed|ing)|carry(?: of)?|carries|carrying|carried(?: from)?|rebase(?: of)?|rebasing|adopts the design from)\b/gi;

/**
 * Every reference in one window, keeping any owner/repo qualifier.
 *
 * A bare "#2797" means this repository. "other/project#2797" does not, and
 * resolving it here would look up an unrelated pull request of the same number
 * in this one -- comparing the trailer against the wrong person. Qualified
 * references are captured so they can be dropped rather than misread.
 */
const REF_RE = /(?:([\w.-]+\/[\w.-]+))?#(\d+)/g;

/**
 * The window a carry verb governs: to the end of its sentence, capped at 80
 * characters. Both bounds are load-bearing.
 *
 * The sentence bound is why "Supersedes #3193. Fixes #3192." reports only
 * #3193 -- that is 53c09a247's real body, and a fixed-width window would have
 * pulled the issue it closes into the carry set and demanded a trailer for the
 * reporter. The width cap is why a verb cannot reach across a paragraph into an
 * unrelated reference list.
 */
const SENTENCE_END_RE = /[.!?](?:\s|$)|\n/;

function carryWindow(text, from) {
  const slice = text.slice(from, from + 80);
  const end = slice.search(SENTENCE_END_RE);
  return end === -1 ? slice : slice.slice(0, end);
}

const TRAILER_RE = /^[ \t]*co-authored-by:[ \t]*(.+)$/gim;

const FENCED_CODE_RE = /^[ \t]*(\u0060{3,}|~{3,})[\s\S]*?^[ \t]*\1[ \t]*$/gm;
const INLINE_CODE_RE = /\u0060[^\u0060\n]*\u0060/g;
/**
 * HTML comments, which GitHub never renders.
 *
 * The `(?:-->|$)` alternative is load-bearing and matches `pr-quality.cjs`: an
 * UNCLOSED comment runs to the end of the text, because that is what GitHub
 * does with it. Without the alternative, `<!--` with no terminator matched
 * nothing, so everything after it stayed in the scanned text while GitHub
 * rendered none of it — an author could write a carry claim that the gate reads
 * and no human ever sees, or bury one the gate misses in text that renders.
 * Either direction is a divergence between what is enforced and what is shown.
 *
 * CodeQL flagged the same shape as `js/incomplete-multi-character-sanitization`
 * on #3342. The alert's own framing (HTML element injection) does not apply —
 * this output is matched by regex, never rendered — but the underlying
 * observation, that the strip is incomplete, is correct for this gate's purpose.
 */
const HTML_COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * Carry language inside a fenced block, an inline span, or an HTML comment is
 * quoted material, not a declaration. A pull request that explains the gate
 * itself -- this one does -- must not trip it.
 */
function strippedText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(FENCED_CODE_RE, "")
    .replace(HTML_COMMENT_RE, "")
    .replace(INLINE_CODE_RE, "");
}

function hasLabel(labels, name) {
  return (labels || []).some(
    (label) => (typeof label === "string" ? label : label?.name) === name,
  );
}

/** Pull request numbers this text claims to carry, supersede, or rebase. */
function referencedCarryNumbers(...texts) {
  const found = new Set();
  for (const text of texts) {
    const stripped = strippedText(text);
    CARRY_VERB_RE.lastIndex = 0;
    let verb;
    while ((verb = CARRY_VERB_RE.exec(stripped)) !== null) {
      const window = carryWindow(stripped, verb.index + verb[0].length);
      REF_RE.lastIndex = 0;
      let ref;
      while ((ref = REF_RE.exec(window)) !== null) {
        // A qualified reference names a pull request in another repository.
        if (ref[1]) continue;
        found.add(Number(ref[2]));
      }
    }
  }
  return found;
}

function trailerValues(...texts) {
  const values = [];
  for (const text of texts) {
    if (typeof text !== "string") continue;
    TRAILER_RE.lastIndex = 0;
    let match;
    while ((match = TRAILER_RE.exec(text)) !== null) values.push(match[1].toLowerCase());
  }
  return values;
}

/**
 * A GitHub login is not a git identity. The scan behind CREDITS.md produced
 * eleven false positives from that assumption alone: a login like "asmith92"
 * does not appear anywhere in a trailer that reads "A. Smith <a@example.com>",
 * even though they are the same person. Match on any of the three identifiers
 * the referenced pull request actually carries.
 */
function parseTrailer(value) {
  const match = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(value);
  if (match) return { name: match[1].toLowerCase(), email: match[2].toLowerCase() };
  return { name: value.trim().toLowerCase(), email: "" };
}

/**
 * Substring matching is not good enough here, and the failure is not exotic:
 * an author named "Ann" would be satisfied by "Co-authored-by: Joanne
 * <other@example.com>", and a short login can appear inside an unrelated
 * address. A trailer credits someone only when its name or its email equals an
 * identifier the referenced pull request actually carries.
 */
function trailerNames(author, trailers) {
  if (!author) return true;
  const names = new Set(
    [author.login, ...(author.names || [])]
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim().toLowerCase()),
  );
  const emails = new Set(
    (author.emails || [])
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim().toLowerCase()),
  );
  if (names.size === 0 && emails.size === 0) return true;
  return trailers.some(
    (trailer) =>
      (trailer.name !== "" && names.has(trailer.name)) ||
      (trailer.email !== "" && emails.has(trailer.email)) ||
      // A GitHub noreply address carries the login after the numeric id,
      // before the "@" -- that is the only identifier many trailers have.
      (trailer.email.endsWith("@users.noreply.github.com") &&
        names.has(trailer.email.replace(/^[^@]*?(\d+\+)?/, "").split("@")[0])),
  );
}

/**
 * @returns {{ code: string, paths: string[] }[]} empty when the pull request may proceed
 */
function assessCarryAttribution({
  prAuthorLogin = "",
  title = "",
  body = "",
  commits = [],
  labels = [],
  referencedAuthors = {},
} = {}) {
  if (hasLabel(labels, "attribution-approved")) return [];

  const referenced = referencedCarryNumbers(title, body, ...commits);
  if (referenced.size === 0) return [];

  // The squash body is assembled from the pull request body and the branch's
  // commit messages, so both are where an author can put the trailer today.
  const trailers = trailerValues(body, ...commits).map(parseTrailer);
  const uncredited = [];

  for (const number of referenced) {
    const author = referencedAuthors[number];
    // An unresolved author is a pass. A rate limit or a deleted account must
    // never be the reason a merge is blocked.
    if (!author) continue;
    // Referencing your own earlier branch is ordinary maintenance.
    if (
      author.login &&
      prAuthorLogin &&
      author.login.toLowerCase() === prAuthorLogin.toLowerCase()
    ) {
      continue;
    }
    if (!trailerNames(author, trailers)) uncredited.push("#" + number);
  }

  if (uncredited.length === 0) return [];
  return [
    {
      code: "missing_coauthor_credit",
      paths: uncredited.sort(),
    },
  ];
}

module.exports = {
  CARRY_VERB_RE,
  carryWindow,
  assessCarryAttribution,
  referencedCarryNumbers,
  strippedText,
  trailerValues,
};

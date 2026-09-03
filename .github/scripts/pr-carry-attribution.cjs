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
  /\b(?:re-?implement(?:s|ed|ation of)?|supersed(?:e|es|ed|ing)|carry of|carries|carried from|rebase of|adopts the design from)\b/gi;

/** Every #N in one window. */
const REF_RE = /#(\d+)/g;

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
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

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
      while ((ref = REF_RE.exec(window)) !== null) found.add(Number(ref[1]));
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
 * eleven false positives from that assumption alone: the login terrytan95 never
 * appears in "Co-authored-by: Terry Tan <tmy1995hflc@gmail.com>". Match on any
 * of the three identifiers the referenced pull request actually carries.
 */
function trailerNames(author, values) {
  if (!author) return true;
  const candidates = [
    author.login,
    ...(author.names || []),
    ...(author.emails || []),
  ]
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map((value) => value.toLowerCase());
  if (candidates.length === 0) return true;
  return values.some((value) => candidates.some((candidate) => value.includes(candidate)));
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
  const values = trailerValues(body, ...commits);
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
    if (!trailerNames(author, values)) uncredited.push("#" + number);
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

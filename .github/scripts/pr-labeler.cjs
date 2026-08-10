"use strict";

/**
 * PR title → GitHub type label for PR Labeler.
 * Accepts conventional commits (`fix(scope): …`) and sentence-case fallbacks
 * (`Fix Console Go …`) for LLM-authored PRs that skip the prefix colon.
 * Kept as a pure module so override behavior can be unit-tested without Actions.
 */

const PREFIX_TO_LABEL = Object.freeze({
  feat: "enhancement",
  feature: "enhancement",
  fix: "bug",
  bugfix: "bug",
  hotfix: "bug",
  docs: "documentation",
  doc: "documentation",
  chore: "chore",
  refactor: "chore",
  style: "chore",
  test: "chore",
  tests: "chore",
  ci: "chore",
  build: "chore",
  perf: "enhancement",
  revert: "chore",
});

const TYPE_LABELS = new Set(Object.values(PREFIX_TO_LABEL));

/** Actors whose type-label mutations are treated as bot-owned (may be overwritten). */
const BOT_ACTORS = new Set(["github-actions[bot]"]);

function labelForTitlePrefix(prefix) {
  const key = String(prefix || "").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PREFIX_TO_LABEL, key)) return null;
  return PREFIX_TO_LABEL[key];
}

/**
 * Map a PR title to a managed type label.
 * @param {string} title
 * @returns {string|null}
 */
function detectTypeLabelFromTitle(title) {
  const text = String(title || "");

  const conventional = text.match(/^([a-zA-Z]+)(?:\([^)]*\))?[!]?\s*:/);
  if (conventional) return labelForTitlePrefix(conventional[1]);

  // Sentence-case fallback (e.g. PR #524: "Fix Console Go tool schema sanitization").
  const sentence = text.match(/^([A-Za-z]+)\s+\S/);
  if (sentence) return labelForTitlePrefix(sentence[1]);

  return null;
}

/**
 * Type from the PR's own commits, for titles the title matcher cannot classify.
 *
 * A PR titled `stack 3/5: carry six contributor bug fixes` fails the
 * conventional regex (the `3/5` sits between the word and the colon) and then
 * reaches the sentence-case fallback, which extracts `stack`. That has no entry
 * in PREFIX_TO_LABEL, so the sync skips — and a skip is not a failure, so the
 * `label` check stays green while the PR carries no type label at all. The
 * commits underneath are conventional (`fix(codex): ...`), so they can answer
 * the question the title cannot.
 *
 * `chore` is supporting, not competing. `test:`, `ci:`, `chore:`, `style:`,
 * `refactor:`, and `build:` all map to it, and none of them says what a PR is
 * FOR. Requiring unanimity would abstain on almost every real PR: #955 is four
 * `fix(codex):` commits plus one `test(codex):`, and it is a bug fix.
 *
 * Anything still ambiguous after that (`fix:` alongside `feat:`) stays
 * unlabeled rather than guessed.
 */
function detectTypeLabelFromCommits(messages) {
  const types = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    const detected = detectTypeLabelFromTitle(String(message || "").split("\n")[0]);
    if (detected) types.add(detected);
  }
  if (types.size > 1) types.delete("chore");
  return types.size === 1 ? [...types][0] : null;
}

/**
 * True when a human (any non-bot actor) has ever labeled or unlabeled a managed
 * type label on this PR. Mirrors issue-quality's sticky maintainerOverride:
 * once a person changes the bot's choice, later synchronize/edited runs must
 * not revert it.
 *
 * @param {Array<{ event?: string, label?: { name?: string }, actor?: { login?: string } }>} events
 * @param {Set<string>} [typeLabels]
 * @param {Set<string>} [botActors]
 * @returns {boolean}
 */
function hasHumanTypeLabelOverride(events, typeLabels = TYPE_LABELS, botActors = BOT_ACTORS) {
  if (!Array.isArray(events)) return false;
  for (const event of events) {
    if (event?.event !== "labeled" && event?.event !== "unlabeled") continue;
    const name = event.label?.name;
    if (!name || !typeLabels.has(name)) continue;
    const actor = event.actor?.login;
    if (actor && !botActors.has(actor)) return true;
  }
  return false;
}

/**
 * Plan type-label add/remove mutations for a PR.
 *
 * @param {{
 *   title: string,
 *   currentLabels: string[],
 *   events: Array<{ event?: string, label?: { name?: string }, actor?: { login?: string } }>,
 * }} input
 * @returns {{
 *   skip: true,
 *   reason: "human-override" | "no-prefix",
 * } | {
 *   skip: false,
 *   detected: string,
 *   add: string|null,
 *   remove: string[],
 * }}
 */
function planTypeLabelSync(input) {
  const title = input?.title ?? "";
  const currentLabels = Array.isArray(input?.currentLabels) ? input.currentLabels : [];
  const events = Array.isArray(input?.events) ? input.events : [];

  if (hasHumanTypeLabelOverride(events)) {
    return { skip: true, reason: "human-override" };
  }

  // The title is authoritative when it classifies. The commits only answer for
  // titles it cannot (`stack 3/5: ...`), so a well-formed title is never
  // overridden by what happens to be committed under it.
  const detected =
    detectTypeLabelFromTitle(title) ?? detectTypeLabelFromCommits(input?.commitMessages);
  if (!detected) {
    return { skip: true, reason: "no-prefix" };
  }

  const current = new Set(currentLabels);
  const remove = [...TYPE_LABELS].filter((label) => current.has(label) && label !== detected);
  const add = current.has(detected) ? null : detected;
  return { skip: false, detected, add, remove };
}

module.exports = {
  PREFIX_TO_LABEL,
  TYPE_LABELS,
  BOT_ACTORS,
  detectTypeLabelFromTitle,
  detectTypeLabelFromCommits,
  hasHumanTypeLabelOverride,
  planTypeLabelSync,
};

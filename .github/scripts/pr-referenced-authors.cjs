"use strict";

const { referencedCarryNumbers } = require("./pr-carry-attribution.cjs");

/**
 * Resolve the authors of the pull requests a carry declaration names, so the
 * hygiene gate can tell "you carried someone else's work" from "you rebased
 * your own branch" and can match a trailer on git identity rather than login.
 *
 * Three properties this has to hold, each one a way the check could otherwise
 * do harm:
 *
 * - Fail open. A rate limit, a deleted account, or a reference to a pull
 *   request in another repository resolves to null, and a null author is a
 *   pass. Blocking a merge because an API call failed would be worse than the
 *   omission this gate exists to prevent.
 * - Bounded. At most MAX_LOOKUPS references are resolved. A description that
 *   discusses twenty prior pull requests must not turn one hygiene run into
 *   forty API calls.
 * - Identity, not login. The referenced pull request's own commits supply the
 *   git author names and emails, because a trailer is written by a human who
 *   usually copies the git identity, not the GitHub handle.
 */

const MAX_LOOKUPS = 5;

async function resolveReferencedAuthors({
  github,
  owner,
  repo,
  texts = [],
  core = null,
}) {
  const numbers = [...referencedCarryNumbers(...texts)].sort((a, b) => a - b);
  const resolved = {};
  for (const number of numbers.slice(0, MAX_LOOKUPS)) {
    try {
      const { data: referenced } = await github.rest.pulls.get({
        owner,
        repo,
        pull_number: number,
      });
      const identities = { login: referenced.user?.login ?? "", names: [], emails: [] };
      try {
        const commits = await github.paginate(github.rest.pulls.listCommits, {
          owner,
          repo,
          pull_number: number,
          per_page: 100,
        });
        for (const commit of commits) {
          const author = commit.commit?.author;
          if (author?.name) identities.names.push(author.name);
          if (author?.email) identities.emails.push(author.email);
        }
      } catch (error) {
        // The pull request resolved but its commits did not. Login-only
        // matching is weaker, not absent, so keep what we have.
        core?.info(
          "Could not list commits for #" + number + ": " + error.message,
        );
      }
      identities.names = [...new Set(identities.names)];
      identities.emails = [...new Set(identities.emails)];
      resolved[number] = identities;
    } catch (error) {
      core?.info("Could not resolve #" + number + ": " + error.message);
      resolved[number] = null;
    }
  }
  return resolved;
}

module.exports = {
  MAX_LOOKUPS,
  resolveReferencedAuthors,
};


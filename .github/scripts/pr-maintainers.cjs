"use strict";

/**
 * Maintainers from `MAINTAINERS.md` text. Only the current-maintainers table
 * is authoritative; the change log below it can mention retired accounts.
 * Missing the section heading means we cannot identify current maintainers,
 * so the recipient list is empty rather than scanning the whole file.
 */
function parseMaintainerLogins(text) {
  const heading = /^## Current maintainers[ \t]*\r?$/m.exec(text ?? "");
  if (heading === null) {
    return [];
  }

  const sectionStart = heading.index;
  const nextHeading = text.indexOf(
    "\n## ",
    sectionStart + "## Current maintainers".length
  );
  const section = text.slice(
    sectionStart,
    nextHeading === -1 ? text.length : nextHeading
  );
  const logins = [
    ...section.matchAll(
      /\[\@([A-Za-z0-9_-]+)\]\(https:\/\/github\.com\/[^)]*\)/g
    )
  ].map(match => match[1]);

  return [...new Set(logins)];
}

module.exports = {
  parseMaintainerLogins
};

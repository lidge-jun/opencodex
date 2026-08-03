"use strict";

/**
 * Sponsorship for surfaces where a bad merge is expensive and hard to unwind.
 *
 * Derived from @Wibias's trust-lane gate (#902), narrowed on purpose. That
 * version also capped first-time contributors at one open pull request and 500
 * changed lines. Those caps are not here: a provider preset with its registry
 * rows, adapter wiring, tests, and five locales clears 500 lines by itself, and
 * several good first contributions to this repository have. Telling a newcomer
 * their fix is too big is a worse failure than reviewing a large diff.
 *
 * What survives is the part that is about blast radius rather than trust:
 * authentication, credential handling, GitHub Actions workflows, release
 * automation, and dependency installation need a maintainer to sponsor the
 * change before it merges. `MAINTAINERS.md` already requires security review for
 * exactly these; this makes the requirement visible on the pull request instead
 * of relying on a reviewer noticing.
 *
 * It applies to EVERY contributor, not only first-timers. A maintainer with push
 * permission is exempt because their own review is the sponsorship.
 */

const RESTRICTED_PREFIXES = [
  ".github/workflows/",
  "src/oauth/",
];

const RESTRICTED_FILES = new Set([
  // Release and packaging automation executed by the release workflow.
  "scripts/release.ts",
  "scripts/release-notes.ts",
  "scripts/prepare-package.ts",
  // Authentication, credential, and secret handling. Mirrors the CODEOWNERS
  // security boundary.
  "src/codex/auth-api.ts",
  "src/codex/auth-collision.ts",
  "src/codex/auth-context.ts",
  "src/cli/account-auth.ts",
  "src/cli/status-oauth.ts",
  "src/lib/admin-secrets.ts",
  "src/lib/service-secrets.ts",
  "src/lib/windows-secret-acl.ts",
  "src/server/auth-cors.ts",
  "src/server/management-api.ts",
  "src/server/management-auth.ts",
  "src/server/management/oauth-account-routes.ts",
  "src/claude/auth-detect.ts",
  "src/claude/auth-mode-migration.ts",
  "src/claude/auth-mode.ts",
  // Dependency surfaces.
  "package.json",
  "bun.lock",
]);

function isRestrictedPath(path) {
  return RESTRICTED_FILES.has(path) || RESTRICTED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function hasSponsorship(labels) {
  return (labels || []).some(
    (label) => (typeof label === "string" ? label : label?.name) === "maintainer-sponsored",
  );
}

/**
 * @returns {{ code: string, paths: string[] }[]} empty when the pull request may proceed
 */
function assessSponsoredSurface({
  authorHasPushPermission = false,
  changedFiles = [],
  labels = [],
}) {
  // A maintainer's own change carries its own sponsorship.
  if (authorHasPushPermission) return [];
  const restricted = changedFiles.filter(isRestrictedPath);
  if (restricted.length === 0) return [];
  if (hasSponsorship(labels)) return [];
  return [{ code: "unsponsored_surface", paths: restricted }];
}

module.exports = {
  RESTRICTED_FILES,
  RESTRICTED_PREFIXES,
  assessSponsoredSurface,
  isRestrictedPath,
};

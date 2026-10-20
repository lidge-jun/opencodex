#!/usr/bin/env bash
# Decide whether this release run Authenticode-signs its Windows binaries through SignPath (#7207).
#
# Inputs (environment):
#   SIGNPATH_CONFIGURED        "true" when the SIGNPATH_API_TOKEN secret is visible to this run
#   SIGNPATH_ORGANIZATION_ID   repository variable
#   SIGNPATH_PROJECT_SLUG      repository variable
#   SIGNPATH_SIGNING_POLICY    repository variable SIGNPATH_SIGNING_POLICY_SLUG
#   DRY_RUN                    the dispatch's dry-run input ("true" or "false")
#   GITHUB_OUTPUT              step output file
#
# Outputs: mode=sign|skip, policy=<slug>, trust=release|test
#
# Signing is an improvement layered on a release, never a gate on it: this script always exits 0,
# and every outcome other than "sign" ships the unsigned binaries exactly as before.
#   - No token: skip. Forks and unconfigured copies never see the secret.
#   - A token with a SignPath variable missing, or a policy that is not a plain slug: skip with a
#     warning, so the misconfiguration is visible without costing the release.
#   - release-signing: sign; the verifier then requires a trusted chain (trust=release).
#   - Any other policy (test-signing): sign dry runs only (trust=test). A self-signed test
#     certificate is never attached to a public release, so a real release skips with a notice.
set -uo pipefail

output="${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
configured="${SIGNPATH_CONFIGURED:-false}"
policy="${SIGNPATH_SIGNING_POLICY:-}"
dry_run="${DRY_RUN:-true}"

emit() {
  {
    echo "mode=$1"
    echo "policy=$2"
    echo "trust=$3"
  } >> "$output"
}

if [ "$configured" != "true" ]; then
  if [ "$dry_run" != "true" ]; then
    echo "::notice::SIGNPATH_API_TOKEN is not configured; this release ships unsigned Windows binaries."
  else
    echo "SignPath is not configured for this run; Windows binaries stay unsigned."
  fi
  emit skip "" ""
  exit 0
fi

missing=""
[ -n "${SIGNPATH_ORGANIZATION_ID:-}" ] || missing="$missing SIGNPATH_ORGANIZATION_ID"
[ -n "${SIGNPATH_PROJECT_SLUG:-}" ] || missing="$missing SIGNPATH_PROJECT_SLUG"
[ -n "$policy" ] || missing="$missing SIGNPATH_SIGNING_POLICY_SLUG"
if [ -n "$missing" ]; then
  echo "::warning::SIGNPATH_API_TOKEN is set but repository variables are missing:$missing. Windows binaries stay unsigned."
  emit skip "" ""
  exit 0
fi

# The slug reaches a GitHub Actions output and a SignPath API call; anything that is not a plain
# slug could forge a second output line, so it is refused rather than passed through.
case "$policy" in
  *[!a-z0-9-]*)
    echo "::warning::SIGNPATH_SIGNING_POLICY_SLUG is not a lowercase slug. Windows binaries stay unsigned."
    emit skip "" ""
    exit 0
    ;;
esac

if [ "$policy" = "release-signing" ]; then
  echo "Signing Windows binaries with the release-signing policy."
  echo "Each signing request waits for manual approval in app.signpath.io."
  emit sign "$policy" release
  exit 0
fi

if [ "$dry_run" = "true" ]; then
  echo "Signing Windows binaries with the $policy policy for this dry run."
  emit sign "$policy" test
  exit 0
fi

echo "::notice::SIGNPATH_SIGNING_POLICY_SLUG is '$policy', not release-signing. A test certificate never ships, so this release's Windows binaries stay unsigned."
emit skip "" ""

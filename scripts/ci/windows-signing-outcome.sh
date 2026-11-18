#!/usr/bin/env bash
# Record whether this Windows release leg's file ended up Authenticode-signed (#7207).
#
# Usage: windows-signing-outcome.sh <standalone|desktop> <output-directory> [packaged-file]
#
# Inputs (environment):
#   SIGNING_MODE    steps.windows-signing.outputs.mode (scripts/ci/windows-signing-plan.sh): sign or skip
#   SIGNING_TRUST   steps.windows-signing.outputs.trust: release or test
#   SIGNED          the swap step's signed output (scripts/ci/apply-signed-windows-artifact.ps1): true only
#                   after the verified signed file was swapped in
#   GITHUB_RUN_ATTEMPT  the attempt that wrote the record
#
# Writes <output-directory>/<kind>.json, which the publish job reads into the release body's code
# signing section (scripts/release-signing-footer.ts). Only a release-trust plan whose swap succeeded
# records signed: a skipped plan, a test certificate, a failed or never-run swap all record false.
# The record carries the sha256 of the packaged file this leg publishes (the standalone zip or the MSI),
# and the publish job trusts it only for an asset with that digest, so a record an earlier attempt left
# behind never speaks for a re-run's files (#8780 review). Without a packaged file the record has no
# digest, never records signed, and reads as "not recorded".
set -euo pipefail

kind="${1:-}"
dir="${2:-}"
packaged="${3:-}"
case "$kind" in
  standalone|desktop) ;;
  *)
    echo "::error::windows-signing-outcome.sh: unknown kind '$kind' (expected standalone or desktop)"
    exit 2
    ;;
esac
if [ -z "$dir" ]; then
  echo "::error::windows-signing-outcome.sh: missing output directory"
  exit 2
fi

signed=false
if [ "${SIGNING_MODE:-}" = "sign" ] && [ "${SIGNING_TRUST:-}" = "release" ] && [ "${SIGNED:-}" = "true" ]; then
  signed=true
fi

sha256=null
if [ -n "$packaged" ]; then
  if [ -f "$packaged" ]; then
    # Hash stdin in binary mode, so the output never escapes a file name and Windows never translates line endings.
    if command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum -b < "$packaged")" || digest=""
    else digest="$(shasum -a 256 -b < "$packaged")" || digest=""
    fi
    digest="${digest%% *}"
    if [[ "$digest" =~ ^[0-9a-f]{64}$ ]]; then sha256="\"$digest\""; fi
  fi
  if [ "$sha256" = null ]; then
    echo "::warning::windows-signing-outcome.sh: cannot hash the packaged $kind file; its signing outcome reads as not recorded"
  fi
fi
if [ "$sha256" = null ]; then signed=false; fi

attempt=null
if [[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]]; then attempt="\"$GITHUB_RUN_ATTEMPT\""; fi

mkdir -p "$dir"
printf '{"schema":"ocx.windows-signing-outcome/2","kind":"%s","signed":%s,"sha256":%s,"attempt":%s}\n' \
  "$kind" "$signed" "$sha256" "$attempt" > "$dir/$kind.json"
echo "Windows $kind signing outcome: signed=$signed sha256=$sha256 attempt=$attempt"

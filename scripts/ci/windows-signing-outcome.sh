#!/usr/bin/env bash
# Record whether this Windows release leg's file ended up Authenticode-signed (#7207).
#
# Usage: windows-signing-outcome.sh <standalone|desktop> <output-directory>
#
# Inputs (environment):
#   SIGNING_MODE    steps.windows-signing.outputs.mode (scripts/ci/windows-signing-plan.sh): sign or skip
#   SIGNING_TRUST   steps.windows-signing.outputs.trust: release or test
#   SIGNED          the swap step's signed output (scripts/ci/apply-signed-windows-artifact.ps1): true only
#                   after the verified signed file was swapped in
#
# Writes <output-directory>/<kind>.json, which the publish job reads into the release body's code
# signing section (scripts/release-signing-footer.ts). Only a release-trust plan whose swap succeeded
# records signed: a skipped plan, a test certificate, a failed or never-run swap all record false.
set -euo pipefail

kind="${1:-}"
dir="${2:-}"
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

mkdir -p "$dir"
printf '{"schema":"ocx.windows-signing-outcome/1","kind":"%s","signed":%s}\n' "$kind" "$signed" > "$dir/$kind.json"
echo "Windows $kind signing outcome: signed=$signed"

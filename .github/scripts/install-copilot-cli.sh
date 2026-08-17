#!/usr/bin/env bash
set -euo pipefail

COPILOT_VERSION="v1.0.74"
COPILOT_ASSET="copilot-linux-x64.tar.gz"
COPILOT_SHA256="4a708b0a1cbaef4c2ca5c546a622f887a3b70e8a0432bc3cee0d386704816650"
COPILOT_URL="https://github.com/github/copilot-cli/releases/download/${COPILOT_VERSION}/${COPILOT_ASSET}"

install_root="${RUNNER_TEMP:?RUNNER_TEMP is required}/copilot-cli-${COPILOT_VERSION}"
archive="${install_root}/${COPILOT_ASSET}"
bin_dir="${install_root}/bin"

rm -rf -- "$install_root"
mkdir -p "$bin_dir"

curl \
  --proto '=https' \
  --tlsv1.2 \
  --fail \
  --silent \
  --show-error \
  --location \
  --retry 3 \
  "$COPILOT_URL" \
  --output "$archive"

printf '%s  %s\n' "$COPILOT_SHA256" "$archive" | sha256sum --check --status

tar -xzf "$archive" -C "$bin_dir"
chmod +x "$bin_dir/copilot"
"$bin_dir/copilot" --version

printf '%s\n' "$bin_dir" >> "${GITHUB_PATH:?GITHUB_PATH is required}"

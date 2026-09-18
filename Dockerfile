# syntax=docker/dockerfile:1

# Keep the runtime aligned with package.json and pin the multi-platform image index.
ARG BUN_IMAGE=oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6

FROM ${BUN_IMAGE} AS manifest
WORKDIR /home/bun/app

# The pinned Bun image does not include Git. Keep it confined to this build-only stage.
RUN apt-get update -qq \
  && apt-get install -qq --no-install-recommends git \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/generate-compatibility-version.ts /tmp/generate-compatibility-version.ts
COPY docker/verify-compatibility.ts /tmp/verify-compatibility.ts

# Inspect the read-only context before COPY can dereference a source symlink, and produce the
# canonical manifest for the later stages. Two supported inputs, in order:
#
#   1. A manifest the host already generated. This is the pre-existing workflow and it still
#      wins, verified rather than silently replaced, so a prepared checkout keeps building
#      byte-for-byte as before.
#   2. A clean Git context, including a remote one. The generator's canonical file list comes
#      from `git ls-files`, which reads the index and never opens an object or a ref, so the
#      context carries only .git/index and .git/HEAD. Copying them into a scratch GIT_DIR owned
#      by this stage supplies the empty objects/ and refs/ directories Git's repository check
#      requires, keeps the read-only bind mount pristine, and sidesteps the dubious-ownership
#      refusal a context-owned .git would trigger.
#
# Neither input is allowed to be missing: a placeholder manifest would defeat the identity the
# runtime check exists to prove.
RUN --mount=type=bind,target=/build-context set -eu; \
  context_manifest=/build-context/src/generated/compatibility-version.json; \
  generated=/manifest/src/generated/compatibility-version.json; \
  if [ -e "$context_manifest" ] || [ -L "$context_manifest" ]; then \
    bun /tmp/verify-compatibility.ts /build-context; \
    install -D -m 0644 "$context_manifest" "$generated"; \
  elif [ -f /build-context/.git/index ] && [ -f /build-context/.git/HEAD ]; then \
    mkdir -p /gitdir/objects /gitdir/refs; \
    cp /build-context/.git/index /build-context/.git/HEAD /gitdir/; \
    GIT_DIR=/gitdir GIT_WORK_TREE=/build-context \
      bun /tmp/generate-compatibility-version.ts /build-context "$generated"; \
    bun /tmp/verify-compatibility.ts /build-context "$generated"; \
  else \
    echo "No compatibility manifest and no Git index in the build context." >&2; \
    echo "Build from a Git context (add BUILDKIT_CONTEXT_KEEP_GIT_DIR=1 for a remote one)," >&2; \
    echo "or run: bun scripts/generate-compatibility-version.ts" >&2; \
    exit 1; \
  fi

FROM ${BUN_IMAGE} AS build
WORKDIR /home/bun/app

COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY --chown=bun:bun gui/package.json gui/bun.lock ./gui/
RUN cd gui && bun install --frozen-lockfile

COPY --chown=bun:bun src ./src
COPY --from=manifest --chown=bun:bun /manifest/src/generated/compatibility-version.json ./src/generated/compatibility-version.json
COPY --chown=bun:bun scripts/model-metadata.source.json ./scripts/model-metadata.source.json
COPY --chown=bun:bun docker ./docker
COPY --chown=bun:bun gui ./gui
RUN cd gui && bun run build

FROM ${BUN_IMAGE} AS runtime
WORKDIR /home/bun/app

# Docker supervises this foreground process; retain routed state on stop/recreate.
# This uses the existing service lifecycle mode and does not install a service manager.
ENV NODE_ENV=production \
    OCX_SERVICE=1 \
    OPENCODEX_HOME=/home/bun/.opencodex \
    CODEX_HOME=/home/bun/.codex \
    OCX_API_TOKEN_FILE=/home/bun/.opencodex/service-api-token

# These homes have incompatible auth.json formats; persist them without combining them.
RUN install -d -m 0700 -o bun -g bun /home/bun/.opencodex /home/bun/.codex
COPY --chown=bun:bun --chmod=0600 docker/config.json /home/bun/.opencodex/config.json

COPY --from=build --chown=bun:bun /home/bun/app/package.json ./package.json
COPY --from=build --chown=bun:bun /home/bun/app/bun.lock ./bun.lock
COPY --from=build --chown=bun:bun /home/bun/app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /home/bun/app/src ./src
COPY --from=build --chown=bun:bun /home/bun/app/scripts/model-metadata.source.json ./scripts/model-metadata.source.json
COPY --from=build --chown=bun:bun /home/bun/app/docker ./docker
COPY --from=build --chown=bun:bun /home/bun/app/gui/dist ./gui/dist

USER bun
RUN ["bun", "docker/verify-compatibility.ts"]
RUN ["bun", "-e", "import { readOpenCodexCompatibilityVersion } from './src/routing/compatibility/version.ts'; if (!/^[0-9a-f]{64}$/.test(readOpenCodexCompatibilityVersion() ?? '')) throw new Error('Missing or invalid generated compatibility manifest');"]
VOLUME ["/home/bun/.opencodex", "/home/bun/.codex"]
EXPOSE 10100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:10100/healthz');if(!r.ok)process.exit(1)"]

CMD ["bun", "run", "src/cli/index.ts", "start", "--port", "10100"]

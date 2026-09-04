# syntax=docker/dockerfile:1

# Keep the runtime aligned with package.json and pin the multi-platform image index.
ARG BUN_IMAGE=oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6

FROM ${BUN_IMAGE} AS build
WORKDIR /home/bun/app

COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY --chown=bun:bun gui/package.json gui/bun.lock ./gui/
RUN cd gui && bun install --frozen-lockfile

COPY --chown=bun:bun src ./src
COPY --chown=bun:bun docker ./docker
COPY --chown=bun:bun gui ./gui
RUN cd gui && bun run build

FROM ${BUN_IMAGE} AS runtime
WORKDIR /home/bun/app

ENV NODE_ENV=production \
    OPENCODEX_HOME=/home/bun/.opencodex \
    OCX_API_TOKEN_FILE=/home/bun/.opencodex/service-api-token

RUN install -d -m 0700 -o bun -g bun /home/bun/.opencodex
COPY --chown=bun:bun --chmod=0600 docker/config.json /home/bun/.opencodex/config.json

COPY --from=build --chown=bun:bun /home/bun/app/package.json ./package.json
COPY --from=build --chown=bun:bun /home/bun/app/bun.lock ./bun.lock
COPY --from=build --chown=bun:bun /home/bun/app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /home/bun/app/src ./src
COPY --from=build --chown=bun:bun /home/bun/app/docker ./docker
COPY --from=build --chown=bun:bun /home/bun/app/gui/dist ./gui/dist

USER bun
VOLUME ["/home/bun/.opencodex"]
EXPOSE 10100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:10100/healthz');if(!r.ok)process.exit(1)"]

CMD ["bun", "run", "src/cli/index.ts", "start", "--port", "10100"]

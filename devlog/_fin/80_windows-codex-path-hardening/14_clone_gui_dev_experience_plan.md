# 80.14 — Clone / GUI Development Experience Plan

## Problem

A user followed:

```sh
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev
```

Then opened `localhost:10100` and expected the GUI. They saw `Unknown endpoint: GET /`, while the server banner claimed:

```text
GET / -> GUI dashboard
```

At current dev, `/` should return a fallback payload when `gui/dist` is missing, but the confusion is still valid:

- root `bun run dev` starts the proxy backend only;
- GUI development uses `cd gui && bun run dev`;
- serving GUI from the proxy requires `bun run build:gui` first;
- startup banner always says GUI dashboard even if assets are not built;
- `gui/README.md` is still generic Vite template text.

## Patch intent

Make clone behavior self-explanatory without breaking existing workflows.

## Proposed implementation

### 1. README split

Update README.md and README.ko.md development section:

- Backend/proxy only:
  - `bun run dev`
  - open `/healthz`, not `/`, to check proxy health.
- Built dashboard through proxy:
  - `bun run build:gui`
  - `bun run dev`
  - open `http://localhost:10100/`.
- Live GUI development:
  - terminal 1: `bun run dev`
  - terminal 2: `cd gui && bun install && bun run dev`
  - open Vite URL, usually `http://localhost:5173/`.
- Installed user path:
  - `ocx gui`.

### 2. Root scripts

Add non-breaking aliases:

- keep `dev` as backend proxy for compatibility;
- add `dev:proxy` as explicit alias;
- add `dev:gui` to run the Vite GUI dev server;
- optionally add `dev:dashboard` or document `build:gui` + `dev`.

### 3. Runtime banner/fallback

Make startup log conditional:

- if GUI assets are available: `GET / -> GUI dashboard`;
- otherwise: `GET / -> setup/help fallback (run bun run build:gui or cd gui && bun run dev)`.

Expand `rootFallbackPayload()` with exact clone commands.

### 4. GUI README

Replace generic Vite template with OpenCodex-specific GUI dev notes.

## Tests

- Root fallback test asserts exact guidance fields:
  - backend dev;
  - built dashboard;
  - Vite GUI dev;
  - installed `ocx gui` path.
- Banner helper test if banner logic is extracted.
- Existing server auth/root fallback test remains green.

## Classification

This is not the primary Windows spontaneous-stop fix. It is low-risk dev-experience work and should ship with the hotfix if possible because it reduces false bug reports and makes clone testing reproducible.

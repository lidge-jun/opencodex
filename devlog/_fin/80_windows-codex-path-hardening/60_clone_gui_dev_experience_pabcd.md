# 80.60 — Clone GUI Development Experience PABCD

## Purpose

Fix the user confusion where `git clone`, `bun install`, `bun run dev`, then opening `/` shows `Unknown endpoint: GET /` even though README text implies a GUI dashboard.

## Source Evidence

- `devlog/80_windows-codex-path-hardening/14_clone_gui_dev_experience_plan.md`
- `devlog/80_windows-codex-path-hardening/15_final_gpt_pro_plan.md`
- User report: clone workflow expected GUI at `http://localhost:10100/`, but backend-only dev server returned not_found.

## PABCD Work Unit

This is docs/dev-experience. It can ship with the Windows hotfix, but it must not be described as fixing proxy stopping.

### P — Plan

Scope:

- MODIFY `package.json` scripts
- MODIFY `README.md`, `README.ko.md`, `README.zh-CN.md` if all public docs need parity
- MODIFY `gui/README.md`
- MODIFY `src/server.ts` banner/root fallback payload if needed
- ADD or MODIFY tests for root fallback and banner helper

Non-goals:

- Do not merge Vite dev server into the backend process unless explicitly planned later.
- Do not change provider routing.
- Do not claim backend-only `bun run dev` serves live GUI.

### A — Audit

Ask a read-only auditor to verify:

- Current root scripts match documented commands.
- GUI build output path is the same path served by backend.
- Fallback JSON can give exact clone instructions without lying about live GUI.
- README translations stay consistent.

### B — Build

Implementation checklist:

- Keep `bun run dev` as backend proxy if that is the project convention.
- Add explicit aliases:
  - `dev:proxy` for backend proxy;
  - `dev:gui` for Vite GUI dev;
  - keep `build:gui` for bundled dashboard.
- Document three modes:
  - backend-only health check: `/healthz`;
  - built dashboard: `bun run build:gui` then backend `/`;
  - live GUI dev: run backend and Vite GUI separately.
- Make startup banner conditional:
  - GUI built: `GET / -> GUI dashboard`;
  - GUI missing: show setup/fallback guidance.
- Expand `rootFallbackPayload()` with exact clone commands.
- Replace generic `gui/README.md` with OpenCodex-specific instructions.

Suggested commit:

```bash
git add package.json README.md README.ko.md README.zh-CN.md gui/README.md src/server.ts tests && git commit -m "docs(gui): clarify clone development workflow"
```

### C — Check

Required commands:

```bash
bun test tests/server-root.test.ts tests/cli-help.test.ts
bun x tsc --noEmit
```

Manual smoke:

```bash
bun install
bun run dev
curl http://localhost:10100/healthz
curl http://localhost:10100/
bun run build:gui
bun run dev
open http://localhost:10100/
```

### D — Done Criteria

- Clone workflow docs no longer imply backend-only dev serves live GUI.
- `/` without `gui/dist` returns setup JSON instead of opaque `Unknown endpoint`.
- Banner text matches actual GUI availability.
- README and scripts agree.

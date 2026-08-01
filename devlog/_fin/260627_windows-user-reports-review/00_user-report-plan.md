# Windows User Reports Review Plan

## Context

`origin/dev` now includes commit `929d756 fix(windows): stop proxy before service cleanup`, which addresses the GPT Pro finding that Windows Task Scheduler stop/uninstall can leave the proxy/Bun child alive.

After pushing `dev`, two new community reports need review before patching further.

## Report A: Windows proxy keeps stopping frequently

Korean user report summary:

- "검토프록시 나만 그런건가 어떤 pc에서 해도 쓰다가 자꾸 중단됨. 매우 빈번함"
- Reply asked "윈도우?" and reporter answered "예스 윈도우".
- Maintainer reply promised a Windows patch.

Potential relationship to current fix:

- The just-pushed lifecycle patch prevents stale processes after explicit `ocx service stop` / `ocx service uninstall`.
- It may not explain spontaneous runtime stops while using the proxy.
- Suspect areas to review:
  - Windows Task Scheduler `.cmd` loop only restarts on non-zero exit; clean exits may end the loop.
  - `ocx start` shutdown handlers restore native Codex when not `OCX_SERVICE`, but service/shim paths set `OCX_SERVICE=1`; verify Windows scheduled task and shim paths consistently set it.
  - PID identity/readPid behavior on Windows may remove pid when command-line inspection is unavailable or transient.
  - Bun/Windows signal/process tree behavior may differ from macOS/Linux.
  - Service log path and user-visible diagnostics may be insufficient for Windows incident reports.

## Report B: clone + `bun run dev` shows `Unknown endpoint: GET /`

Korean user report summary:

```text
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev

Then open localhost:10100 and see:
{"error":{"message":"Unknown endpoint: GET /","type":"not_found","code":"not_found"}}

But console says:
GET / -> GUI dashboard
```

Observed repo facts:

- Root `package.json` has `"dev": "bun run src/cli.ts start"`, so root `bun run dev` starts only the proxy backend.
- README Development section says `bun run dev # start the proxy in dev mode`; it does not say this will build/run the GUI.
- `gui/package.json` has its own `dev` and `build` scripts.
- `src/server.ts` logs `GET / -> GUI dashboard` unconditionally, even if GUI assets are absent.
- `src/server.ts` has `rootFallbackPayload()` and `tests/server-auth.test.ts` covers fallback, but the report saw `Unknown endpoint: GET /`, suggesting either an older published/dev state, a path/build resolution mismatch, or root fallback not reached in that environment.

Candidate fixes to consider:

1. Documentation: make clone development explicit:
   - Backend/proxy only: `bun run dev`, then test `/healthz` or connect Codex.
   - GUI development: terminal 1 `bun run dev`; terminal 2 `cd gui && bun install && bun run dev`, open Vite URL, or build with `bun run build:gui` then `bun run dev`.
   - For installed users: `ocx gui`.
2. Server log: only print `GET / -> GUI dashboard` when bundled GUI assets are available; otherwise print `GET / -> setup/help fallback`.
3. Root fallback UX: if GUI is unavailable, return a human-readable JSON or minimal HTML with exact commands instead of generic `Unknown endpoint`.
4. Script ergonomics: add a root script such as `dev:gui`, `dev:all`, or `build:gui` guidance in README so clone users do not infer `bun run dev` serves the dashboard.
5. Test coverage: add tests that root fallback explains missing GUI and server banner does not overpromise.

## Review request

Ask GPT Pro to review `origin/dev` at commit `929d756`, the above community reports, and the relevant source/docs paths, then recommend the smallest patch plan for:

- Windows frequent stop/disconnect diagnosis and likely fixes.
- Clone/dev GUI documentation and runtime fallback improvements.
- Which fixes should be release-blocking versus docs-only.

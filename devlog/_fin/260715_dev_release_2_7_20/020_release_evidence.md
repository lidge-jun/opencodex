# 2.7.20 release evidence

## Integrated candidate

- Preserved local cross-platform commits and maintainer GUI history in merge commit `868cce0d`.
- Corrected the design-system primitive map in `c0487052`.
- Repaired the Windows-only POSIX test fixture without changing production behavior or weakening assertions in `d7dc6ecd`.
- Candidate full local gate: 2,546 tests passed, 0 failed; TypeScript and privacy scan passed.
- Candidate Cross-platform CI on `dev`: `https://github.com/lidge-jun/opencodex/actions/runs/29421424676` — success, including Windows full suite and npm-global install.
- Promoted-candidate Cross-platform CI on `main`: `https://github.com/lidge-jun/opencodex/actions/runs/29421780932` — success.
- Promoted-candidate Cross-platform CI on `preview`: `https://github.com/lidge-jun/opencodex/actions/runs/29422144769` — success.

## GUI verification

- GUI lint and production build passed; the two React Compiler/TanStack Virtual warnings in Debug and Logs remained warnings, not errors.
- Browser console errors/warnings: none.
- Dashboard had no horizontal overflow at 1440, 1024, 768, 390, or 320 CSS px.
- Checked dashboard, providers/add-provider, models, logs, usage, light/dark themes, mobile drawer, reduced motion, and a visible focus outline.
- Screenshot evidence is stored beside this file as `dashboard-*.png`, `providers-1440.png`, `add-provider-modal-1440.png`, `models-1440.png`, `logs-1440.png`, `usage-*.png`, and `focus-dashboard-next.png`.

## Release

- Release commit: `ee5f6ad2245f1b044a519a341747c8c1d78781b7` (`release: v2.7.20`).
- Release-commit Cross-platform CI: `https://github.com/lidge-jun/opencodex/actions/runs/29422617075` — success.
- OIDC Release workflow: `https://github.com/lidge-jun/opencodex/actions/runs/29422979926` — success; publish, registry smoke, and GitHub Release creation all passed.
- npm: `@bitkyc08/opencodex@2.7.20`; `latest=2.7.20`.
- npm shasum: `90ffe369130589fdd97ebd61126ed67f5e06c1e1`.
- npm integrity: `sha512-tgjJQe7qOg7kfUkJrQCZBuKIJiNNoiYhA0hVExP+uEfbm9adeebP98hMNFT4VeLargdOvoLJ9QUyUUweH5G8Cg==`.
- Git tag `v2.7.20` resolves to the release commit.
- GitHub Release: `https://github.com/lidge-jun/opencodex/releases/tag/v2.7.20`, published, non-draft, non-prerelease, target release commit.
- Fresh temporary-prefix install from public npm succeeded; its packaged `ocx help` exited 0 without relying on a globally installed Bun.

## Final alignment

- `origin/main`, `origin/dev`, `origin/preview`, and `v2.7.20` all resolve to `ee5f6ad2245f1b044a519a341747c8c1d78781b7`.
- Final aligned `dev` Cross-platform CI: `https://github.com/lidge-jun/opencodex/actions/runs/29423131436` — success.
- Final aligned `preview` Cross-platform CI: `https://github.com/lidge-jun/opencodex/actions/runs/29423207507` — success.
- No force-push, tag rewrite, unpublish, or history deletion was used.

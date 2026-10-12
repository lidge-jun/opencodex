# wp3: rebuild the local app and verify with a Claude-routed model

1. In the primary checkout, fast-forward `dev` to the merge commit.
2. Force a fresh standalone sidecar: `bun run build:standalone --target bun-darwin-arm64`.
   `desktop/scripts/prepare-sidecar.ts` reuses `dist/standalone/*/ocx` when it exists, which shipped a
   stale 2.61.0 proxy inside the 2.68.0 app on 2026-09-27.
3. `bun run build:gui`, then in `desktop/`: `bun run prepare-sidecar`, `bun run prepare-widget`, and
   `bun run build:local` with the shared `.git/config` `core.bare` set to `false` only for the build
   (Cargo reads it) and restored afterwards.
4. Extract `OpenCodex.app` from the DMG, verify `codesign --verify --deep --strict`, and check that
   the bundled `ocx` contains `codex-inline-vis`.
5. Protocol check against the packaged sidecar once the user has reinstalled the app: confirm
   `/healthz` reports the rebuilt version and that the running binary is the reinstalled bundle, then send a
   Claude-routed request whose input carries the private-use reference and confirm the reply contains
   `::codex-inline-vis{path="…"}` and no private-use character.
6. Render check in the Codex App: in this Claude-routed thread, write a real HTML fragment under the
   thread's visualization directory and put `::codex-inline-vis{path="…"}` on its own line in a
   **final answer** (a commentary block can be recorded as a reasoning summary, which the app does not
   render as markdown directives; observed 2026-09-27). The user reports whether it renders.
   Computer Use cannot inspect `com.openai.codex` (blocked by its safety policy), so rendering stays
   "pending user confirmation" until that report.

Shared `.git/config` note: Cargo (libgit2) ignores `config.worktree`, so the build flips `core.bare` for
the shortest possible window and restores it; do not run it while another task is using the checkout's
git config.

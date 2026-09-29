# ADR-6139 — decision recorded under "Packaged native keyring binding"

- Contract owner: [desktop-shell.md](../desktop-shell.md#packaged-native-keyring-binding)

## Decision record

- 목적과 의도: Keep provider and native-profile keychain operations available in compiled standalone and desktop `ocx` binaries, independent of the process working directory.
- 기존 구현 및 제약 조건: Source/npm installs resolve `@napi-rs/keyring` from `node_modules`, but Bun's compiled virtual filesystem cannot materialize its N-API `.node` file. The desktop ships one universal macOS sidecar, Tauri resources are outside that executable, and native bindings must match the executing architecture exactly.
- 검토한 주요 대안: Rely on dynamic package resolution from `$bunfs`; copy the JavaScript wrapper and its package tree; fetch an addon on first use; put an environment-selected arbitrary path into the loader; or stage pinned target addons as release resources and load one deterministic path.
- 선택한 방식: Stage the lockfile-selected platform addon beside every standalone build, copy it into the desktop resource set, carry both Darwin slices in a universal app, and let one shared loader choose a fixed platform/architecture filename from the canonical compiled-executable root before falling back to package resolution for non-compiled installs.
- 다른 대안 대신 이 방식을 선택한 이유: A native file must exist outside `$bunfs`; shipping only that file is smaller and easier to verify than recreating package resolution, needs no runtime download, and avoids making cwd or an ambient environment variable a native-code search path.
- 장점, 단점 및 영향: Packaged keychain paths work from arbitrary directories and fail at build time when an expected optional package is missing. Release archives grow by one addon per target and the universal macOS app by two. Linux Tauri bundles use their fixed `usr/bin` to `usr/lib/OpenCodex` resource layout; non-`usr/bin` standalone layouts do not enter that fallback. The packaged probe proves module loading without touching a credential or depending on an OS consent dialog. Adding another target now requires an explicit asset mapping and packaging test.

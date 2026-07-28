# 001 — Survey: PR #387 vs PR #421, and the stack decision

Research document. No diffs here (LEXICO-SPLIT-01); implementation lives in the decade docs.

## 1. PR #387 — `feat: ship packaged macOS menu bar companion` (jaycho46)

**Branch:** `feat/menubar-app` · **Directory:** `apps/macos-menu-bar/` · 16 commits · +1656/-32

Architecture (read from the branch, not from the PR body):

```text
Package.swift            swift-tools-version 5.9, .macOS(.v12)
  OpenCodexMenuBarCore   OcxClient, OcxLocator, StatusModels     (library, tested)
  OpenCodexMenuBar       main.swift, MenuText, StatusBarIcon      (executable)
  Tests                  OpenCodexMenuBarCoreTests
```

**Transport: `ocx` CLI subprocess.** `OcxClient.fetchStatus` locates the `ocx`
executable via `OcxLocator`, runs `ocx status --json`, then brace-slices the stdout
(`output.firstIndex(of: "{")` … `lastIndex(of: "}")`) and decodes it. Write actions run
through `commandPlan(for:status:)`, which emits further `ocx` argument vectors.

To make that transport work, the PR also **extends `src/cli/status.ts`** with
`proxy.health.version` and `proxy.health.uptimeSeconds`, and adds
`tests/cli-status-json.test.ts`.

Packaging (the genuinely strong part):

- `scripts/build-macos-app.sh` — assembles `OpenCodex.app` by hand: `Contents/MacOS`,
  `Contents/Resources`, `Info.plist`, an `.iconset` built from `gui/public/favicon.png`,
  and a refusal guard on unexpected bundle paths.
- `scripts/package-macos-release.sh` — `codesign --verify --deep --strict`,
  `lipo -archs` assertion for both arches, `ditto -c -k --sequesterRsrc --keepParent`,
  archive content assertion (`unzip -Z1` must contain the executable), `shasum -a 256`.
- `.github/workflows/release.yml` — new `package-macos` job on `macos-latest`, artifact
  upload, and Release asset attachment. Also scopes Trusted Publishing OIDC to the
  publish job (commit `fbc9c844`), which is an unrelated but correct hardening.
- `.github/workflows/ci.yml` — `test:macos` and `build:macos` steps gated on
  `runner.os == 'macOS'`.

Review history: no maintainer review. Its own author left 10 self-review comments and
CodeRabbit iterated ~14 rounds; the commit tail (`1454a925` bound CLI runs with a
timeout and concurrent pipe drain, `dcf4fea0` treated stale launchd services as
repairable, `0ebbb6a7` waited for pipe drain before reading buffers) shows real defect
repair, not cosmetic churn.

## 2. PR #421 — `feat(menubar): redesign as macOS status widget` (genglintong)

**Branch:** `feat/menubar-status-widget` · **Directory:** `menubar/` · 5 commits · +14532/-0
**Surveyed at head `049ef2ac`** (re-verified after the Phase-0 audit; an earlier draft of
this document described an older head and was factually wrong — see §2.1).

Architecture:

```text
menubar/src-tauri/     Rust: tray.rs, keychain.rs, discover.rs, api.rs  (~170 lines)
menubar/src/           React 19 + TS: App, sections/{Usage,Health,Status,Setup,Activity}
menubar/scripts/       build-app.sh, check-version.sh
```

**Transport: HTTP management API.** `discover.rs` reads
`~/.opencodex/runtime-port.json`; `api.rs` proxies WebView `invoke("api_request")` calls
through Rust `reqwest`, with the key sourced from the macOS Keychain. Zero proxy-side
changes — it consumes only endpoints that already exist.

The PR body claims the token "never crosses to WebView JS". **That is not what the code
does at head `049ef2ac`** — `menubar/src/api.ts:12-13` receives it directly:

```ts
const discovery = await invoke<{ url: string; token: string | null; found: boolean }>("discover_proxy");
proxyConfig = { url: discovery.url, token: discovery.token };
```

The token is returned to the renderer and cached in module state. The Rust IPC layer is
still a reasonable shape, but the isolation claim does not hold, so this plan does not
credit it and does not repeat it in the closing comment.

Design: four-tab segmented widget (Usage / Health / Status / Activity), Apple-style
white theme, tabular-nums stats, `macOSPrivateApi: true` for a transparent rounded
popover with shadow. The submitted screenshot is the more polished of the two.

Distribution: `menubar/scripts/build-app.sh` runs `cargo tauri build` and produces both
`OpenCodex Menubar.app` and a `.dmg`. **But `.github/` is untouched** — no CI job, no
release job, no artifact attached to any GitHub Release. A user still needs `rustup` plus
a frontend toolchain and must build from source.

### 2.1 Correction: the committed-artifacts defect is FIXED at the current head

An earlier draft of this survey stated that `menubar/src-tauri/target/**` was committed
and that `bun run privacy:scan` fails on the tree. **That was true of the head the Codex
reviewer saw, and the contributor has since fixed it.** Verified directly against
`049ef2ac`:

```text
gh pr view 421 --json files --jq '[.files[].path | select(test("src-tauri/target"))] | length'
  -> 0

gh api repos/genglintong/opencodex/contents/menubar/src-tauri?ref=049ef2ac
  -> .gitignore, Cargo.lock, Cargo.toml, build.rs, capabilities, gen, icons, src, tauri.conf.json
```

Commit `049ef2ac` is titled "fix(menubar): address all Codex review findings (5 P1 + 14
P2)". The contributor responded to review properly and the tree is clean. Any closing
comment must say so; repeating the stale defect would be both wrong and unfair.

## 3. Head-to-head

| Axis | #387 (Swift) | #421 (Tauri) |
| --- | --- | --- |
| Runtime deps to build | Swift toolchain (Xcode CLT) | Rust + Node + Tauri CLI |
| Runtime deps to run | none (native binary) | none (bundled WebView) |
| Bundle size class | ~single-MB native | tens of MB (WebView shell + Rust) |
| Transport | `ocx` CLI subprocess | HTTP management API |
| Requires proxy source change | yes (`src/cli/status.ts`) | no |
| Distribution to users | zip + SHA-256 attached to Release | `.app` + `.dmg`, build from source only |
| CI coverage | macOS test + build steps | none |
| Committed artifacts | none | none (fixed at `049ef2ac`) |
| UI polish (as submitted) | functional menu | higher — segmented tabs, tuned spacing |
| Data breadth | proxy status + control | usage, health, status, activity, quotas |

## 4. Stack decision — Swift + AppKit, transport over HTTP

**Decision: build in Swift (SwiftPM + AppKit), and talk to the proxy over the HTTP
management API.** This is a hybrid: #387's runtime and packaging discipline, #421's
transport and information architecture.

Rationale, in order of weight:

1. **Distribution is the whole point of the user's question.** #421 can build an `.app`
   and a `.dmg` locally, but nothing in the repository builds or publishes one: `.github/`
   is untouched, so no user can download a build. #387 already proves the full path —
   packaged, checksummed, and attached to a GitHub Release.
2. **HTTP beats CLI subprocess for a polling UI.** Spawning `ocx` every refresh cycle
   costs a process launch plus Bun startup per tick, requires the brace-slicing hack to
   survive incidental stdout, and — decisively — needs `src/cli/status.ts` to grow new
   fields. The user put `src/` out of scope. The management API already returns richer
   data (`/api/usage`, `/api/provider-quotas`) with no proxy change at all.
3. **Dependency weight.** Swift + AppKit ships zero third-party dependencies. Tauri adds
   a Rust toolchain, a Cargo lockfile, generated ACL schemas, and a WebView runtime to a
   repository whose entire premise is a single Bun process.
4. **`macOSPrivateApi: true` is a liability.** #421 enables it for rounded corners.
   Private API usage is a documented App Store rejection vector and a notarization risk;
   AppKit's `NSPopover` gives the same visual result through public API.

**What is explicitly NOT part of the rationale** (each was in an earlier draft and each
is now known to be wrong or unfair):

- Not "committed build artifacts" — fixed at `049ef2ac` (§2.1).
- Not "no bundle at all" — `build-app.sh` produces both `.app` and `.dmg`.
- Not "packaging must be rebuilt from scratch" — the gap is repository CI/release
  *attachment*, not the ability to produce a bundle locally.

The rejection of Tauri rests on exactly three facts: no repository CI or release
attachment, a materially heavier build stack for a project whose premise is one Bun
process, and the private-API dependency.

### 4.1 The universal-binary finding (must be honoured by Phase 4)

Probed live on this machine:

```text
swift build --arch arm64 --arch x86_64 -c release
  -> ld: symbol(s) not found for architecture x86_64
swift build --arch arm64 -c release
  -> Build complete! (10.39 sec)
```

Command Line Tools ships only current-architecture Swift compatibility libraries, and
macOS 27 additionally deprecates x86_64 for this deployment target. #387's build script
already detects this and refuses `UNIVERSAL=1` under CLT with a clear message — that
guard is correct and is inherited.

**Consequence for the plan:** local verification is arm64-only and that is expected, not
a failure. The universal assertion belongs in CI, where `macos-latest` runners carry a
full Xcode. Phase 4 must therefore keep `UNIVERSAL` opt-in with the CLT guard, and the
`lipo` both-arch assertion must run in the CI job rather than gating local builds.

### 4.2 What the HTTP transport decision costs, honestly

Choosing HTTP over the CLI is not free. `/api/stop` stops launchd on purpose
(`src/server/management-api.ts:136-147`), and there is no start endpoint — so the app can
stop the proxy but can never start it. PR #387's CLI transport *could* run `ocx start`.

This is accepted rather than worked around: the app ships **Stop proxy**, not Restart, and
shows the start command for the user to run. Spawning processes from a menu bar app to
paper over a missing endpoint is worse than being honest about the capability. See `030`.

## 5. What is salvaged from each PR

From **#387 (jaycho46)** — packaging architecture: manual bundle assembly, the
unexpected-bundle-path refusal guard, `codesign --verify --deep --strict`, `lipo`
assertion, `ditto` archiving with archive-content verification, SHA-256 sidecar, the
`package-macos` release job shape, the CLT/universal guard, and the Gatekeeper
first-launch documentation angle.

From **#421 (genglintong)** — product architecture: HTTP management-API transport,
`runtime-port.json` discovery with a 10100 fallback, Keychain-backed key storage, the
usage / health / status information set, tabular-numeral stat treatment, and skipping auth
entirely when the proxy has no `apiKeys` configured.

Two things from that branch are deliberately NOT carried over: renderer-side token
isolation (§2 shows the token does reach renderer memory at `049ef2ac`, so there is
nothing to adopt), and the per-request activity surface (`002` §3 records why it is
excluded from v1).

The contributor's review-response discipline at `049ef2ac` also directly improved this
plan: the audit that caught this document's own stale claims used that head as evidence.

## 6. Rejected alternatives

- **Merge #387, then re-skin later.** Rejected: it lands the `src/cli/status.ts` change
  the user excluded, and the CLI transport would have to be replaced anyway.
- **Merge #421, then add packaging.** Rejected on the current head's remaining facts:
  the Rust + Node + Tauri toolchain is a large addition to a single-Bun-process project,
  and `macOSPrivateApi: true` keeps a notarization and App-Store-rejection risk that
  `NSPopover` avoids. (The committed-artifact defect is fixed — §2.1 — and is explicitly
  NOT a reason.)
- **Ask the contributors to converge.** Rejected: the user asked for the maintainer
  version now; a two-way contributor negotiation is slower and leaves both PRs open.

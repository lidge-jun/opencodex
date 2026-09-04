# 020 - wp2: the platform-support reference page

One PR. Bases on wp1's head branch (stacked child).
Branch `codex/260904-platform-support-docs`. Evidence: `001`.
Revised after audit rounds 1, 2 and 3.

## Why this phase is now only a docs page

This phase has been cut three times, and the reason is worth recording because it
is the most useful thing this unit learned.

Round 1: the Linux shell-hook port had three defects. Round 2: the same phase,
rewritten, produced six more - it was not a platform guard to delete but a
credential-bearing file lifecycle on a new platform, and it went to `050`.
Round 3 then found that the REPLACEMENT scope was also partly invented:

- The `skip` discriminant would break four exact `toEqual` assertions
  (`tests/claude-shell-hook.test.ts:63,79,107,173`) and, worse, risked
  classifying genuine failures like `no HOME` and `read/write failed` as benign
  skips at `src/cli/index.ts:1244`. That is a correctness regression traded for a
  refactor nobody asked for.
- The GUI "disabled reason" already EXISTS. `gui/src/pages/claude-code-settings.tsx:43-54`
  renders a localized `claude.systemEnvUnsupported` explanation for exactly this
  case, with coverage at `gui/tests/claude-code-autoconnect.test.tsx:64` and copy
  in every locale from `gui/src/i18n/en.ts:2088`. The premise that a non-macOS
  user sees an unexplained disabled control was simply false.

So both halves are dropped. What survives is the piece that was never in dispute
and that criterion c-3 actually asks for: a written, accurate platform-capability
answer.

## The change

NEW `docs-site/src/content/docs/reference/platform-support.md`, a per-platform
capability matrix stating what works where and, when something does not, WHY:

- Proxy, routing, and provider adapters: all three platforms.
- Background service: all three - launchd on macOS, Task Scheduler OR native
  WinSW on Windows, systemd user unit on Linux. The two Windows backends are
  mutually exclusive (`ServiceBackend = "scheduler" | "native"`,
  `src/service.ts:64,324-326`) and holding both states at once is a conflict
  repair refuses (`:417-420`), so the page must say "or", never "with".
- Provider key storage in the OS credential store: all three via
  `@napi-rs/keyring`, WHEN an unlocked OS credential service is available.
  `src/providers/key-store.ts:95-107` fails closed on a locked or headless
  session, and `docs-site/src/content/docs/reference/configuration/providers.md:656-662`
  already states that limitation - this page must not contradict it.
- Claude Code auto-connect by environment injection: macOS only, because it
  writes to the launchd user domain. Linux has no single equivalent
  (`systemctl --user set-environment` reaches only systemd units, `~/.profile`
  only login shells, `~/.bashrc` only interactive non-login shells) and the
  Windows equivalent would move a bearer token into a persistent registry hive.
  Both are tracked in `050`.
- Meta Muse Code credential import: macOS only. Meta ships no native Windows CLI
  (WSL2 is the documented route), and the Linux credential shape has not been
  measured.
- Browser open, Cursor detection, Claude Desktop paths, Kiro credentials: all
  three platforms, already.

MODIFY `docs-site/astro.config.mjs`: the Reference group is manually enumerated
(`:125-153`), so a page absent from it is not discoverable.

The entry form matters. Starlight resolves an internal `slug` per locale as
`<locale>/<slug>` and throws when the localized entry is missing, and this site
ships all seven locales complete - every locale directory carries the same 13
reference pages. An English-only `slug` entry would therefore break the
localized build.

A site-relative `link` does NOT avoid the problem. Starlight treats only
`http://` and `https://` as absolute (`utils/url.ts`), and
`linkFromSidebarLinkItem` (`utils/navigation.ts:121-127`) prefixes anything else
with the active locale - so `"/reference/platform-support"` becomes
`/fr/reference/platform-support`, a route that does not exist. Worse than the
`slug` case: a `link` is not build-validated, so the build gate would pass while
navigation is quietly broken.

Two admissible options, and the PR must pick one explicitly:

1. **Two files (preferred).** Use a genuinely absolute link built from the
   config's own constant: `link: \`\${SITE_URL}/reference/platform-support\``
   (`SITE_URL` is already defined at `astro.config.mjs:7`). `isAbsoluteUrl`
   returns true, so no locale prefix is injected and every locale points at the
   canonical English page.
2. **Eight files.** Keep `slug: "reference/platform-support"` and add the page
   for all seven locales - each locale directory already carries the same 13
   reference pages, so a missing one is a real gap.

Option 1 ships first. Option 2 is a larger PR, not a tweak.

## What this phase does NOT touch

No runtime source. No GUI. No test behavior. The three shell-hook functions keep
their darwin gate, their reason strings, and their exact return shapes, so every
existing assertion stays green by construction.

## Acceptance

- `bun install --frozen-lockfile` then `bun run build` in `docs-site/` succeeds
  (`docs-site/AGENTS.md:20-30`).
- The sidebar href is verified BY HAND for one non-English locale. The build does
  not validate manual `link` entries, so "the build passed" is not evidence for
  this specific risk.
- The page is reachable from the Reference sidebar.
- No claim contradicts `providers.md:656-662` on keyring availability.
- No source file outside `docs-site/` is modified.
- CI green.

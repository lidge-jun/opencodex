# Evidence — wp1 check

Commits: c6819b6fc0 (landing focus), 75f8ca77d7 (single-card reserve). Build and checks ran at 75f8ca77d7 against `astro preview` on :4329 serving docs-site/dist.

## Activation matrix (CDP Emulation.setUserAgentOverride with UA metadata, touch emulation for iPad)

| Case | grid cards | disclosure cards | details hidden | hero label |
|---|---|---|---|---|
| windows (UA-CH platform Windows) | windows | macos, linux | false | Download for Windows |
| linux x86 (architecture x86) | linux | macos, windows | false | Download for Linux |
| linux arm (architecture arm) | macos, windows, linux | — | true | Download |
| iPad desktop mode (Mac UA, maxTouchPoints 5) | macos, windows, linux | — | true | Download |
| macos | macos | windows, linux | false | Download for macOS |
| Android (Chrome --user-agent, --dump-dom) | macos, windows, linux | — | true | Download |
| no JavaScript (curl) | macos, windows, linux | — | true (hidden) | Download |

Every case: 0 occurrences of "SHA-256"; pill text "Desktop beta"; with JS the dmg href resolves to releases/download/v2.63.0/OpenCodex-2.63.0-macos.dmg, without JS it stays releases/latest.

Test-method note: `--user-agent` alone does not change `navigator.userAgentData.platform`, so a Windows UA run first detected macOS; the CDP run with UA metadata is the real Windows evidence.

## Render observation (headless Chrome, agbrowse CDP 9333)

- 1440 light: one-line "Desktop beta" pill; macOS card alone (28rem) with the recommended badge; "Other platforms" summary; no empty reserve under the button after 75f8ca77d7.
- Disclosure open: Windows and Linux in two columns with outline buttons, Linux keeps ".deb package".
- 1440 dark: same layout, contrast holds.
- 320px pills (ko ru fr tr ja zh-tw): single line, no overflow.
- 390px ko: download section breaks Korean between words.
- Screenshots: /Users/jun/.browser-agent/screenshots/screenshot_1790139667580.png, /Users/jun/.browser-agent/screenshots/screenshot_1790139697444.png, /Users/jun/.browser-agent/screenshots/screenshot_1790139672949.png, /Users/jun/.browser-agent/screenshots/screenshot_1790139700162.png, /Users/jun/.browser-agent/screenshots/screenshot_1790139705932.png, /Users/jun/.browser-agent/screenshots/screenshot_1790139720186.png (uploaded to pr-assets for the PR body).

## Gates

- `cd docs-site && bun run build` → exit 0, 497 pages, internal links 65,499 checked.
- `rg 'App de bureau bêta|Autres plateformes' docs-site/dist/fr/index.html` → 2 matching lines; the old fr pill text and "SHA-256" → 0 in dist/fr and dist/index.
- cxc receipt test → `bun test` 5 files: 94 pass, 0 fail (receipt .codexclaw/evidence/01a0cc7c-73a3-7582-ad6d-17d34211ba09/test-receipt.json).
- `bun run privacy:scan` → passed; `git diff --check` clean.
- SoT: structure/ops/docs-and-release.md (docs-site owner) does not describe the landing download surface; no patch needed.
- Unobserved: none of the planned conditional paths remain unobserved (the iPad and Linux-arch rows were exercised through CDP emulation).


## Follow-up: centred layout (user steering during C)

- custom.css: `.lp-download` centres its heading, subtitle, version line, the single detected card (`justify-content: center`), the Other platforms summary, the disclosure grid (`margin-inline: auto`) and the terminal row; card copy stays left-aligned (`.lp-dl-card { text-align: start }`).
- Rebuilt (exit 0) and re-observed at 1440 light (closed and open), 1440 dark, and 390px ko with the disclosure open: every block centred, no overlap.

